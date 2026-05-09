// PBKDF2-SHA256 password hashing using Web Crypto. Argon2id would be preferable
// but pure-JS implementations are too slow for the Workers Free 10ms CPU budget;
// SubtleCrypto.deriveBits is native (C++/Rust under the hood) so the cost is
// effectively wall-clock, not CPU time.
//
// Cloudflare Workers caps PBKDF2 iterations at 100,000 — they reject anything
// higher with `NotSupportedError`. That's below current OWASP guidance (600k)
// but consistent with older NIST recommendations. Acceptable for a personal /
// small-tenant audiobook shim; revisit if we need higher security.
//
// Storage format: `pbkdf2$<iterations>$<base64-salt>$<base64-hash>`

const ITERATIONS = 100_000;
const HASH_BYTES = 32;
const SALT_BYTES = 16;

function b64encode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]!);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    // Workers' SubtleCrypto needs the salt as a BufferSource; passing the
    // typed-array directly is fine here.
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveBits(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64encode(salt)}$${b64encode(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  const salt = b64decode(parts[2]!);
  const expected = b64decode(parts[3]!);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  const actual = await deriveBits(password, salt, iterations);
  if (actual.length !== expected.length) return false;
  // Constant-time compare.
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}
