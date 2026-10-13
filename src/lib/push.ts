// Web Push sender: new-episode notifications for Pholia (2026-10-13).
//
// The top half (VAPID JWT, aesgcm payload encryption, sendPushNotification)
// is TinnyGo's worker/src/services/push.ts, in production there since April
// 2026 against Apple, FCM and Mozilla, copied rather than rewritten
// (/Users/joseph/Claude_Code/Islandpool/docs/web-push-export.md). Changes:
// types only (noUncheckedIndexedAccess), plus sendPushNotification takes the
// VAPID subject and also returns the push service's HTTP status, which the
// device list and the test route report. The bottom half is this schema's
// (migration 0026): fan-out, stamping, the new-episode trigger, the log.
//
// No library: Web Crypto + fetch only, so no nodejs_compat and no new deps.

import type { Env } from '../types';

export type PushPayload = {
  title: string;
  body?: string;
  tag?: string;
  libraryItemId?: string;
  episodeId?: string;
  kind: 'episode' | 'test';
};

// ============================================================
// Helpers
// ============================================================

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function encodeLength(length: number): Uint8Array {
  return new Uint8Array([0, length]);
}

// ============================================================
// VAPID JWT Generation
// ============================================================

/**
 * Generate VAPID Authorization headers for web push.
 * Creates a signed JWT using ECDSA P-256.
 */
export async function generateVapidHeaders(
  audience: string,
  subject: string,
  vapidPublicKey: string,
  vapidPrivateKey: string,
): Promise<{ authorization: string; cryptoKeyHeader: string }> {
  // Import the VAPID private key (base64url-encoded raw 32-byte key)
  const privateKeyBytes = base64UrlToBytes(vapidPrivateKey);

  // Build JWK for ECDSA P-256 private key
  // The public key is the uncompressed 65-byte point on P-256
  const publicKeyBytes = base64UrlToBytes(vapidPublicKey);

  // Extract x and y from the uncompressed public key (0x04 || x || y)
  const x = publicKeyBytes.slice(1, 33);
  const y = publicKeyBytes.slice(33, 65);

  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToBase64Url(x),
    y: bytesToBase64Url(y),
    d: bytesToBase64Url(privateKeyBytes),
  };

  const ecdsaKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  // Create JWT
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: now + 12 * 3600, // 12 hours
    sub: subject,
  };

  const headerB64 = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const unsignedToken = `${headerB64}.${payloadB64}`;

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    ecdsaKey,
    new TextEncoder().encode(unsignedToken),
  );

  // Web Crypto returns DER-encoded signature; convert to raw r||s (64 bytes)
  const rawSignature = derToRaw(new Uint8Array(signature));
  const signatureB64 = bytesToBase64Url(rawSignature);

  const jwt = `${unsignedToken}.${signatureB64}`;

  return {
    authorization: `vapid t=${jwt}, k=${vapidPublicKey}`,
    cryptoKeyHeader: `p256ecdsa=${vapidPublicKey}`,
  };
}

/**
 * Convert DER-encoded ECDSA signature to raw r||s format (64 bytes).
 */
function derToRaw(der: Uint8Array): Uint8Array {
  // DER format: 0x30 <len> 0x02 <rLen> <r> 0x02 <sLen> <s>
  const raw = new Uint8Array(64);

  // Sometimes Web Crypto returns raw format directly
  if (der.length === 64) {
    return der;
  }

  let offset = 2; // Skip 0x30 <total_len>

  // Parse r
  if (der[offset] !== 0x02) throw new Error('Invalid DER signature');
  offset++;
  const rLen = der[offset]!;
  offset++;
  const rStart = rLen > 32 ? offset + (rLen - 32) : offset;
  const rPadStart = rLen < 32 ? 32 - rLen : 0;
  raw.set(der.slice(rStart, offset + rLen), rPadStart);
  offset += rLen;

  // Parse s
  if (der[offset] !== 0x02) throw new Error('Invalid DER signature');
  offset++;
  const sLen = der[offset]!;
  offset++;
  const sStart = sLen > 32 ? offset + (sLen - 32) : offset;
  const sPadStart = sLen < 32 ? 32 - sLen : 0;
  raw.set(der.slice(sStart, offset + sLen), 32 + sPadStart);

  return raw;
}

// ============================================================
// Payload Encryption (RFC 8291 / aesgcm)
// ============================================================

/**
 * HKDF using Web Crypto API.
 * Extracts and expands key material per RFC 5869.
 */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  // Extract
  const extractKey = await crypto.subtle.importKey(
    'raw',
    salt.length > 0 ? salt : new Uint8Array(32),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const prk = new Uint8Array(await crypto.subtle.sign('HMAC', extractKey, ikm));

  // Expand
  const expandKey = await crypto.subtle.importKey(
    'raw',
    prk,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const infoWithCounter = concatBytes(info, new Uint8Array([1]));
  const okm = new Uint8Array(await crypto.subtle.sign('HMAC', expandKey, infoWithCounter));

  return okm.slice(0, length);
}

/**
 * Create the info parameter for HKDF as defined in RFC 8291.
 * info = "Content-Encoding: " || type || 0x00 || "P-256" || 0x00 ||
 *        len(recipientPublicKey) || recipientPublicKey ||
 *        len(senderPublicKey) || senderPublicKey
 */
function createInfo(
  type: string,
  clientPublicKey: Uint8Array,
  serverPublicKey: Uint8Array,
): Uint8Array {
  const encoding = new TextEncoder().encode(`Content-Encoding: ${type}\0`);
  const p256Label = new TextEncoder().encode('P-256\0');
  return concatBytes(
    encoding,
    p256Label,
    encodeLength(clientPublicKey.length),
    clientPublicKey,
    encodeLength(serverPublicKey.length),
    serverPublicKey,
  );
}

/**
 * Encrypt push notification payload per RFC 8291 (aesgcm encoding).
 */
async function encryptPayload(
  clientPublicKeyBase64: string,
  clientAuthBase64: string,
  payload: Uint8Array,
): Promise<{
  ciphertext: Uint8Array;
  salt: Uint8Array;
  serverPublicKeyBytes: Uint8Array;
}> {
  const clientPublicKeyBytes = base64UrlToBytes(clientPublicKeyBase64);
  const clientAuthBytes = base64UrlToBytes(clientAuthBase64);

  // Generate ephemeral ECDH key pair
  const serverKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  ) as CryptoKeyPair;

  // Export server public key (uncompressed point)
  const serverPublicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', serverKeys.publicKey) as ArrayBuffer,
  );

  // Import client public key
  const clientPublicKey = await crypto.subtle.importKey(
    'raw',
    clientPublicKeyBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  // Derive shared secret via ECDH. `public` is the spec's (and the
  // runtime's) name; workers-types spells it `$public`, hence the cast.
  const sharedSecretBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientPublicKey } as any,
    serverKeys.privateKey,
    256,
  );
  const sharedSecret = new Uint8Array(sharedSecretBits);

  // Generate 16-byte salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Derive PRK using auth secret as salt and shared secret as IKM
  // info for auth: "Content-Encoding: auth\0"
  const authInfo = new TextEncoder().encode('Content-Encoding: auth\0');
  const prk = await hkdf(clientAuthBytes, sharedSecret, authInfo, 32);

  // Derive content encryption key (CEK) — 16 bytes
  const cekInfo = createInfo('aesgcm', clientPublicKeyBytes, serverPublicKeyBytes);
  const cek = await hkdf(salt, prk, cekInfo, 16);

  // Derive nonce — 12 bytes
  const nonceInfo = createInfo('nonce', clientPublicKeyBytes, serverPublicKeyBytes);
  const nonce = await hkdf(salt, prk, nonceInfo, 12);

  // Pad the payload (2-byte padding length prefix, no padding bytes for simplicity)
  const paddedPayload = concatBytes(new Uint8Array([0, 0]), payload);

  // Encrypt with AES-128-GCM
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    cek,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    cryptoKey,
    paddedPayload,
  );

  return {
    ciphertext: new Uint8Array(encrypted),
    salt,
    serverPublicKeyBytes,
  };
}

// ============================================================
// Send Push Notification
// ============================================================

// TinnyGo uses 2 h for time-sensitive rides. A new episode is still news
// next morning: a phone that is off overnight should get it when it wakes.
const PUSH_TTL_SECONDS = 24 * 3600;

export type SendResult = { result: 'sent' | 'expired' | 'failed'; status: number | null };

/**
 * Send a push notification to a single subscription.
 */
export async function sendPushNotification(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: PushPayload,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidSubject: string,
): Promise<SendResult> {
  try {
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));

    // Encrypt the payload
    const { ciphertext, salt, serverPublicKeyBytes } = await encryptPayload(
      subscription.p256dh,
      subscription.auth,
      payloadBytes,
    );

    // Generate VAPID headers
    const endpoint = new URL(subscription.endpoint);
    const audience = `${endpoint.protocol}//${endpoint.host}`;
    const { authorization } = await generateVapidHeaders(
      audience,
      vapidSubject,
      vapidPublicKey,
      vapidPrivateKey,
    );

    // Send the encrypted payload to the push service
    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': authorization,
        'Urgency': 'high',
        'TTL': String(PUSH_TTL_SECONDS),
        'Content-Encoding': 'aesgcm',
        'Encryption': `salt=${bytesToBase64Url(salt)}`,
        'Crypto-Key': `dh=${bytesToBase64Url(serverPublicKeyBytes)}; p256ecdsa=${vapidPublicKey}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(ciphertext.length),
      },
      body: ciphertext,
    });

    if (response.status === 201 || response.status === 202) {
      await response.body?.cancel().catch(() => undefined);
      return { result: 'sent', status: response.status };
    }

    // 404 or 410 means subscription is truly expired/invalid — safe to delete
    if (response.status === 404 || response.status === 410) {
      // The host only: an endpoint URL is the subscription's address.
      console.log(`Push subscription expired: ${endpoint.host}`);
      await response.body?.cancel().catch(() => undefined);
      return { result: 'expired', status: response.status };
    }

    // Other errors (5xx, network, auth) are transient — don't delete the sub.
    // Every non-201 used to delete in TinnyGo, and a transient Apple 5xx
    // silently unsubscribed people.
    console.error(`Push service error: ${response.status} ${(await response.text()).slice(0, 300)}`);
    return { result: 'failed', status: response.status };
  } catch (error) {
    console.error('Failed to send push notification:', error);
    return { result: 'failed', status: null };
  }
}

// ============================================================
// This shim's half (migration 0026)
// ============================================================

// Apple refuses a VAPID JWT without a valid `sub`; a mailto: or https: URL
// both qualify. The shim's own address rather than anyone's mailbox.
const DEFAULT_SUBJECT = 'https://abs-shim.jderrick.app';

export type PushConfig = { publicKey: string; privateKey: string; subject: string };

// Null when the VAPID secrets are missing: /api/push/status then says
// `configured: false` and Pholia hides the bell. The pair must never be
// rotated once devices have subscribed: a subscription is bound to the key
// it was made with, and Apple answers a push signed with another key 403,
// which counts as transient. Pholia re-subscribes when the shim's publicKey
// differs from its subscription's, so a rotation heals on each device's next
// app start, but nothing arrives on any device until then.
export function pushConfig(env: Env): PushConfig | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || DEFAULT_SUBJECT };
}

export type SubRow = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string };
export type Delivery = { id: string; userId: string; service: string; status: SendResult['result']; httpStatus: number | null };

// The push service by endpoint host, for the device list. Never the endpoint
// itself: it is the subscription's address.
export function pushService(endpoint: string): string {
  try {
    const host = new URL(endpoint).hostname;
    if (/(^|\.)push\.apple\.com$/.test(host)) return 'Apple';
    if (/(^|\.)(fcm|android)\.googleapis\.com$/.test(host)) return 'Chrome/Android';
    if (/(^|\.)push\.services\.mozilla\.com$/.test(host)) return 'Firefox';
    if (/(^|\.)notify\.windows\.com$/.test(host)) return 'Edge';
    return host;
  } catch { return 'unknown'; }
}

const IN_CHUNK = 90; // D1 allows 100 bound parameters per statement

// One payload to many subscriptions, in parallel, then one D1 batch: 404/410
// deletes the subscription (the push service says it is gone; Pholia's
// re-POST on its next start recreates it if the device still has one),
// 201/202 stamps last_success_at, anything else stamps the failure and KEEPS
// the subscription, because 5xx, 429 and 403 are not the device leaving.
export async function deliver(env: Env, cfg: PushConfig, subs: SubRow[], payload: PushPayload): Promise<Delivery[]> {
  const out: Delivery[] = await Promise.all(subs.map(async (s) => {
    const r = await sendPushNotification(s, payload, cfg.publicKey, cfg.privateKey, cfg.subject);
    return { id: s.id, userId: s.user_id, service: pushService(s.endpoint), status: r.result, httpStatus: r.status };
  }));
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  const inList = (sql: (ph: string) => string, ids: string[], ...lead: unknown[]) => {
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const part = ids.slice(i, i + IN_CHUNK);
      stmts.push(env.DB.prepare(sql(part.map(() => '?').join(','))).bind(...lead, ...part));
    }
  };
  inList((ph) => `DELETE FROM push_subscriptions WHERE id IN (${ph})`, out.filter((d) => d.status === 'expired').map((d) => d.id));
  inList((ph) => `UPDATE push_subscriptions SET last_success_at = ? WHERE id IN (${ph})`, out.filter((d) => d.status === 'sent').map((d) => d.id), now);
  for (const d of out) {
    if (d.status === 'failed') {
      stmts.push(env.DB.prepare('UPDATE push_subscriptions SET last_failure_at = ?, last_failure_status = ? WHERE id = ?').bind(now, d.httpStatus, d.id));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return out;
}

// '1 sent', '1 sent, 1 failed (503)', 'no subscription'.
export function summarise(ds: Delivery[]): string {
  if (!ds.length) return 'no subscription';
  const sent = ds.filter((d) => d.status === 'sent').length;
  const failed = ds.filter((d) => d.status === 'failed');
  const expired = ds.filter((d) => d.status === 'expired').length;
  const parts: string[] = [];
  if (sent) parts.push(`${sent} sent`);
  if (failed.length) parts.push(`${failed.length} failed (${[...new Set(failed.map((d) => d.httpStatus ?? 'network'))].join(', ')})`);
  if (expired) parts.push(`${expired} expired`);
  return parts.join(', ');
}

export async function logPush(env: Env, rows: Array<{ userId: string | null; kind: PushPayload['kind']; title: string; status: string }>): Promise<void> {
  if (!rows.length) return;
  const now = Date.now();
  try {
    await env.DB.batch(rows.map((r) => env.DB.prepare('INSERT INTO push_log (ts, user_id, kind, title, status) VALUES (?, ?, ?, ?, ?)')
      .bind(now, r.userId, r.kind, r.title.slice(0, 300), r.status.slice(0, 200))));
  } catch (e) {
    console.error('push log: ' + (e as Error).message);
  }
}

const LOG_KEEP_MS = 30 * 86400_000;

// Cron: the log is for "did it try, and what did the service say" on a
// recent miss, not history.
export async function cleanPushLog(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM push_log WHERE ts < ?').bind(Date.now() - LOG_KEEP_MS).run();
}

// ── The new-episode trigger ──────────────────────────────────────────────

// An episode is news only if it was published in the last three days. The
// poller can insert old episodes legitimately (a feed that starts listing
// more of its back catalogue, a guid change rekeyMovedEpisodes can't match,
// a show re-posting an old episode under a new guid), and a lock screen full
// of those is the opposite of what the bell asked for.
const NEW_EPISODE_WINDOW_MS = 3 * 86400_000;
const TEXT_MAX = 180; // a push payload is capped at ~4 KB by the services

const clip = (s: string) => (s.length > TEXT_MAX ? s.slice(0, TEXT_MAX - 1).trimEnd() + '…' : s);

type RecipientRow = { uid: string; id: string | null; user_id: string | null; endpoint: string | null; p256dh: string | null; auth: string | null };

// Called by the poller (refreshPodcast) with the episodes one feed check
// INSERTED and put on the show, and only for a check that counts (see
// there). One notification per show per check: with several new episodes it
// names the newest and how many. Recipients: users with the bell on for
// this show who are still active members of its tenant, each to every
// device they have; their devices come back in the same query, so the cost
// doesn't grow with the number of recipients. Returns a log line, or null
// when there was no one to tell.
export async function announceNewEpisodes(
  env: Env,
  show: { library_item_id: string; tenant_id: string; title: string | null },
  episodeIds: string[],
): Promise<string | null> {
  const cfg = pushConfig(env);
  if (!cfg || !episodeIds.length) return null;
  const rows = (await env.DB.prepare(
    `SELECT sp.user_id AS uid, s.id, s.user_id, s.endpoint, s.p256dh, s.auth
       FROM push_show_prefs sp
       JOIN tenant_members tm ON tm.user_id = sp.user_id AND tm.tenant_id = ?
       JOIN users u ON u.id = sp.user_id AND u.is_active = 1 AND u.is_locked = 0
       LEFT JOIN push_subscriptions s ON s.user_id = sp.user_id
      WHERE sp.library_item_id = ? AND sp.notify = 1`,
  ).bind(show.tenant_id, show.library_item_id).all<RecipientRow>()).results;
  if (!rows.length) return null;

  // The caller passes newest first, so a (very unusual) long list keeps the
  // newest. in_library/removed are re-read: the show's keep-limit runs
  // between the insert and here.
  const ids = episodeIds.slice(0, IN_CHUNK);
  const eps = (await env.DB.prepare(
    `SELECT id, title, published_at FROM podcast_episodes
      WHERE library_item_id = ? AND in_library = 1 AND removed = 0 AND published_at >= ?
        AND id IN (${ids.map(() => '?').join(',')})
      ORDER BY published_at DESC, idx DESC`,
  ).bind(show.library_item_id, Date.now() - NEW_EPISODE_WINDOW_MS, ...ids).all<{ id: string; title: string | null; published_at: number }>()).results;
  const newest = eps[0];
  if (!newest) return null;

  const showTitle = clip(show.title?.trim() || 'New episode');
  const epTitle = newest.title?.trim() || 'New episode';
  const payload: PushPayload = {
    title: showTitle,
    body: clip(eps.length > 1 ? `${eps.length} new episodes: ${epTitle}` : epTitle),
    // One per show: a second check's notification replaces the first's
    // instead of stacking.
    tag: `show-${show.library_item_id}`,
    libraryItemId: show.library_item_id,
    episodeId: newest.id,
    kind: 'episode',
  };
  const subs = rows.filter((r): r is RecipientRow & SubRow => r.id != null);
  const deliveries = subs.length ? await deliver(env, cfg, subs, payload) : [];
  const users = [...new Set(rows.map((r) => r.uid))];
  await logPush(env, users.map((u) => ({
    userId: u, kind: 'episode' as const, title: `${payload.title}: ${payload.body}`,
    status: summarise(deliveries.filter((d) => d.userId === u)),
  })));
  return `${show.title ?? show.library_item_id}: ${eps.length} new to ${users.length} user(s), ${summarise(deliveries)}`;
}
