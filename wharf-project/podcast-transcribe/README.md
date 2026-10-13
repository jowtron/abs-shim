# podcast-transcribe — episode analysis on wharf

A wharf project with one handler, `analyse_episode`, that transcribes a podcast episode **exactly as the shim serves it** (whisper.cpp), maps the publisher's transcript and chapter times onto that ad-stitched file, finds the inserted ads, and, when asked, labels ad reads and cuts chapters with an LLM. Why it exists: ad-inserting hosts (art19, Audioboom, Simplecast) stitch a different mp3 per requester, so the feed's chapter and transcript times run early by the ads played so far (shim CLAUDE.md, "Dynamic ad insertion breaks every published time"). The design is the scratchpad `DESIGN.md` of 2026-10-13; this directory is the node side of it.

## Nodes

Two islands carry the same project id, `podcast-transcribe`; the router tries them in order (failover at submit time only). Everything about the nodes themselves — install, update, restart (which kills running jobs), logs, sleep, tunnels — belongs to the wharf session: for the Mac see the wharf repo's **`deploy/README-MACOS.md`**. This README covers the project.

| | `mac` (primary) | `stereo-au` (fallback) |
|---|---|---|
| node | Joseph's M1 Max; system LaunchDaemon `com.jowtron.wharfd` | Celeron J3455, 4 cores, no AVX, FCOS; systemd `wharfd`; also runs a live lab PBX and the Kodi kiosk |
| project dir | `/opt/wharf/projects/podcast-transcribe`, owned `_wharf` | `/srv/wharf/projects/podcast-transcribe`, owned `wharf` |
| install | `sudo ./install.sh mac` (Joseph, in a Terminal) | `./install.sh stereo-au` (over SSH as `core`; deployed 2026-10-13) |
| tools (handler PATH) | Homebrew: `whisper-cli` (Metal), `ffmpeg`, `ffprobe`, `python3` 3.14 | `/usr/local/bin`: no-AVX `whisper-cli` 1.9.5, static `ffmpeg`/`ffprobe`; `python3` 3.14 |
| `WHISPER_MODEL_DIR` | `/opt/wharf/share/whisper` (large-v3-turbo); base.en in the project's `data/models` | `/usr/local/share/whisper` (tiny.en, base.en) |
| model, publisher transcript (align) | base.en | tiny.en |
| model, no publisher transcript (read) | large-v3-turbo, with a style prompt | base.en |
| decoding, threads | beam (whisper default), Metal, `-t 8` | greedy, `-t 4`, `cpu_quota_pct: 300` |
| whisper time per hour of audio | align ~66 s; read ~140 s (measured; ~2.5x when other apps load the GPU) | align ~30 min; read ~80 min (the wharf session's measurement) |

**The shim scales its lost-job timeout per island**: a stereo-au job can legitimately run for an hour or more, a Mac job a few minutes, so a single "unfinished after N minutes means lost" would either resubmit live stereo-au jobs or wait far too long on a sleeping Mac.

Both nodes run `WHARF_ENV_PASSTHROUGH=strict`: only `.env` keys listed in the manifest's `env_passthrough` reach the handler. There are no per-job limits on macOS; on stereo-au the manifest's `max_memory_mb: 2048` and `cpu_quota_pct: 300` are enforced by systemd-run. The router credentials (`router-mac` and stereo-au's) already list this project; the routes row is the wharf session's to add.

An earlier install of mine on the Mac (a per-user LaunchAgent `app.jderrick.wharfd` with `~/wharf` and port 8093) was removed on 2026-10-13 in favour of the wharf session's node: there must be one wharfd on the Mac.

## Layout

This directory is what install.sh copies to a node:

| path | |
|---|---|
| `project.toml` | `[slots] total = 1`, queue depth 16 |
| `handlers/analyse_episode/analyse_episode.{py,yaml}` | the handler and its manifest, **registered and approved** (it sits in a subdirectory so wharf's on-disk scan doesn't pick it up and shadow the approved copy) |
| `handlers/_lib/align.py` | the alignment (the prototype algorithm, plus a body-based transcript parser and a duration-checked hour-offset fix) |
| `handlers/_lib/llm_pass.py` | the LLM step, plain HTTPS to OpenRouter |
| `.env.example` | becomes the node's `.env` on first install |
| `install.sh`, `README.md` | |

On a node it also gets `.env` (0600), `scratch/<job>/` while a job runs, `logs/jobs/<date>/<job>.log`, and on the Mac `data/models/ggml-base.en.bin` (148 MB, fetched and sha256-checked by install.sh, not in git). Everything is standard-library Python: **no venv, no pip**, on any node.

wharf runs an approved handler from a hash-pinned copy in `state/registered/`, with the project dir as its working directory, so the handler finds `_lib`, `data/models` and `scratch/` from there, never from `__file__`. Consequence: a change to the handler script only takes effect when install.sh re-registers and re-approves it; a change to `handlers/_lib/` takes effect as soon as it is copied.

## Install and update

```bash
cd ~/Claude_Code/ABS_shim/wharf-project/podcast-transcribe
sudo ./install.sh mac        # Joseph, in a Terminal
./install.sh stereo-au       # from the Mac, over SSH as core@100.121.86.110
```

Each is one idempotent command that prints every step. It rsyncs this directory into the node's project dir (leaving the node's `.env`, `data/`, `scratch/` and `logs/` alone), on the Mac puts `data/models/ggml-base.en.bin` in place with a sha256 check (skipped when present; `MODEL_SRC=<dir>` copies it from a local folder instead of Hugging Face), chowns everything to the daemon's user, creates `.env` from `.env.example` with that node's `WHISPER_MODEL_DIR` if there is none (0600; an existing `.env` is never touched), then runs `wharf reload-projects`, `wharf handler register`, `wharf handler approve --hash <64-hex hash>`, `reload-projects` again, and shows the handler list and project as the daemon sees them. On the Mac every wharf CLI call runs as `_wharf` (`sudo -u _wharf /opt/wharf/bin/wharf …`: under plain sudo the CLI writes root-owned files the daemon can't read); on stereo-au it uses `sudo /srv/wharf/bin/wharf …`, as the audible project does there. It **reloads, never restarts** wharfd (on stereo-au a restart would also bounce the lab PBX's ESL forwarder), and touches nothing outside the project directory. Re-run it after any change here.

After the first `sudo ./install.sh mac`, **ask the wharf session to add the routes row** (`podcast-transcribe` → `["mac", "stereo-au"]`); nothing in this project or the shim does that.

Checks: `sudo -u _wharf /opt/wharf/bin/wharf handler list podcast-transcribe` on the Mac, `sudo /srv/wharf/bin/wharf handler list podcast-transcribe` on stereo-au (APPROVED true, REQUIRES whisper,ffmpeg), and `wharf handler env podcast-transcribe/analyse_episode` for the exact environment a job gets. `project show` says "Handlers (0)": it counts on-disk handlers only, and this one is registered.

Developing without sudo: `./install.sh --dest <dir>` copies the project, the base.en model and a Mac `.env` into `<dir>` and touches no node; see "Testing by hand".

## `.env` keys

Owned by the daemon's user, mode 600. Edit as that user, then reload (wharfd reads `.env` when it loads the project): `sudo -u _wharf vi /opt/wharf/projects/podcast-transcribe/.env && sudo -u _wharf /opt/wharf/bin/wharf reload-projects` on the Mac; `sudo -u wharf vi /srv/wharf/projects/podcast-transcribe/.env && sudo /srv/wharf/bin/wharf reload-projects` on stereo-au. All six keys are in the manifest's `env_passthrough`; nothing else is read. `.env.example` holds placeholders only; the wharf session will say where the real OpenRouter key comes from.

| key | |
|---|---|
| `OPENROUTER_API_KEY` | enables the LLM step. Unset (today, both nodes): jobs still complete, and a `wantLlm` result carries `llm` and `llmError` = `"skipped: no OPENROUTER_API_KEY"` and no LLM ads or chapters |
| `OPENROUTER_MODEL` | OpenRouter slug, default `anthropic/claude-sonnet-5` |
| `OPENROUTER_REASONING` | `low` (default), `medium`, `high`, `off` or `default` (send no reasoning param); see the LLM step for why this matters |
| `WHISPER_MODEL_DIR` | the node's shared whisper models; install.sh sets it. The project's `data/models` is searched after it |
| `WHISPER_MODEL` | model override for every job: a name (`tiny.en`, `base.en`, `large-v3-turbo`) or an absolute path to a ggml `.bin` |
| `WHISPER_MODEL_READ` | model override for jobs with no publisher transcript only (wins over `WHISPER_MODEL` there) |

## Which model

Measured on the Mac on 2026-10-13 with LINUX Unplugged 688 (74.0 min, 71,169,166 bytes, the publisher's VTT), whisper's wall time inside the handler:

| model | quiet machine | other apps on the GPU | alignment |
|---|---|---|---|
| base.en | **81.5 s** (66 s/h) | 145 s | offsets +89.76 / +27.14 s, cut 950.06-1012.68, pre-roll 0-89.76 (identical to the prototype) |
| large-v3-turbo | **170.6 s** (138 s/h) | 417 s | +89.79 / +26.91 s, cut 949.93-1012.81, pre-roll 0-89.79; chapters within 0.4 s |

A 10-minute slice timed back to back said the same: base.en 12.0-14.5 s, turbo 20.9 s warm (69.7 s cold, loading 1.6 GB).

So, on the Mac: **base.en when there is a publisher transcript** — alignment only needs anchors, turbo doubles the time and moved no offset by more than 0.23 s — and **large-v3-turbo when whisper's transcript is the one listeners read**. On Fish ("Peanut Podcast", 33 min) turbo's text was clearly better ("they might have rights issues if they're playing entire songs" where base.en heard "if the blanket tie a song") in 80.7 s, against base.en's 32.5 s. One catch, now handled: with no prompt turbo wrote that whole episode in lower case without a single punctuation mark (0% of cues; base.en 96%). The handler therefore passes a generic style prompt (`--prompt "Hello, and welcome to the show. …"`) to the multilingual models only, which brought it to 93% on Fish and 99% on a LUP slice at the same speed; the `.en` models are left exactly as the alignment was validated. Turbo stays under the 5-minutes-per-74-minutes bar on a quiet machine but not under heavy GPU contention (417 s).

On stereo-au (CPU, no AVX), per the wharf session's measurement of ~80 min per hour of audio for base.en and ~30 for tiny.en: tiny.en to align, base.en (greedy) for transcripts people read, never small.en or larger.

Overrides: `WHISPER_MODEL` / `WHISPER_MODEL_READ` in `.env`, or a job's optional `model` arg (`.env` wins). Each result records `model` and `stats.whisperFor` (`align`/`read`), `whisperModelChosenBy`, `whisperBackend` (`metal`/`cpu`, parsed from whisper-cli's own `using MTL0 backend` line) and `whisperThreads`.

## Handler contract

Project `podcast-transcribe`, handler `analyse_episode`, async only. The shim submits through the router: `{"project_id": "podcast-transcribe", "handler": "analyse_episode", "args": {...}}`.

**Input (`args`):**

| field | |
|---|---|
| `episodeId`, `libraryItemId` | required |
| `audioUrl` | required: the shim's stream route, `https://abs-shim.jderrick.app/api/items/<libraryItemId>/file/<ino>` (a `?tenant=` query is fine) |
| `token` | required: a shim access token minted for this job, 2 h |
| `sizeBytes` | what the shim last saw; may be stale, 0 or null |
| `transcripts` | `[{url, type, language}]`, the publisher's, ranked by the shim, master time |
| `chapters` | `[{start, title}]` or null, the publisher's, master time |
| `title`, `showNotes` | for the LLM (HTML is stripped) |
| `wantLlm` | run the LLM step |
| `resultUrl` | where to POST the result |
| `model` | optional whisper model name; `.env` overrides win over it |

Input validation is `warn`, not enforce: the shim ships on its own cadence and the handler reads every field tolerantly, so a schema slip is logged by wharfd instead of 422ing the queue. Only `episodeId`, `audioUrl` and `token` are indispensable.

**What it does**, logging each step with timings to stderr (the job log):

1. checks `ffmpeg`, `ffprobe` and `whisper-cli` are on PATH (the project's `bin/` first) before downloading anything;
2. downloads `audioUrl` with `Authorization: Bearer <token>`, so the audio is the stitch the shim's Worker gets and therefore the one listeners get, and measures its size; a size different from `sizeBytes` is logged and analysed anyway, and reported as measured (Fish served three different stitches in one morning: 29.3, 31.7 and 32.0 MB);
3. ffprobe for the length, ffmpeg to 16 kHz mono wav;
4. fetches the first transcript in `transcripts[]` that parses into at least 20 timed cues (WebVTT, SRT or Podcasting 2.0 JSON; text and HTML links carry no times and are skipped; an editor SRT that starts at 01:00:00 is shifted back when the shifted cues then fit the file);
5. whisper.cpp with the node's model for that case (see "Which model");
6. with a publisher transcript: `align.py` (offsets, cuts, inserted ads; publisher cues and chapters shifted into served time). Without one: whisper's cues, publisher chapters passed through unaligned;
7. if `wantLlm`: `llm_pass.py` labels ad reads and, when there are no chapters yet, writes chapters; LLM ads that overlap an aligned ad are dropped. With no key, or on any LLM error, the job still succeeds (see `llm` below);
8. POSTs the result to `resultUrl` with the same bearer, as `application/json`: 2xx is delivered; 408, 429, 5xx and network errors are retried 3 times (5 s, 20 s, 60 s); any other 4xx is final; redirects are not followed;
9. **always** prints the result to stdout as the job result, also when the POST failed, so the shim can poll `GET /jobs/<id>` instead.

**Output** (stdout and POST body, identical) — the prototype's `out/*.result.json` shape with the size called `sizeBytes`:

```json
{
  "version": 1, "episodeId": "...", "libraryItemId": "li_...",
  "sizeBytes": 71169166, "requestedSizeBytes": 71169166, "duration": 4440.555,
  "model": "base.en", "llmModel": null,
  "offsets": [{"from": 0.0, "to": 1012.68, "shift": 89.76}, {"from": 1012.68, "to": 4441.56, "shift": 27.14}],
  "cuts": [{"from": 950.06, "to": 1012.68}],
  "ads": [{"start": 0.0, "end": 89.76, "confidence": 0.85, "source": "align", "kind": "inserted", "where": "pre-roll"}],
  "chapters": [{"start": 0.0, "title": "Intro", "source": "publisher"}, {"start": 182.76, "title": "Housekeeping", "source": "publisher"}],
  "transcript": {"source": "publisher", "cues": [{"start": 101.149, "end": 105.656, "speaker": "Chris", "text": "Hello, friends, ..."}]},
  "stats": {"node": "mac", "whisperBackend": "metal", "whisperThreads": 8, "whisperFor": "align", "whisperModelChosenBy": "default", "words": 14614, "anchors": 10495, "chain": 10488, "runs": 2, "served_seconds_aligned": 4287.9, "transcriptUrl": "...", "transcriptType": "text/vtt", "chaptersAligned": true},
  "timings": {"download": 5.5, "decode": 3.4, "transcriptFetch": 0.8, "whisper": 81.5, "align": 0.06, "total": 91.4}
}
```

- `offsets`: master ranges, served = master + shift. `cuts`: master audio the served file doesn't have. Times in `ads`, `chapters` and `transcript.cues` are served time when aligned.
- `ads[].source` is `align` (with `where`: pre-roll, mid-roll, post-roll, replacement, swap) or `llm` (with `label`); `kind` is `inserted`, `host-read` or `promo`. LLM `promo` ranges should not be auto-skipped: Haiku called LUP's own housekeeping a promo.
- `chapters[].source`: `publisher` or `llm`. `stats.chaptersAligned` false means publisher chapters passed through in master time (no transcript to align against).
- `transcript.source`: `publisher` (shifted cues, with speakers) or `whisper` (no speakers).
- **`llm`**, present only when `wantLlm` was true: `"ok"` (then `llmModel`, e.g. `anthropic/claude-sonnet-5`, and `stats.llm` = `{backend: "openrouter", model, requestedModel, reasoning, structuredOutput, usage: {prompt_tokens, completion_tokens, reasoning_tokens}, costUsd, lines, promptChars}`), `"skipped: no OPENROUTER_API_KEY"`, or `"error: …"` (refusal, `max_tokens`, HTTP failure); when it isn't ok, `llmError` carries the same text. Note for the shim: `llmModel` stays null then, so don't fall back to reading a model name out of `llm`.
- `timings.total` excludes the POST. Results are ~50-200 KB an hour of audio (the transcript); wharf stores up to 256 KB inline and spills larger ones beside the job log, which `GET /jobs/<id>` reassembles transparently.

**Failure:** a non-zero exit with a last stderr line `ERROR: <Type>: <message>`, which wharf puts in the job's `error` (e.g. `audio fetch: HTTP 401 from https://abs-shim.jderrick.app/api/items/.../file/...`). Nothing is POSTed on failure.

**Idempotent:** all scratch (~250 MB an hour: the audio plus the wav) lives in `scratch/<job>/`, removed by the handler and again by wharf's `cleanup_dirs`; a re-run gives the same result apart from timings (unless the host served a different stitch, which is then what the result describes).

**The job token** is sent only to `audioUrl` and `resultUrl`, only over https (plain http is allowed to 127.0.0.1/localhost, for tests), and never across a redirect to another origin: urllib copies `Authorization` onto a redirected request, so a cross-origin redirect is refused rather than followed (the shim proxies episode audio and never redirects it). Publisher transcripts are fetched without it. It never appears in the job log. It does sit in the job's `args`, which wharf keeps in its database for 30 days and returns from `GET /jobs/<id>` to any credential for this project; the 2-hour lifetime is what bounds that.

## The LLM step

`handlers/_lib/llm_pass.py`, modelled on eastsidefm's `core/chapter_pipeline.py` (`run_llm`) and its CLAUDE.md "Models (via OpenRouter)": plain HTTPS (urllib, so no node needs a venv) to `POST https://openrouter.ai/api/v1/chat/completions` with `Authorization: Bearer $OPENROUTER_API_KEY`, `usage: {include: true}` for inline token and cost accounting, and `response_format: {type: "json_schema", json_schema: {strict: true, …}}`. The reply is still parsed tolerantly (code fences, prose around the object), and a provider that answers 400 to `response_format` is retried once without it, relying on the prompt. 408/429/5xx (honouring `retry-after`), network errors, a 200 carrying a retryable `error` object, and empty completions are retried, 4 attempts in all. A refusal, a `length` finish or anything else becomes `llm: "error: …"`.

Default `anthropic/claude-sonnet-5` with reasoning `low`, the closest to what the prototype validated (Sonnet; Haiku had called LUP's own housekeeping a promo). The gotchas carried over from eastsidefm: `anthropic/*` never gets `temperature` (Claude 4.7+ rejects it) and Claude 5 can't turn thinking off (so `off` sends effort `low` there); other models get `temperature: 0.1`; Gemini thinking is billed at output rates and dominates cost unless a reasoning override is sent, but `low` on `google/gemini-3.8-flash` means **zero** thinking and over-consolidated chapters, so for that model use `medium`, or accept `default` and the cost.

No key exists yet, so the request construction and the parse paths were tested against a stub on 2026-10-13 (both model families, the 429-in-body retry, the 400 `response_format` fallback, fenced and prose-wrapped JSON, bad settings, no key), and the no-key path end to end. There is no `claude -p` path: handlers run as `_wharf` or `wharf`, which have no Claude Code login. An hour of audio is ~1,300 transcript lines, ~26k input tokens.

## Testing by hand

How it was tested on 2026-10-13, without sudo: `./install.sh --dest <dir>`, then run the handler exactly as wharfd does — a copy of the script outside the project (as in `state/registered/`), `python3 <copy>` with cwd = the project, the args JSON on stdin, and an environment built from nothing but wharf's variables and the `.env` keys the manifest passes through:

```bash
cd <dir> && env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin HOME=<somewhere> \
  AGENT_PROJECT_DIR="$PWD" WHARF_NODE_ID=mac WHARF_JOB_ID=test-1 \
  WHISPER_MODEL_DIR=/opt/wharf/share/whisper [WHISPER_MODEL=…] \
  python3 /tmp/handler-copy.py < args.json > result.json 2> job.log
```

with `args.json` holding a 2-hour token minted the way the shim mints it (HS256 over `{userId, username, type:'access', iat, exp}`) and `resultUrl` pointing at a local receiver. Nothing has been run on stereo-au itself yet: a real job there costs 30-80 minutes of the PBX box's CPU per hour of audio.

## stereo-au

Deployed on 2026-10-13 with `./install.sh stereo-au` (Joseph approved it as the fallback): registered and approved, `.env` with `WHISPER_MODEL_DIR=/usr/local/share/whisper`, wharfd reloaded, never restarted (same PID throughout). Right after the deploy the node's capability set had no `whisper` or `ffmpeg` (its last detection pass predated the wharf session's install of them), so a submit would have been refused with 422 `capability_unavailable`; wharfd's periodic re-detect picked both up within minutes ("detected: curl-impersonate, ffmpeg, patchright, systemctl, whisper"). Still open: no job has run there yet, and it has no `OPENROUTER_API_KEY` (LLM steps report skipped). A first real job is best run outside PBX hours.

## Gotchas

- `wharf handler approve --hash` needs the full 64-character hash (a 12-character prefix is refused as a mismatch). install.sh reads it from `handler list --json`.
- On the Mac, run every wharf CLI command as `_wharf`; under plain sudo it writes root-owned files the daemon can't read.
- A handler-script change means a new hash: re-run install.sh on **both** nodes, or they run different code.
- Job logs hold the whole result (wharf logs stdout too), ~50-200 KB a job, and wharf never rotates them.
- macOS's `rsync` (openrsync) can leave part of a deleted directory tree behind on `--delete`; harmless here, since nothing big is ever removed from the project.
