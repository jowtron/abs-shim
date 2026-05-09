// Helpers for synthesizing stable derived UUIDs. ABS exposes ids for many
// records that we don't separately persist (book.id distinct from
// libraryItem.id, author.id, series.id). We don't model them as separate
// tables, but clients still expect stable string ids — so we hash them
// deterministically from a parent id + a discriminator.

const enc = new TextEncoder();

async function sha256(input: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return new Uint8Array(buf);
}

function bytesToUuid(bytes: Uint8Array): string {
  // Take the first 16 bytes, set version (4) and variant (RFC 4122) bits, format.
  const b = bytes.slice(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function derivedId(...parts: string[]): Promise<string> {
  const h = await sha256(parts.join('\x00'));
  return bytesToUuid(h);
}
