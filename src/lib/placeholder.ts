// 1x1 transparent PNG. Used by routes that should never 404 a client's
// <img> tag — covers, author photos — so the console doesn't fill with
// broken-image errors for entities whose source asset doesn't exist.

const PLACEHOLDER_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII='),
  (ch) => ch.charCodeAt(0),
);

export function placeholderImage(): Response {
  return new Response(PLACEHOLDER_PNG, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=300',
      'Content-Length': String(PLACEHOLDER_PNG.byteLength),
    },
  });
}
