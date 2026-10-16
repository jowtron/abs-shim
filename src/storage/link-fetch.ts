// Fetching a storage link that may have to be minted again.
//
// pCloud's getfilelink URLs only work from the IP address that asked for
// them; any other IP gets 410 Gone ("This link was generated for another IP
// address"). A Worker's subrequests do NOT always leave Cloudflare from one
// IP, not even within one invocation: on 2026-10-17 both of an Audible sync's
// books were copied into pCloud and then failed to register, because the
// probe that read them, right after minting the link, got 410 (/admin's
// "Retry failed" registered both at once). Streaming passed the same 410
// straight to the player.
//
// So an adapter that mints such links registers how to get a fresh one, and
// every fetch of a storage URL goes through fetchLink, which answers a 410 by
// asking for a fresh link and trying again. URLs nobody registered (S3
// presigned, WebDAV, filedn, publishers' enclosures) are fetched exactly as
// before.

type Refresher = () => Promise<string>;

// Minted link → how to get the current good link for the same file.
const refreshers = new Map<string, Refresher>();
// A link that answered 410 → the link that replaced it, so the next read of a
// multi-read probe (which still holds the old URL) goes straight to the new
// one instead of paying for another 410 first.
const superseded = new Map<string, string>();

// Per isolate; a scan can mint thousands of links. Oldest entries go first
// (a Map iterates in insertion order), and an entry lost to the cap only
// means one 410 passed through as before.
const MAX_ENTRIES = 2000;
// Fresh links tried after a 410 before giving up and returning it.
const REFRESHES = 2;

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function registerLinkRefresher(url: string, refresh: Refresher): void {
  remember(refreshers, url, refresh);
}

function latest(url: string): string {
  let cur = url;
  for (let i = 0; i < 4; i++) {
    const next = superseded.get(cur);
    if (!next) break;
    cur = next;
  }
  return cur;
}

export async function fetchLink(url: string, init?: RequestInit): Promise<Response> {
  let current = latest(url);
  let res = await fetch(current, init);
  for (let i = 0; i < REFRESHES && res.status === 410; i++) {
    const refresh = refreshers.get(current);
    if (!refresh) break;
    let next: string;
    try {
      next = await refresh();
    } catch (e) {
      console.warn(`storage link 410, refresh failed: ${e instanceof Error ? e.message : String(e)}`);
      break;
    }
    console.warn(`storage link 410, retrying with a fresh link (${i + 1}/${REFRESHES})`);
    await res.body?.cancel().catch(() => undefined);
    if (next !== current) remember(superseded, current, next);
    current = next;
    res = await fetch(current, init);
  }
  return res;
}
