import type { Env } from '../types';
import { identifyAudioHost } from '../lib/audio-host';

// /admin's "Ads by host" table (migration 0039): for each audio host, how
// many of the tenant's episodes a fetch has seen it serve, and what the
// analyses of its files found, split by who fetched the bytes ('worker' =
// this Worker's Cloudflare egress, 'pcloud' = an archived copy pCloud
// pulled; 'home' later). Evidence for the home-fetch idea in CLAUDE.md.
export type HostAdRow = {
  name: string;
  via: string;
  seen: number;          // episodes whose audio a fetch saw this host serve (per host, repeated on each via row)
  analysed: number;      // analysed files (one per stitch)
  withInserted: number;  // of those, files with at least one inserted ad
  avgInsertedSeconds: number; // inserted-ad seconds per analysed file
};

export async function hostAdReport(env: Env, tenantId: string): Promise<{ hosts: HostAdRow[] }> {
  const [seenRes, obsRes] = await env.DB.batch([
    env.DB.prepare(
      'SELECT audio_host AS name, count(*) AS n FROM podcast_episodes WHERE tenant_id = ? AND audio_host IS NOT NULL GROUP BY audio_host',
    ).bind(tenantId),
    // Observations backfilled from analyses made before 0039 carry no host:
    // named from the episode, as the wire does.
    env.DB.prepare(
      `SELECT o.host, o.fetched_via AS via, o.inserted_ads AS ins, o.inserted_seconds AS secs, e.audio_host AS ehost, e.enclosure_url AS enc
         FROM episode_ad_observations o LEFT JOIN podcast_episodes e ON e.id = o.episode_id WHERE o.tenant_id = ?`,
    ).bind(tenantId),
  ]);
  const seen = new Map<string, number>();
  for (const r of (seenRes!.results as Array<{ name: string; n: number }>)) seen.set(r.name, r.n);
  const acc = new Map<string, HostAdRow>();
  for (const o of (obsRes!.results as Array<{ host: string | null; via: string; ins: number; secs: number; ehost: string | null; enc: string | null }>)) {
    const name = o.host ?? o.ehost ?? identifyAudioHost(o.enc)?.name ?? 'unknown';
    const k = name + '\u0000' + o.via;
    const row = acc.get(k) ?? { name, via: o.via, seen: 0, analysed: 0, withInserted: 0, avgInsertedSeconds: 0 };
    row.analysed++;
    if (o.ins > 0) row.withInserted++;
    row.avgInsertedSeconds += o.secs; // a sum until the end
    acc.set(k, row);
  }
  for (const name of seen.keys()) {
    if (![...acc.values()].some((r) => r.name === name)) acc.set(name + '\u0000', { name, via: '', seen: 0, analysed: 0, withInserted: 0, avgInsertedSeconds: 0 });
  }
  const hosts = [...acc.values()].map((r) => ({
    ...r, seen: seen.get(r.name) ?? 0,
    avgInsertedSeconds: r.analysed ? Math.round((r.avgInsertedSeconds / r.analysed) * 10) / 10 : 0,
  }));
  hosts.sort((a, b) => b.seen - a.seen || b.analysed - a.analysed || a.name.localeCompare(b.name) || a.via.localeCompare(b.via));
  return { hosts };
}
