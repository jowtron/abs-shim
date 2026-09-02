// WebAuthn (passkey) primitives — a TypeScript port of Pholia's
// functions/_shared/{webauthn,cbor,crypto,encoding}.js, which has been in
// production for the Pholia vault since mid-2026. Pure Web Crypto: npm
// WebAuthn libraries lean on Node's Buffer and don't run on Workers.
//
// Only ES256 (COSE alg -7, P-256) is offered at registration, so that's all
// verification needs to handle.

export const CHALLENGE_EXPIRY_MS = 5 * 60_000;

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// The RP ID is the hostname the page was served from. localhost for dev.
export function rpIdFor(origin: string): string {
  try {
    const u = new URL(origin);
    return u.hostname === '127.0.0.1' ? 'localhost' : u.hostname;
  } catch {
    return 'localhost';
  }
}

export function isOriginTrusted(clientOrigin: string, rpId: string): boolean {
  try {
    const u = new URL(clientOrigin);
    return u.hostname === rpId || u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

// Minimal CBOR decoder: just the major types CTAP2/WebAuthn payloads use.
type Cbor = number | string | Uint8Array | boolean | null | Cbor[] | { [k: string]: Cbor };

export function decodeCBOR(buffer: Uint8Array): Cbor {
  let offset = 0;
  const readByte = () => buffer[offset++]!;
  const readBytes = (n: number) => { const s = buffer.slice(offset, offset + n); offset += n; return s; };
  const readArg = (add: number): number => {
    if (add < 24) return add;
    if (add === 24) return readByte();
    if (add === 25) { const v = (buffer[offset]! << 8) | buffer[offset + 1]!; offset += 2; return v; }
    if (add === 26) { const v = ((buffer[offset]! << 24) | (buffer[offset + 1]! << 16) | (buffer[offset + 2]! << 8) | buffer[offset + 3]!) >>> 0; offset += 4; return v; }
    throw new Error(`CBOR: unsupported additional info ${add}`);
  };
  const decode = (): Cbor => {
    const initial = readByte();
    const major = initial >> 5;
    const add = initial & 0x1f;
    switch (major) {
      case 0: return readArg(add);
      case 1: return -1 - readArg(add);
      case 2: return readBytes(readArg(add));
      case 3: return new TextDecoder().decode(readBytes(readArg(add)));
      case 4: { const n = readArg(add); const arr: Cbor[] = []; for (let i = 0; i < n; i++) arr.push(decode()); return arr; }
      case 5: { const n = readArg(add); const map: { [k: string]: Cbor } = {}; for (let i = 0; i < n; i++) { const k = decode(); map[String(k)] = decode(); } return map; }
      case 7:
        if (add === 20) return false;
        if (add === 21) return true;
        if (add === 22) return null;
        throw new Error(`CBOR: unsupported special ${add}`);
      default:
        throw new Error(`CBOR: unsupported major type ${major}`);
    }
  };
  return decode();
}

// authData layout: rpIdHash(32) | flags(1) | signCount(4) | aaguid(16) | credIdLen(2) | credId | pubKeyCOSE
export function parseAttestationAuthData(authData: Uint8Array): { credentialId: Uint8Array; publicKeyCOSE: Uint8Array } {
  if (authData.length < 37) throw new Error('Invalid authData');
  const flags = authData[32]!;
  if (!(flags & 0x01) || !(flags & 0x04) || !(flags & 0x40)) throw new Error('Missing UP/UV/AT flags');
  let pos = 37 + 16;
  const credIdLen = (authData[pos]! << 8) | authData[pos + 1]!;
  pos += 2;
  const credentialId = authData.slice(pos, pos + credIdLen);
  pos += credIdLen;
  return { credentialId, publicKeyCOSE: authData.slice(pos) };
}

// WebAuthn signatures are DER; Web Crypto wants raw r||s.
function derToP1363(der: Uint8Array, len: number): Uint8Array {
  let off = 0;
  if (der[off++] !== 0x30) throw new Error('Invalid DER signature');
  off++;
  if (der[off++] !== 0x02) throw new Error('Invalid DER: r');
  const rLen = der[off++]!;
  const r = der.slice(off, off + rLen);
  off += rLen;
  if (der[off++] !== 0x02) throw new Error('Invalid DER: s');
  const sLen = der[off++]!;
  const s = der.slice(off, off + sLen);
  const out = new Uint8Array(len * 2);
  if (rLen > len) out.set(r.slice(rLen - len), 0); else out.set(r, len - rLen);
  if (sLen > len) out.set(s.slice(sLen - len), len); else out.set(s, len * 2 - sLen);
  return out;
}

export async function verifyAssertion(publicKeyCOSE: Uint8Array, authData: Uint8Array, clientDataJSON: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const cose = decodeCBOR(publicKeyCOSE) as { [k: string]: Cbor };
  const x = cose['-2'];
  const y = cose['-3'];
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) throw new Error('Unsupported key type (need EC P-256)');
  const key = await crypto.subtle.importKey(
    'jwk', { kty: 'EC', crv: 'P-256', x: bytesToBase64Url(x), y: bytesToBase64Url(y) },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
  );
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
  const signed = new Uint8Array(authData.length + clientDataHash.length);
  signed.set(authData);
  signed.set(clientDataHash, authData.length);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToP1363(signature, 32), signed);
}

// authData[0..32] is SHA-256(rpId): proves the authenticator scoped this
// credential/assertion to our hostname, whatever the client claims.
export async function rpIdHashMatches(authData: Uint8Array, rpId: string): Promise<boolean> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
  if (authData.length < 32) return false;
  for (let i = 0; i < 32; i++) if (authData[i] !== h[i]) return false;
  return true;
}

export function signCountOf(authData: Uint8Array): number {
  return ((authData[33]! << 24) | (authData[34]! << 16) | (authData[35]! << 8) | authData[36]!) >>> 0;
}

// "iPhone", "Mac", "Windows PC", … from the registering browser's UA, as the
// credential's default label.
export function labelFromUserAgent(ua: string): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android device';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Passkey';
}
