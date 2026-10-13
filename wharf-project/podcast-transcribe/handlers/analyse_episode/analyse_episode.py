#!/usr/bin/env python3
"""wharf handler `analyse_episode` (project `podcast-transcribe`).

Transcribes one podcast episode exactly as the shim serves it, maps the
publisher's transcript and chapter times onto that file, finds inserted ads,
and (when asked) labels ad reads and cuts chapters with an LLM.

stdin, built by the shim (the contract; see README.md):
  {
    "episodeId": "...", "libraryItemId": "li_...",
    "sizeBytes": 71169166,              # what the shim last saw; may be stale or 0
    "audioUrl": "https://abs-shim.jderrick.app/api/items/<libraryItemId>/file/<ino>",
    "token": "<20-minute shim access token minted for this job>",
    "transcripts": [{"url", "type", "language"}],   # publisher's, ranked, master time
    "chapters": [{"start", "title"}] | null,          # publisher's, master time
    "title": "...", "showNotes": "<p>...</p>",
    "show": "...", "dynamicAds": true,  # optional, for the LLM prompt (shim since 2026-10-14)
    "wantLlm": false,
    "resultUrl": "https://abs-shim.jderrick.app/..."  # POSTed the result, same bearer
  }
stdout: exactly one JSON object, the result (the shape of the prototype's
out/*.result.json, size reported as `sizeBytes`; plus `_wharf: {cost_usd}`,
what the job's OpenRouter calls cost, whenever it made any). It is also
POSTed to resultUrl; printing it is what lets the shim poll the job instead.
stderr: progress, i.e. the job log. Never the token.

The audio MUST come through the shim: ad-inserting hosts stitch a different
file per requester IP and User-Agent, and only the Worker's own fetch yields
the file listeners are served. Hence the token, which is sent only to the
hosts the shim named, never over plain http off this machine, and never
across a redirect to another host.

Idempotent: everything lives in scratch/<job>/ (removed, and cleanup_dirs
removes scratch/ after every run); the shim keys results by (episode, size).

A registered handler: wharf runs an approved, hash-pinned COPY of this file
from state/registered/, with cwd = the project dir, so everything else
(handlers/_lib, data/models, scratch/) is found from AGENT_PROJECT_DIR / the
cwd, never from __file__. Standard library only: no venv on any node. The
nodes run WHARF_ENV_PASSTHROUGH=strict; the only .env keys read are the ones
the manifest lists (OPENROUTER_API_KEY, OPENROUTER_MODEL, OPENROUTER_REASONING,
WHISPER_MODEL_DIR, WHISPER_MODEL, WHISPER_MODEL_READ).
"""
import json, os, platform, re, shutil, subprocess, sys, tempfile, time
import urllib.error, urllib.parse, urllib.request

PROJECT = os.environ.get('AGENT_PROJECT_DIR') or os.getcwd()
MODELS = os.path.join(PROJECT, 'data', 'models')   # the project's own (the Mac's base.en)
IS_MAC = platform.system() == 'Darwin'
sys.path.insert(0, os.path.join(PROJECT, 'handlers', '_lib'))

UA = 'podcast-transcribe/1 (wharf; abs-shim episode analysis)'
MAX_AUDIO = 1 << 30            # 1 GB: a 5-hour 128 kbps episode is ~290 MB
MAX_TRANSCRIPT = 20 << 20
MIN_CUES = 20                  # fewer than this and it isn't a transcript worth aligning to
TEXTUAL = ('text/plain', 'text/html', 'application/xhtml')   # no times: can't align


T0 = time.time()


def log(msg):
    print(f'[{time.strftime("%H:%M:%S")} +{time.time() - T0:6.1f}s] {msg}', file=sys.stderr, flush=True)


def tool(name):
    """By name on the handler PATH (the Mac node's starts with
    /opt/homebrew/bin; Linux nodes' is /usr/local/bin:/usr/bin:/bin), with
    the project's own bin/ first, for a node that ships its own build (the
    planned no-AVX whisper-cli on stereo-au)."""
    path = os.pathsep.join([os.path.join(PROJECT, 'bin'), os.environ.get('PATH') or '/usr/local/bin:/usr/bin:/bin'])
    found = shutil.which(name, path=path)
    if not found:
        raise RuntimeError(f'{name} not found on PATH ({path})')
    return found


def redact(url):
    """For the log: scheme, host and path only (a query could carry a signature)."""
    u = urllib.parse.urlsplit(url)
    return f'{u.scheme}://{u.netloc}{u.path}'


# ── HTTP with the job token ──────────────────────────────────────────────────

def _origin(url):
    u = urllib.parse.urlsplit(url)
    return (u.scheme.lower(), (u.hostname or '').lower(), u.port)


def check_token_target(url):
    """The token goes over https, or plain http only to this machine (tests)."""
    scheme, host, _ = _origin(url)
    if scheme == 'https' or (scheme == 'http' and host in ('127.0.0.1', 'localhost', '::1')):
        return
    raise RuntimeError(f'refusing to send the job token to {scheme}://{host} (https only)')


class SameOriginRedirects(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only to the same scheme+host+port. urllib copies the
    Authorization header onto the redirected request, so a cross-host
    redirect would hand the token to someone else."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if _origin(newurl) != _origin(req.full_url):
            raise urllib.error.HTTPError(req.full_url, code,
                                         f'refusing redirect to {redact(newurl)} with the job token', headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


AUTHED = urllib.request.build_opener(SameOriginRedirects)


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, f'unexpected redirect to {redact(newurl)}', headers, fp)


POSTER = urllib.request.build_opener(NoRedirects)


def download_audio(url, token, dest, attempts=3):
    check_token_target(url)
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Authorization': f'Bearer {token}'})
            with AUTHED.open(req, timeout=120) as r, open(dest, 'wb') as f:
                total = r.headers.get('Content-Length')
                n = 0
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    n += len(chunk)
                    if n > MAX_AUDIO:
                        raise RuntimeError(f'audio larger than {MAX_AUDIO} bytes')
                    f.write(chunk)
            if total and int(total) != n:
                raise RuntimeError(f'short download: {n} of {total} bytes')
            return n
        except urllib.error.HTTPError as e:
            if 300 <= e.code < 400:   # SameOriginRedirects refused it; retrying changes nothing
                raise RuntimeError(f'audio fetch: {e.msg}') from None
            if e.code in (401, 403, 404, 410):
                raise RuntimeError(f'audio fetch: HTTP {e.code} from {redact(url)}') from None
            last = f'HTTP {e.code}'
        except (urllib.error.URLError, TimeoutError, ConnectionError, RuntimeError) as e:
            if isinstance(e, RuntimeError) and 'larger than' in str(e):
                raise
            last = str(getattr(e, 'reason', e))
        if i + 1 < attempts:
            log(f'audio fetch failed ({last}); retrying')
            time.sleep(5 * (i + 1))
    raise RuntimeError(f'audio fetch failed after {attempts} attempts: {last}')


def post_result(url, token, body, attempts=4):
    """POST the result with the job token. 2xx = delivered. 408/429/5xx and
    network errors are retried (3 retries, backoff); any other 4xx is final.
    Returns (delivered, status-or-error)."""
    try:
        check_token_target(url)
    except RuntimeError as e:
        return False, str(e)
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, data=body, method='POST', headers={
                'User-Agent': UA, 'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
            with POSTER.open(req, timeout=60) as r:
                r.read(4096)
                return True, r.status
        except urllib.error.HTTPError as e:
            last = e.code
            if e.code not in (408, 429) and e.code < 500:
                return False, e.code
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = str(getattr(e, 'reason', e))
        if i + 1 < attempts:
            wait = (5, 20, 60)[min(i, 2)]
            log(f'result POST failed ({last}); retry {i + 1}/{attempts - 1} in {wait}s')
            time.sleep(wait)
    return False, last


def fetch_public(url, limit=MAX_TRANSCRIPT):
    """A publisher's transcript: public, no token, redirects allowed."""
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': '*/*'})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read(limit + 1)
        ctype = r.headers.get('Content-Type') or ''
    if len(body) > limit:
        raise RuntimeError('transcript too large')
    return body.decode('utf-8', errors='replace'), ctype


# ── the job ──────────────────────────────────────────────────────────────────

def pick_transcript(A, links, duration):
    """The first publisher transcript in the shim's ranking that parses into
    timed cues (VTT/SRT/JSON). Text and HTML carry no times."""
    for t in links or []:
        url, ctype = (t or {}).get('url'), ((t or {}).get('type') or '').lower()
        if not url or ctype.startswith(TEXTUAL):
            continue
        try:
            body, served = fetch_public(url)
        except Exception as e:   # noqa: BLE001 - try the next link
            log(f'transcript {redact(url)}: {e}')
            continue
        cues = A.parse_transcript(body, ctype or served, duration)
        if len(cues) >= MIN_CUES:
            log(f'transcript: {len(cues)} cues from {redact(url)} ({ctype or served})')
            return cues, {'url': url, 'type': ctype or served, 'language': t.get('language')}
        log(f'transcript {redact(url)}: {len(cues)} timed cues, skipped')
    return None, None


# Which whisper model, by node and by what the transcript is for (README
# "Which model"). "align": a publisher transcript exists, whisper only has to
# supply anchors. "read": whisper's transcript is the one listeners will see.
# First one found wins.
# Mac (Metal, LUP 688, 74 min, back to back on 2026-10-13): base.en 81 s,
# large-v3-turbo 171 s (417 s while other apps loaded the GPU), and turbo
# moved no offset by more than 0.23 s. So base.en to align, turbo when
# people will read the text.
# CPU nodes (stereo-au: base.en ~80 min per hour of audio, tiny.en ~30):
# tiny.en is enough to align; base.en, greedy, for a transcript people read;
# never small.en.
DEFAULT_MODELS = {
    (True, 'align'): ('base.en', 'large-v3-turbo'),
    (True, 'read'): ('large-v3-turbo', 'base.en'),
    (False, 'align'): ('tiny.en', 'base.en'),
    (False, 'read'): ('base.en', 'tiny.en'),
}


def model_dirs():
    """WHISPER_MODEL_DIR from .env (the node's shared models: the Mac's
    /opt/wharf/share/whisper, stereo-au's /usr/local/share/whisper), then the
    project's own data/models."""
    d = os.environ.get('WHISPER_MODEL_DIR', '').strip()
    return [x for x in (d, MODELS) if x]


def model_file(name):
    """A model name ("base.en", "large-v3-turbo", or a ggml-*.bin filename)
    → its path in model_dirs(), or None."""
    fn = name if name.endswith('.bin') else f'ggml-{name}.bin'
    if not re.fullmatch(r'[A-Za-z0-9._-]+', fn):
        raise RuntimeError(f'bad model name {name!r}')
    for d in model_dirs():
        if os.path.isfile(os.path.join(d, fn)):
            return os.path.join(d, fn)
    return None


def pick_model(arg, purpose):
    """(short name, path, where the choice came from). purpose is "align" or
    "read". .env wins: WHISPER_MODEL_READ (read only), then WHISPER_MODEL (a
    name, or an absolute path to a ggml .bin); then the job's `model` arg;
    then DEFAULT_MODELS for this kind of node."""
    for var in (('WHISPER_MODEL_READ', 'WHISPER_MODEL') if purpose == 'read' else ('WHISPER_MODEL',)):
        v = os.environ.get(var, '').strip()
        if v:
            path = v if os.path.isabs(v) else model_file(v)
            if not path or not os.path.isfile(path):
                raise RuntimeError(f'{var}={v} not found (looked in {model_dirs()})')
            break
    else:
        var = None
        if arg:
            path = model_file(str(arg))
            if not path:
                raise RuntimeError(f'model {arg!r} not found (looked in {model_dirs()})')
            var = 'args.model'
        else:
            names = DEFAULT_MODELS[(IS_MAC, purpose)]
            path = next((p for p in map(model_file, names) if p), None)
            if not path:
                raise RuntimeError(f'no whisper model: none of {names} in {model_dirs()} '
                                   f'(set WHISPER_MODEL_DIR in .env, or run install.sh)')
            var = 'default'
    name = os.path.basename(path)
    name = name[5:] if name.startswith('ggml-') else name
    return (name[:-4] if name.endswith('.bin') else name), path, var


STYLE_PROMPT = 'Hello, and welcome to the show. Today we have a lot to talk about.'


def run_whisper(model_path, wav, out_base, threads):
    gpu = IS_MAC
    # No -np: whisper's own stderr (to a file, not the job log) is the only
    # place that says which backend it picked ("using MTL0 backend").
    cmd = [tool('whisper-cli'), '-m', model_path, '-f', wav, '-t', str(threads), '-ojf', '-of', out_base]
    if not gpu:
        cmd += ['-bs', '1', '-bo', '1']   # greedy: 2-3x faster on CPU, same alignment (NOTES.md)
    if not os.path.basename(model_path).endswith('.en.bin'):
        # large-v3-turbo with no prompt wrote Fish entirely in lower case with
        # no punctuation (0% of cues, 2026-10-13); a style prompt fixes it
        # (99% on a LUP slice, same speed). The .en models punctuate anyway
        # and are left exactly as the alignment was validated.
        cmd += ['--prompt', STYLE_PROMPT]
    with open(out_base + '.stderr', 'w') as err:
        p = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=err)
    errtext = open(out_base + '.stderr', errors='replace').read()
    if p.returncode != 0:
        raise RuntimeError(f'whisper-cli exited {p.returncode}: {errtext[-600:].strip()}')
    m = re.search(r'whisper_backend_init_gpu: using (\S+) backend', errtext)
    backend = ('metal' if m.group(1).startswith('MTL') else m.group(1).lower()) if m else 'cpu'
    with open(out_base + '.json', encoding='utf-8') as f:
        return json.load(f), backend


def main():
    raw = sys.stdin.read()
    args = json.loads(raw) if raw.strip() else {}
    for k in ('episodeId', 'audioUrl', 'token'):
        if not args.get(k):
            raise SystemExit(f'ERROR: missing required arg {k!r}')
    import align as A        # noqa: E402  handlers/_lib
    import llm_pass as L     # noqa: E402

    token = args['token']
    timings = {}
    ffmpeg, ffprobe, whisper = tool('ffmpeg'), tool('ffprobe'), tool('whisper-cli')   # fail before downloading
    log(f"episode {args['episodeId']} ({args.get('title') or 'untitled'}) on node "
        f"{os.environ.get('WHARF_NODE_ID', '?')}, job {os.environ.get('WHARF_JOB_ID', '?')}")

    scratch = os.path.join(PROJECT, 'scratch')
    os.makedirs(scratch, exist_ok=True)
    work = tempfile.mkdtemp(prefix=f"{os.environ.get('WHARF_JOB_ID', 'job')[:13]}-", dir=scratch)
    try:
        audio = os.path.join(work, 'episode.audio')
        t = time.time()
        size = download_audio(args['audioUrl'], token, audio)
        timings['download'] = round(time.time() - t, 2)
        expected = args.get('sizeBytes') or None
        note = '' if not expected or expected == size else f' (the shim expected {expected}: a different stitch, analysed as measured)'
        log(f"audio: {size} bytes from {redact(args['audioUrl'])} in {timings['download']}s{note}")

        t = time.time()
        dur = float(subprocess.run([ffprobe, '-v', 'error', '-show_entries', 'format=duration',
                                    '-of', 'default=nw=1:nk=1', audio],
                                   capture_output=True, text=True, check=True).stdout.strip())
        wav = os.path.join(work, 'episode.wav')
        subprocess.run([ffmpeg, '-nostdin', '-v', 'error', '-y', '-i', audio, '-ar', '16000', '-ac', '1',
                        '-c:a', 'pcm_s16le', wav], check=True)
        timings['decode'] = round(time.time() - t, 2)
        log(f'decoded {dur:.1f}s of audio to 16 kHz mono in {timings["decode"]}s')

        t = time.time()
        cues, tr_link = pick_transcript(A, args.get('transcripts'), dur)
        timings['transcriptFetch'] = round(time.time() - t, 2)

        purpose = 'align' if cues is not None else 'read'
        model, model_path, chosen_by = pick_model(args.get('model'), purpose)
        # Metal does the work on the Mac; on a shared Linux box (stereo-au runs
        # a live PBX) four threads, under the manifest's cpu_quota_pct.
        threads = min(8, os.cpu_count() or 4) if IS_MAC else 4
        t = time.time()
        wj, backend = run_whisper(model_path, wav, os.path.join(work, 'whisper'), threads)
        timings['whisper'] = round(time.time() - t, 2)
        log(f'whisper {model} ({backend}, {threads} threads{"" if IS_MAC else ", greedy"}; {purpose}, {chosen_by}): '
            f'{timings["whisper"]}s for {dur:.0f}s of audio ({timings["whisper"] / max(dur, 1) * 3600:.0f}s per hour)')
        sw = A.whisper_words(wj)

        result = {'version': 1, 'episodeId': args['episodeId'], 'libraryItemId': args.get('libraryItemId'),
                  'sizeBytes': size, 'requestedSizeBytes': expected, 'duration': round(dur, 3),
                  'model': model, 'llmModel': None,
                  'offsets': [], 'cuts': [], 'ads': [], 'chapters': [], 'transcript': None,
                  'stats': {'node': os.environ.get('WHARF_NODE_ID'), 'whisperBackend': backend,
                            'whisperThreads': threads, 'whisperFor': purpose, 'whisperModelChosenBy': chosen_by,
                            'words': len(sw)}, 'timings': timings}
        pub_ch = []
        for c in args.get('chapters') or []:
            try:
                pub_ch.append({'start': float(c['start']), 'title': str(c.get('title') or '').strip()})
            except (KeyError, TypeError, ValueError):
                continue
        pub_ch.sort(key=lambda c: c['start'])

        t = time.time()
        if cues is not None:
            offsets, cuts, ads, stats = A.align(sw, A.master_words(cues), dur)
            result.update(offsets=offsets, cuts=cuts, ads=ads)
            result['stats'].update(stats, transcriptUrl=tr_link['url'], transcriptType=tr_link['type'])
            result['transcript'] = {'source': 'publisher', 'cues': A.shift_cues(cues, offsets, cuts)}
            result['chapters'] = A.shift_chapters(pub_ch, offsets, cuts)
            result['stats']['chaptersAligned'] = bool(pub_ch)
            log(f'aligned: {len(offsets)} offset runs {[o["shift"] for o in offsets]}, {len(cuts)} cuts, '
                f'{len(ads)} inserted ads, {stats["served_seconds_aligned"]}s of {dur:.0f}s matched')
        else:
            result['transcript'] = {'source': 'whisper', 'cues': A.whisper_cues(wj)}
            result['chapters'] = [{**c, 'source': 'publisher'} for c in pub_ch]
            result['stats']['chaptersAligned'] = False
            log('no usable publisher transcript: whisper transcript, nothing to align'
                + (f', {len(pub_ch)} publisher chapters passed through unaligned' if pub_ch else ''))
        timings['align'] = round(time.time() - t, 2)

        # `llm` says what happened to the LLM step whenever it was asked for:
        # "ok", or "skipped: no OPENROUTER_API_KEY" / "error: ..." with the
        # same text in llmError. Either way the alignment above is delivered.
        # What the job spent at OpenRouter, every call counted (retries and
        # failed answers included): reported as `_wharf.cost_usd`, wharf
        # v0.2.23's per-job cost, whenever a call was made.
        spend = {'calls': 0, 'usd': 0.0}
        if args.get('wantLlm'):
            t = time.time()
            try:
                dyn = args.get('dynamicAds')   # the shim's hasDynamicAds(); absent from older shims
                llm_ads, llm_ch, meta = L.analyse(wj, dur, show=args.get('show') or args.get('showTitle') or '',
                                                  title=args.get('title') or '', notes=args.get('showNotes') or '',
                                                  dynamic_ads=dyn if isinstance(dyn, bool) else None, spend=spend)
                for ad in llm_ads:   # an LLM ad overlapping an aligned one adds nothing
                    if not any(x['start'] < ad['end'] and ad['start'] < x['end'] for x in result['ads']):
                        result['ads'].append({**ad, 'source': 'llm'})
                if not result['chapters']:
                    result['chapters'] = [{**c, 'source': 'llm'} for c in llm_ch]
                result['llm'] = 'ok'
                result['llmModel'] = meta.get('model')
                result['stats']['llm'] = meta
                log(f"llm {meta.get('model')} via openrouter (reasoning {meta.get('reasoning')}): {len(llm_ads)} ads, "
                    f"{len(llm_ch)} chapters, usage {meta.get('usage')}, cost {meta.get('costUsd')}")
            except L.NoApiKey:
                result['llm'] = result['llmError'] = 'skipped: no OPENROUTER_API_KEY'
                log('llm skipped: no OPENROUTER_API_KEY in the project .env (no LLM ads or chapters in this result)')
            except Exception as e:   # noqa: BLE001 - the alignment is worth delivering without it
                result['llm'] = result['llmError'] = f'error: {str(e)[:400]}'
                log(f'llm failed, result has no LLM ads/chapters: {e}')
            timings['llm'] = round(time.time() - t, 2)
        if spend['calls']:
            result['_wharf'] = {'cost_usd': round(spend['usd'], 8)}
            log(f"openrouter: {spend['calls']} call(s), ${spend['usd']:.6f}")
        result['ads'].sort(key=lambda x: x['start'])
        timings['total'] = round(time.time() - T0, 2)

        body = json.dumps(result, ensure_ascii=False).encode('utf-8')
        if args.get('resultUrl'):
            t = time.time()
            ok, status = post_result(args['resultUrl'], token, body)
            log(f"result ({len(body)} bytes) {'delivered' if ok else 'NOT delivered'} to "
                f"{redact(args['resultUrl'])}: {status} in {time.time() - t:.1f}s"
                + ('' if ok else '; the job result (stdout) still carries it'))
        sys.stdout.buffer.write(body + b'\n')
        sys.stdout.flush()
        log(f'done in {timings["total"]}s')
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:   # noqa: BLE001 - one clear last line for JobResponse.error
        log(f'ERROR: {type(e).__name__}: {e}')
        sys.exit(1)
