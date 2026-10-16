// Self-test for fetchLink's 410 retry and its wiring into the pCloud adapter.
// No framework, like src/prober/mp3.test.ts: run it with
//
//   npx tsx -e 'import("./src/storage/link-fetch.test.ts").then(m => m.runLinkFetchSelfTest())'
//
// Global fetch is replaced for the duration, so nothing reaches the network.

import { fetchLink, registerLinkRefresher } from './link-fetch';
import { PcloudOAuthAdapter } from './pcloud';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`link-fetch self-test FAILED: ${msg}`);
}

type Handler = (url: string) => Response;

async function withFetch<T>(handler: Handler, body: (calls: string[]) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = real;
  }
}

const gone = () => new Response('<html>This link was generated for another IP address.</html>', { status: 410, statusText: 'Gone' });
const partial = () => new Response('abc', { status: 206 });

export async function runLinkFetchSelfTest(): Promise<void> {
  // A URL nobody registered: a 410 comes back as it is, one fetch.
  await withFetch(() => gone(), async (calls) => {
    const res = await fetchLink('https://example.test/unregistered');
    assert(res.status === 410 && calls.length === 1, 'unregistered 410 passes through untouched');
  });

  // Registered: 410, then the fresh link answers.
  let refreshes = 0;
  registerLinkRefresher('https://p1.test/a', async () => { refreshes++; return 'https://p1.test/b'; });
  await withFetch((u) => (u.endsWith('/a') ? gone() : partial()), async (calls) => {
    const res = await fetchLink('https://p1.test/a', { headers: { Range: 'bytes=0-2' } });
    assert(res.status === 206, `fresh link answers 206 (got ${res.status})`);
    assert(await res.text() === 'abc', 'fresh link body');
    assert(refreshes === 1, 'one refresh');
    assert(calls.join(' ') === 'https://p1.test/a https://p1.test/b', `fetched old then new: ${calls.join(' ')}`);
  });

  // A later read through the OLD URL goes straight to the replacement.
  await withFetch((u) => (u.endsWith('/a') ? gone() : partial()), async (calls) => {
    const res = await fetchLink('https://p1.test/a');
    assert(res.status === 206 && calls.length === 1 && calls[0] === 'https://p1.test/b', 'old URL follows its replacement');
    assert(refreshes === 1, 'no second refresh');
  });

  // Every link 410s: two fresh links, then the last 410 is returned.
  registerLinkRefresher('https://p2.test/1', async () => 'https://p2.test/2');
  registerLinkRefresher('https://p2.test/2', async () => 'https://p2.test/3');
  registerLinkRefresher('https://p2.test/3', async () => 'https://p2.test/4');
  await withFetch(() => gone(), async (calls) => {
    const res = await fetchLink('https://p2.test/1');
    assert(res.status === 410, 'gives up with the 410');
    assert(calls.length === 3, `three fetches in all (got ${calls.length})`);
  });

  // The refresh itself fails: the original 410 is returned, body intact.
  registerLinkRefresher('https://p3.test/x', async () => { throw new Error('pCloud said no'); });
  await withFetch(() => gone(), async (calls) => {
    const res = await fetchLink('https://p3.test/x');
    assert(res.status === 410 && calls.length === 1, 'failed refresh returns the 410');
    assert((await res.text()).includes('another IP'), 'its body is still readable');
  });

  // Anything but 410 is never retried.
  let neverCalled = true;
  registerLinkRefresher('https://p4.test/x', async () => { neverCalled = false; return 'https://p4.test/y'; });
  await withFetch(() => new Response('', { status: 403 }), async (calls) => {
    const res = await fetchLink('https://p4.test/x');
    assert(res.status === 403 && calls.length === 1 && neverCalled, '403 is not retried');
  });

  // The adapter: a link it minted answers 410, fetchLink gets a fresh one
  // through getfilelink, and the adapter's cache then holds the fresh one.
  let minted = 0;
  const api = (u: string): Response => {
    if (u.includes('/getfilelink')) {
      minted++;
      return Response.json({ result: 0, hosts: ['psyd1.pcloud.test'], path: `/link${minted}/book.m4b`, expires: new Date(Date.now() + 6 * 3600_000).toUTCString() });
    }
    return u.includes('/link1/') ? gone() : partial();
  };
  await withFetch(api, async (calls) => {
    const adapter = new PcloudOAuthAdapter({ accessToken: 'test-token-not-real', apiHost: 'api.pcloud.test' }, { rootPath: '/Audiobooks' });
    const first = await adapter.resolveProbeUrl('Author/Book/book.m4b');
    assert(first.url === 'https://psyd1.pcloud.test/link1/book.m4b', `first link (${first.url})`);
    const res = await fetchLink(first.url, { headers: { Range: 'bytes=0-2' } });
    assert(res.status === 206, `adapter link retried to 206 (got ${res.status}; calls ${calls.join(' ')})`);
    assert(minted === 2, `getfilelink called twice (got ${minted})`);
    const again = await adapter.resolveProbeUrl('Author/Book/book.m4b');
    assert(again.url === 'https://psyd1.pcloud.test/link2/book.m4b' && minted === 2, 'cache now holds the fresh link');
  });

  console.log('link-fetch self-test: all passed');
}
