// Server-side zip extraction: pCloud → (this DO) → pCloud.
//
// Why a Durable Object and not the request handler: a Worker request gets
// 10 ms of CPU on the Free plan, and inflating a multi-hundred-MB audiobook
// costs real CPU even though DecompressionStream is native. A DO alarm
// handler gets 30 s of CPU per invocation on every plan, runs with no
// browser attached, and survives the admin tab closing. One alarm
// invocation = one zip entry, so the budget resets per file and a failure
// mid-archive leaves the earlier files intact.
//
// Why the bytes go through us at all: pCloud's own extractarchive API is
// broken (3006 on every archive — see src/archive/zip.ts). Only zip is
// handled; rar needs a WASM decoder we don't want to ship, and browser
// uploads already extract rar client-side.
//
// Job identity: one DO per (tenant, folder, archive relPath) via idFromName,
// so the browser polls by the same name it started with and a double-click
// on "extract" can't start two jobs for the same archive.

import type { Env } from '../types';
import {
  pcloudFileLink, pcloudEnsureFolder, pcloudUploadCreate, pcloudUploadWrite,
  pcloudUploadSave, pcloudDeleteFile, type PcloudProfile,
} from '../storage/pcloud';
import { readZipDirectory, zipEntryDataOffset, inflateZipEntry, type ZipEntry } from '../archive/zip';
import { addBookByPath, runScan } from '../scanner/scan';

export type ExtractJobStart = {
  tenantId: string;
  libraryId: string;
  folderId: string;
  profile: PcloudProfile;
  rootPath: string;
  archiveRelPath: string;   // relative to rootPath
  destRelDir: string;       // relative to rootPath; created if missing
  deleteArchive: boolean;
};

type EntryState = {
  name: string;             // path inside the zip
  outRelPath: string;       // relative to rootPath, where it lands
  size: number;             // uncompressed
  status: 'queued' | 'running' | 'done' | 'error' | 'skipped';
  uploaded: number;
  attempts: number;
  itemId?: string;
  error?: string;
  zip: ZipEntry;
};

type Job = ExtractJobStart & {
  status: 'listing' | 'running' | 'done' | 'error';
  startedAt: number;
  finishedAt?: number;
  error?: string;
  entries: EntryState[];
  next: number;
  archiveSize: number;
  scanned?: boolean;
  archiveDeleted?: boolean;
};

// Public status shape: everything except the OAuth token and raw zip records.
export type ExtractJobStatus = Omit<Job, 'profile' | 'entries'> & {
  entries: Array<Omit<EntryState, 'zip'>>;
};

const AUDIO_RE = /\.(m4b|m4a|aac|mp3|opus|ogg|oga|flac)$/i;
const KEEP_RE = /\.(m4b|m4a|aac|mp3|opus|ogg|oga|flac|jpe?g|png)$/i;
const REGISTER_RE = /\.(m4b|m4a|aac)$/i;
const CHUNK = 16 * 1024 * 1024;
// If an alarm invocation dies without returning (CPU/memory kill), this
// backstop alarm re-enters with attempts already bumped.
const WATCHDOG_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;

export class ArchiveExtractDO {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/start') {
      const init = await req.json() as ExtractJobStart;
      const existing = await this.state.storage.get<Job>('job');
      if (existing && (existing.status === 'listing' || existing.status === 'running')) {
        return Response.json(this.publicStatus(existing));
      }
      const job: Job = {
        ...init, status: 'listing', startedAt: Date.now(), entries: [], next: 0, archiveSize: 0,
      };
      await this.state.storage.put('job', job);
      await this.state.storage.setAlarm(Date.now());
      return Response.json(this.publicStatus(job));
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      const job = await this.state.storage.get<Job>('job');
      if (!job) return Response.json({ error: 'No such job' }, { status: 404 });
      return Response.json(this.publicStatus(job));
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  private publicStatus(job: Job): ExtractJobStatus {
    const { profile: _p, entries, ...rest } = job;
    void _p;
    return { ...rest, entries: entries.map(({ zip: _z, ...e }) => { void _z; return e; }) };
  }

  async alarm(): Promise<void> {
    const job = await this.state.storage.get<Job>('job');
    if (!job) return;
    if (job.status === 'listing') return this.list(job);
    if (job.status === 'running') return this.step(job);
  }

  private abs(job: Job, rel: string): string {
    const root = job.rootPath.replace(/\/+$/, '');
    return `${root}/${rel.replace(/^\/+/, '')}`;
  }

  private async save(job: Job): Promise<void> {
    await this.state.storage.put('job', job);
  }

  private async fail(job: Job, msg: string): Promise<void> {
    job.status = 'error';
    job.error = msg;
    job.finishedAt = Date.now();
    await this.save(job);
  }

  // Phase 1: read the central directory and decide what to extract.
  private async list(job: Job): Promise<void> {
    try {
      const link = await pcloudFileLink(job.profile, this.abs(job, job.archiveRelPath));
      const head = await fetch(link, { method: 'HEAD' });
      const total = Number(head.headers.get('content-length') ?? '');
      if (!head.ok || !Number.isFinite(total) || total <= 0) {
        throw new Error(`Could not size the archive (HTTP ${head.status})`);
      }
      job.archiveSize = total;
      const zipEntries = await readZipDirectory((s, e) => rangeRead(link, s, e), total);
      const files = zipEntries.filter((z) => !z.isDir && z.uncompressedSize > 0);
      if (!files.length) throw new Error('Archive contains no files');
      const kept = files.filter((z) => KEEP_RE.test(z.name));
      if (!kept.some((z) => AUDIO_RE.test(z.name))) throw new Error('Archive contains no audio files');
      const enc = kept.find((z) => z.encrypted);
      if (enc) throw new Error(`Archive is encrypted (${enc.name})`);
      const bad = kept.find((z) => z.method !== 0 && z.method !== 8);
      if (bad) throw new Error(`Unsupported compression method ${bad.method} (${bad.name})`);

      // Strip a single shared top-level folder ("Book Name/01.mp3" → "01.mp3")
      // so the book lands at destRelDir rather than destRelDir/Book Name.
      const tops = new Set(kept.map((z) => z.name.split('/')[0]));
      const strip = tops.size === 1 && kept.every((z) => z.name.includes('/')) ? `${[...tops][0]}/` : '';
      job.entries = kept.map((z) => {
        const inner = z.name.slice(strip.length).replace(/^\/+/, '');
        // Defensive: zip names can carry "../"; keep them inside destRelDir.
        const safe = inner.split('/').filter((s) => s && s !== '..').join('/');
        return {
          name: z.name, outRelPath: `${job.destRelDir.replace(/\/+$/, '')}/${safe}`,
          size: z.uncompressedSize, status: 'queued', uploaded: 0, attempts: 0, zip: z,
        };
      });
      job.status = 'running';
      await this.save(job);
      await this.state.storage.setAlarm(Date.now());
    } catch (e) {
      await this.fail(job, (e as Error).message);
    }
  }

  // Phase 2: one entry per alarm.
  private async step(job: Job): Promise<void> {
    const entry = job.entries[job.next];
    if (!entry) return this.finish(job);

    if (entry.attempts >= MAX_ATTEMPTS) {
      entry.status = 'error';
      entry.error = entry.error ?? 'Gave up after repeated failures';
      job.next += 1;
      await this.save(job);
      await this.state.storage.setAlarm(Date.now());
      return;
    }
    entry.attempts += 1;
    entry.status = 'running';
    entry.uploaded = 0;
    await this.save(job);
    await this.state.storage.setAlarm(Date.now() + WATCHDOG_MS);

    try {
      const link = await pcloudFileLink(job.profile, this.abs(job, job.archiveRelPath));
      const dataOff = await zipEntryDataOffset((s, e) => rangeRead(link, s, e), entry.zip);
      const res = await fetch(link, {
        headers: { Range: `bytes=${dataOff}-${dataOff + entry.zip.compressedSize - 1}` },
      });
      if (res.status !== 206 || !res.body) throw new Error(`Range read failed: HTTP ${res.status}`);
      const stream = inflateZipEntry(entry.zip, res.body);

      const outAbs = this.abs(job, entry.outRelPath);
      const outDir = outAbs.slice(0, outAbs.lastIndexOf('/'));
      await pcloudEnsureFolder(job.profile, outDir);

      // Re-chunk the decompressed stream into bounded PUTs. pCloud rejects
      // chunked transfer-encoding, so each write needs a known length, and
      // a single multi-hundred-MB PUT is an untested shape — 16 MB pieces
      // match what the browser upload path already exercises.
      const uploadId = await pcloudUploadCreate(job.profile);
      let offset = 0;
      for await (const piece of chunked(stream, CHUNK)) {
        await pcloudUploadWrite(job.profile, { uploadId, offset, body: piece, contentLength: piece.byteLength });
        offset += piece.byteLength;
        entry.uploaded = offset;
        await this.save(job);
      }
      if (offset !== entry.size) {
        throw new Error(`Decompressed ${offset} bytes, expected ${entry.size}`);
      }
      const saved = await pcloudUploadSave(job.profile, { uploadId, path: outAbs });

      if (REGISTER_RE.test(entry.outRelPath)) {
        try {
          const hints: { sizeBytes?: number } = {};
          if (saved.metadata?.size != null) hints.sizeBytes = saved.metadata.size;
          const r = await addBookByPath(this.env, job.libraryId, entry.outRelPath, job.tenantId, hints);
          if (r.itemId) entry.itemId = r.itemId;
        } catch (e) {
          // Extraction succeeded; registration is recoverable via scan.
          entry.error = `Extracted but not registered: ${(e as Error).message}`;
        }
      }
      entry.status = 'done';
    } catch (e) {
      entry.error = (e as Error).message;
      entry.status = 'queued';
      // Leave job.next alone so the retry hits this entry again.
      await this.save(job);
      await this.state.storage.setAlarm(Date.now() + 2000);
      return;
    }
    job.next += 1;
    await this.save(job);
    await this.state.storage.setAlarm(Date.now());
  }

  private async finish(job: Job): Promise<void> {
    const errors = job.entries.filter((e) => e.status === 'error');
    // Chaptered-MP3 sets (or anything the single-file registrar skipped)
    // become a library item through the normal scanner.
    const needsScan = job.entries.some((e) => e.status === 'done' && AUDIO_RE.test(e.outRelPath) && !e.itemId);
    if (needsScan && !job.scanned) {
      try {
        await runScan(this.env, job.libraryId, job.tenantId);
      } catch (e) {
        job.error = `Extracted, but library scan failed: ${(e as Error).message}`;
      }
      job.scanned = true;
    }
    if (!errors.length && job.deleteArchive && !job.archiveDeleted) {
      try {
        await pcloudDeleteFile(job.profile, this.abs(job, job.archiveRelPath));
        job.archiveDeleted = true;
      } catch (e) {
        job.error = `Extracted, but could not delete the archive: ${(e as Error).message}`;
      }
    }
    job.status = errors.length ? 'error' : 'done';
    if (errors.length && !job.error) job.error = `${errors.length} file(s) failed — archive kept in pCloud`;
    job.finishedAt = Date.now();
    await this.save(job);
  }
}

async function rangeRead(link: string, start: number, end: number): Promise<Uint8Array> {
  const res = await fetch(link, { headers: { Range: `bytes=${start}-${end - 1}` } });
  if (res.status !== 206) throw new Error(`Range read failed: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength !== end - start) throw new Error(`Range read short: got ${buf.byteLength}, wanted ${end - start}`);
  return buf;
}

// Coalesce a byte stream into pieces of exactly `size` (last one shorter).
async function* chunked(stream: ReadableStream<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let parts: Uint8Array[] = [];
  let have = 0;
  const flush = (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    let o = 0;
    const rest: Uint8Array[] = [];
    for (const p of parts) {
      if (o >= n) { rest.push(p); continue; }
      const take = Math.min(p.byteLength, n - o);
      out.set(p.subarray(0, take), o);
      o += take;
      if (take < p.byteLength) rest.push(p.subarray(take));
    }
    parts = rest;
    have -= n;
    return out;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    have += value.byteLength;
    while (have >= size) yield flush(size);
  }
  if (have > 0) yield flush(have);
}
