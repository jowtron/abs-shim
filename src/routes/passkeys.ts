import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth, type AuthVars } from '../auth/middleware';
import { issueAccessToken, issueRefreshToken } from '../auth/tokens';
import { insertRefreshToken } from '../db/refresh';
import { sessionCookie } from '../auth/cookie';
import { findUserById, touchLastSeen } from '../db/users';
import {
  CHALLENGE_EXPIRY_MS, bytesToBase64Url, base64UrlToBytes, rpIdFor, isOriginTrusted,
  decodeCBOR, parseAttestationAuthData, verifyAssertion, signCountOf, labelFromUserAgent, rpIdHashMatches,
} from '../auth/webauthn';

// Passkeys for shim accounts (migration 0009). Mounted at /api/auth/passkey.
//
//   POST register-options      (auth)   → PublicKeyCredentialCreationOptions
//   POST register              (auth)   → stores the credential for the caller
//   POST authenticate-options  (public) → PublicKeyCredentialRequestOptions
//   POST authenticate          (public) → same token + cookie as /login
//   GET  list                  (auth)   → the caller's passkeys
//   DELETE :id                 (auth)   → remove one of the caller's passkeys
//
// Registration is only offered to a signed-in user (a passkey is a second
// way into an existing account, never a way to create one), and discoverable
// credentials mean sign-in needs no username: the browser offers the
// passkeys it holds for this hostname and the credential id tells us who.

export const passkeyRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();

const RP_NAME = 'ABS_shim';

// The RP ID is OUR hostname (from the request URL, never the Origin header —
// a header anyone can set), and every authData is checked against its hash.
const rpIdOf = (url: string) => rpIdFor(new URL(url).origin);

async function newChallenge(env: Env, type: 'register' | 'authenticate', userId: string | null): Promise<string> {
  const challenge = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM webauthn_challenges WHERE expires_at < ?').bind(Date.now()),
    env.DB.prepare('INSERT INTO webauthn_challenges (id, challenge, user_id, type, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), challenge, userId, type, Date.now() + CHALLENGE_EXPIRY_MS),
  ]);
  return challenge;
}

type ClientData = { type: string; challenge: string; origin: string };

function readClientData(b64: string): { bytes: Uint8Array; data: ClientData } {
  const bytes = base64UrlToBytes(b64);
  return { bytes, data: JSON.parse(new TextDecoder().decode(bytes)) as ClientData };
}

passkeyRoutes.post('/register-options', requireAuth, async (c) => {
  const userId = c.get('userId');
  const user = c.get('user');
  const existing = await c.env.DB.prepare('SELECT id FROM webauthn_credentials WHERE user_id = ?').bind(userId).all<{ id: string }>();
  const challenge = await newChallenge(c.env, 'register', userId);
  return c.json({
    challenge,
    rp: { name: RP_NAME, id: rpIdOf(c.req.url) },
    user: {
      id: bytesToBase64Url(new TextEncoder().encode(userId)),
      name: user.username,
      displayName: user.username,
    },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'required' },
    excludeCredentials: existing.results.map((r) => ({ id: r.id, type: 'public-key', transports: ['internal'] })),
    timeout: 60000,
    attestation: 'none',
  });
});

passkeyRoutes.post('/register', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null) as { id?: string; label?: string; response?: { clientDataJSON?: string; attestationObject?: string } } | null;
  if (!body?.response?.clientDataJSON || !body.response.attestationObject) return c.json({ error: 'Invalid body' }, 400);
  const { data: clientData } = readClientData(body.response.clientDataJSON);
  if (clientData.type !== 'webauthn.create') return c.json({ error: 'Wrong ceremony type' }, 400);
  const ch = await c.env.DB.prepare(
    "SELECT id, user_id FROM webauthn_challenges WHERE challenge = ? AND type = 'register' AND expires_at > ?",
  ).bind(clientData.challenge, Date.now()).first<{ id: string; user_id: string }>();
  if (!ch || ch.user_id !== c.get('userId')) return c.json({ error: 'Invalid or expired challenge' }, 400);
  const rpId = rpIdOf(c.req.url);
  if (!isOriginTrusted(clientData.origin, rpId)) return c.json({ error: 'Origin mismatch' }, 400);
  let credentialId: Uint8Array;
  let publicKeyCOSE: Uint8Array;
  try {
    const att = decodeCBOR(base64UrlToBytes(body.response.attestationObject)) as { authData?: unknown };
    if (!(att.authData instanceof Uint8Array)) throw new Error('no authData');
    if (!(await rpIdHashMatches(att.authData, rpId))) throw new Error('RP ID mismatch');
    ({ credentialId, publicKeyCOSE } = parseAttestationAuthData(att.authData));
  } catch (e) {
    return c.json({ error: `Attestation parse failed: ${(e as Error).message}` }, 400);
  }
  const label = (body.label ?? '').trim().slice(0, 60) || labelFromUserAgent(c.req.header('user-agent') ?? '');
  try {
    await c.env.DB.prepare(
      'INSERT INTO webauthn_credentials (id, user_id, public_key, sign_count, transports, label, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)',
    ).bind(bytesToBase64Url(credentialId), ch.user_id, bytesToBase64Url(publicKeyCOSE), JSON.stringify(['internal']), label, Date.now()).run();
  } catch (e) {
    if (!/UNIQUE/i.test((e as Error).message)) return c.json({ error: (e as Error).message }, 500);
  }
  await c.env.DB.prepare('DELETE FROM webauthn_challenges WHERE id = ?').bind(ch.id).run();
  return c.json({ ok: true, id: bytesToBase64Url(credentialId), label });
});

passkeyRoutes.post('/authenticate-options', async (c) => {
  const challenge = await newChallenge(c.env, 'authenticate', null);
  return c.json({
    challenge,
    rpId: rpIdOf(c.req.url),
    allowCredentials: [],
    userVerification: 'required',
    timeout: 60000,
  });
});

// Mirrors /login's outcome: access token (also as the accessToken cookie the
// admin UI rides) + refresh token. Account-state gates as in /login.
passkeyRoutes.post('/authenticate', async (c) => {
  const body = await c.req.json().catch(() => null) as { id?: string; response?: { clientDataJSON?: string; authenticatorData?: string; signature?: string } } | null;
  if (!body?.id || !body.response?.clientDataJSON || !body.response.authenticatorData || !body.response.signature) return c.json({ error: 'Invalid body' }, 400);
  const { bytes: clientBytes, data: clientData } = readClientData(body.response.clientDataJSON);
  if (clientData.type !== 'webauthn.get') return c.json({ error: 'Wrong ceremony type' }, 400);
  const ch = await c.env.DB.prepare(
    "SELECT id FROM webauthn_challenges WHERE challenge = ? AND type = 'authenticate' AND expires_at > ?",
  ).bind(clientData.challenge, Date.now()).first<{ id: string }>();
  if (!ch) return c.json({ error: 'Invalid or expired challenge' }, 400);
  const rpId = rpIdOf(c.req.url);
  if (!isOriginTrusted(clientData.origin, rpId)) return c.json({ error: 'Origin mismatch' }, 400);
  const cred = await c.env.DB.prepare('SELECT user_id, public_key FROM webauthn_credentials WHERE id = ?').bind(body.id).first<{ user_id: string; public_key: string }>();
  if (!cred) return c.json({ error: 'Unknown passkey' }, 401);
  const authData = base64UrlToBytes(body.response.authenticatorData);
  if (!(await rpIdHashMatches(authData, rpId))) return c.json({ error: 'RP ID mismatch' }, 400);
  let valid = false;
  try {
    valid = await verifyAssertion(base64UrlToBytes(cred.public_key), authData, clientBytes, base64UrlToBytes(body.response.signature));
  } catch (e) {
    return c.json({ error: `Signature verify failed: ${(e as Error).message}` }, 400);
  }
  if (!valid) return c.json({ error: 'Invalid signature' }, 401);
  const flags = authData[32]!;
  if (!(flags & 0x01) || !(flags & 0x04)) return c.json({ error: 'User verification failed' }, 401);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE webauthn_credentials SET sign_count = ?, last_used_at = ? WHERE id = ?').bind(signCountOf(authData), Date.now(), body.id),
    c.env.DB.prepare('DELETE FROM webauthn_challenges WHERE id = ?').bind(ch.id),
  ]);

  const row = await findUserById(c.env, cred.user_id);
  if (!row) return c.json({ error: 'Unknown user' }, 401);
  if (row.is_locked === 1) return c.json({ error: 'This account is locked.' }, 403);
  if (row.is_active !== 1) return c.json({ error: 'This account is inactive.' }, 403);
  const access = await issueAccessToken(c.env, { id: row.id, username: row.username });
  const refresh = await issueRefreshToken();
  await insertRefreshToken(c.env, {
    id: crypto.randomUUID(), userId: row.id, tokenHash: refresh.hash, expiresAt: refresh.expiresAt,
    deviceInfo: { userAgent: c.req.header('user-agent') ?? '', passkey: body.id },
  });
  await touchLastSeen(c.env, row.id);
  c.header('Set-Cookie', sessionCookie(access.token, c.req.url), { append: true });
  return c.json({ user: { id: row.id, username: row.username, token: access.token, accessToken: access.token, refreshToken: refresh.raw } });
});

passkeyRoutes.get('/list', requireAuth, async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, label, created_at, last_used_at FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at',
  ).bind(c.get('userId')).all<{ id: string; label: string | null; created_at: number; last_used_at: number | null }>();
  return c.json({ passkeys: rows.results.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at })) });
});

passkeyRoutes.delete('/:id', requireAuth, async (c) => {
  await c.env.DB.prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.get('userId')).run();
  return c.body(null, 204);
});
