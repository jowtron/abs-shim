// Which company serves an episode's audio (2026-11-10, migration 0039).
//
// Evidence-gathering for the home-fetch idea (CLAUDE.md, Podcasts): ad
// insertion depends on the host and on where the request comes from, so
// every episode records the host its audio really came from and every
// analysis records how many ads it found (episode_ad_observations). Pholia
// shows the name as a small label when an episode has no "No ads" badge.
//
// An enclosure is usually a chain: tracking prefixes written into the path
// ("dts.podtrac.com/redirect.mp3/mgln.ai/e/211/rss.art19.com/x.mp3"), then
// redirects to the host's CDN. The host is named from the final URL when
// it belongs to a known company, else from the enclosure with the trackers
// stripped, else the registrable domain of whatever is left ("self-hosted":
// linuxmatters.net).

import type { Env } from '../types';

type HostCompany = { name: string; domains: string[]; dynamicAds: boolean };

// `dynamicAds`: the host stitches ads into the file per download (verified
// 2026-10-12: art19 served this Worker and a home connection two different
// LINUX Unplugged files, 41 s apart after the mid-roll; Audioboom's No Such
// Thing As A Fish differed by two minutes; PRX's Dovetail does it too).
// hasDynamicAds (podcast-shapes.ts) is derived from this list.
const COMPANIES: HostCompany[] = [
  { name: 'art19', domains: ['art19.com'], dynamicAds: true },
  { name: 'Audioboom', domains: ['audioboom.com'], dynamicAds: true },
  { name: 'Megaphone', domains: ['megaphone.fm'], dynamicAds: true },
  { name: 'Simplecast', domains: ['simplecastaudio.com', 'simplecast.com'], dynamicAds: true },
  { name: 'AdsWizz', domains: ['adswizz.com'], dynamicAds: true },
  { name: 'acast', domains: ['acast.com'], dynamicAds: true },
  { name: 'Omny', domains: ['omny.fm', 'omnycontent.com'], dynamicAds: true },
  { name: 'Anchor', domains: ['anchor.fm'], dynamicAds: true },
  { name: 'Spotify', domains: ['spotify.com'], dynamicAds: true },
  { name: 'Spreaker', domains: ['spreaker.com'], dynamicAds: true },
  { name: 'PRX', domains: ['prxu.org', 'prx.org'], dynamicAds: true },
  { name: 'Libsyn', domains: ['libsyn.com', 'libsynpro.com'], dynamicAds: false },
  { name: 'Buzzsprout', domains: ['buzzsprout.com'], dynamicAds: false },
  { name: 'Transistor', domains: ['transistor.fm'], dynamicAds: false },
  { name: 'Podbean', domains: ['podbean.com'], dynamicAds: false },
  { name: 'Captivate', domains: ['captivate.fm'], dynamicAds: false },
  { name: 'Whooshkaa', domains: ['whooshkaa.com'], dynamicAds: false },
  { name: 'Supercast', domains: ['supercast.com'], dynamicAds: false },
  { name: 'Flightcast', domains: ['flightcast.com'], dynamicAds: false },
  { name: 'Blubrry', domains: ['blubrry.com', 'blubrry.net'], dynamicAds: false },
  { name: 'Fireside', domains: ['fireside.fm'], dynamicAds: false },
  { name: 'RSS.com', domains: ['rss.com'], dynamicAds: false },
  { name: 'RedCircle', domains: ['redcircle.com'], dynamicAds: false },
  { name: 'Podigee', domains: ['podigee.io', 'podigee-cdn.net'], dynamicAds: false },
  { name: 'Ausha', domains: ['ausha.co'], dynamicAds: false },
  { name: 'Castos', domains: ['castos.com'], dynamicAds: false },
  { name: 'SoundCloud', domains: ['soundcloud.com', 'sndcdn.com'], dynamicAds: false },
  { name: 'Podomatic', domains: ['podomatic.com'], dynamicAds: false },
  { name: 'Pinecast', domains: ['pinecast.com', 'pinecast.net'], dynamicAds: false },
];

// Tracking and analytics prefixes: they only redirect, so they name nobody.
// SoundStack's "enrichment" prefix (Chat 10 Looks 3, The Imperfects) and
// Spotify's prfx.byspotify.com are prefixes too, not hosts.
const TRACKERS = ['podtrac.com', 'pscrb.fm', 'podscribe.com', 'chrt.fm', 'chtbl.com', 'op3.dev', 'mgln.ai',
  'pdst.fm', 'vpixl.com', 'arttrk.com', 'claritaspod.com', 'pdcn.co', 'swap.fm', 'byspotify.com',
  'soundstack.com', 'feedpress.it', 'podroll.fm', 'growx.co', 'tracking.feedpress.it', 'podcorn.com'];

const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?$/;

function under(host: string, domain: string): boolean {
  return host === domain || host.endsWith('.' + domain);
}
function companyOf(host: string): HostCompany | null {
  return COMPANIES.find((c) => c.domains.some((d) => under(host, d))) ?? null;
}
export function isTracker(host: string): boolean {
  return TRACKERS.some((d) => under(host, d));
}

// Every host named in a URL: its own, then any written into its path (a
// tracking prefix carries the next hop as a path segment). The last path
// segment is the file, never a host.
export function urlHosts(url: string | null | undefined): string[] {
  const bare = ((url ?? '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[?#]/)[0] ?? '').toLowerCase();
  const parts = bare.split('/');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = (parts[i] ?? '').replace(/:\d+$/, '');
    if ((i === 0 || i < parts.length - 1) && HOST_RE.test(p)) out.push(p);
  }
  return out;
}

// The host that actually serves a URL: its last non-tracker host, or null
// when only trackers are named.
function servingHost(url: string | null | undefined): string | null {
  const hosts = urlHosts(url).filter((h) => !isTracker(h));
  return hosts[hosts.length - 1] ?? null;
}

// The registrable domain, roughly: two labels, three under a two-letter
// country code with a generic second level (abc.net.au, bbc.co.uk).
export function registrableDomain(host: string): string {
  const l = host.split('.');
  if (l.length <= 2) return host;
  const tld = l[l.length - 1]!;
  const sld = l[l.length - 2]!;
  const n = tld.length === 2 && /^(com|net|org|co|gov|edu|ac|id|asn)$/.test(sld) ? 3 : 2;
  return l.slice(-n).join('.');
}

export type AudioHost = { name: string; host: string; dynamicAds: boolean };

// `finalUrl`: where the redirect chain ended, when a fetch has seen it.
export function identifyAudioHost(enclosure: string | null | undefined, finalUrl?: string | null): AudioHost | null {
  const fin = finalUrl ? servingHost(finalUrl) : null;
  const enc = servingHost(enclosure);
  const host = fin ?? enc;
  if (!host) return null;
  const co = (fin && companyOf(fin)) || (enc && companyOf(enc)) || null;
  if (co) return { name: co.name, host, dynamicAds: co.dynamicAds };
  // Self-hosted: the publisher's own domain says more than a generic CDN
  // the chain may end at (cloudfront.net, akamaized.net).
  return { name: registrableDomain(enc ?? host), host, dynamicAds: false };
}

// Any host named anywhere in the URL that inserts ads (trackers skipped).
export function urlHasDynamicAds(url: string | null | undefined): boolean {
  return urlHosts(url).some((h) => !isTracker(h) && !!companyOf(h)?.dynamicAds);
}

// Record what a fetch just learned about an episode's host, writing only
// when it changed (the stream route calls this on every Range request).
export function audioHostUpdate(
  env: Env,
  e: { id: string; enclosure_url: string; audio_host?: string | null; audio_host_url_host?: string | null },
  finalUrl: string,
): D1PreparedStatement | null {
  const h = identifyAudioHost(e.enclosure_url, finalUrl);
  if (!h || (h.name === e.audio_host && h.host === e.audio_host_url_host)) return null;
  e.audio_host = h.name;
  e.audio_host_url_host = h.host;
  return env.DB.prepare('UPDATE podcast_episodes SET audio_host = ?, audio_host_url_host = ? WHERE id = ?').bind(h.name, h.host, e.id);
}

export async function noteAudioHost(
  env: Env,
  e: { id: string; enclosure_url: string; audio_host?: string | null; audio_host_url_host?: string | null },
  finalUrl: string | null | undefined,
): Promise<void> {
  if (!finalUrl) return;
  const st = audioHostUpdate(env, e, finalUrl);
  if (st) await st.run().catch(() => undefined);
}
