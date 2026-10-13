#!/usr/bin/env python3
"""LLM pass over a whisper.cpp transcript of the SERVED file: label ad reads
(inserted and host-read) and cut titled chapters.

  llm_pass.py --whisper ep.json [--title "..."] [--show "..."] [--notes notes.txt]
              -o llm.json   (needs OPENROUTER_API_KEY)

Output: {"ads": [{"start","end","confidence","kind","label"}],
         "chapters": [{"start","title"}], "meta": {...}}

Backend: OpenRouter's chat completions API over plain HTTPS (urllib: no SDK,
no venv on any node), as eastsidefm's core/chapter_pipeline.py does it. All
settings come from the project's .env (the nodes run
WHARF_ENV_PASSTHROUGH=strict, so the manifest lists each one):

  OPENROUTER_API_KEY    required; without it analyse() raises NoApiKey and
                        the handler reports the step as skipped
  OPENROUTER_MODEL      default anthropic/claude-sonnet-5
  OPENROUTER_REASONING  low (default) | medium | high | off | default
                        (default = send no reasoning param: the model's own)

Load-bearing gotchas carried over from eastsidefm ("Models (via OpenRouter)"
in its CLAUDE.md): anthropic/* must NOT get `temperature` (Claude 4.7+
rejects it) and Claude 5 can't turn thinking off, so it gets effort low;
Gemini thinking is billed at output rates and dominates cost unless a
reasoning override is sent, but `low` on google/gemini-3.8-flash means ZERO
thinking and over-consolidated chapters. Structured output is requested with
response_format json_schema; the reply is still parsed tolerantly (fences,
prose around the object), and a provider that rejects response_format is
retried once without it, relying on the prompt.

There is deliberately no `claude -p` path: handlers run as `_wharf`/`wharf`,
which have no Claude Code login.

The transcript goes in as numbered-by-time lines "[MM:SS] text", each line a
few whisper segments joined up to ~12 s or a sentence end, so an hour is
~1,300 lines and ~26k input tokens. The model answers with times copied from
those lines; the code snaps them back onto line boundaries and checks them,
so a time the model invents can't land mid-word.

Haiku 4.5 was tried and labelled LUP's own housekeeping segment a "promo" ad
(NOTES.md, 2026-10-13); Sonnet invented nothing on either test episode.
"""
import argparse, html, json, os, re, sys, time
import urllib.error, urllib.request

API_URL = 'https://openrouter.ai/api/v1/chat/completions'
DEFAULT_MODEL = 'anthropic/claude-sonnet-5'   # closest to what the prototype validated (Sonnet, low effort)
DEFAULT_REASONING = 'low'
RETRYABLE = (408, 429, 500, 502, 503, 504, 529)

PROMPT = """You are labelling a podcast episode transcript for a podcast player.
The transcript was made by speech recognition from the audio file a listener
actually downloads. Each line is "[MM:SS] text" (or [H:MM:SS]); the time is
when that line starts.

Show: {show}
Episode: {title}
{notes_section}
Do two things.

1. ADS. Find every advertisement or sponsor message, with where it starts and
ends. Kinds:
 - "inserted": a pre-recorded ad stitched into the file by the host platform:
   typically a different voice or announcer, unrelated to the conversation,
   often at the very start (pre-roll), at a natural break (mid-roll) or at the
   end (post-roll). Several ads in a row are ONE break: give the whole break.
 - "host-read": a show host reading a sponsor message inside the show
   ("this episode is brought to you by...", promo codes, URLs with a code).
 - "promo": a trailer or plug for another podcast or the network's own
   product (live shows, merch, a membership) that is not part of the content.
 Do not mark the show's own intro/outro, theme music, or a host merely
 mentioning a product as part of the conversation.
 "start" = the time of the first line of the ad. "end" = the time of the
 first line AFTER the ad (where the show resumes), or "END" if the ad runs to
 the end of the file. Give "confidence" 0..1 and a short "label" (the
 advertiser, e.g. "NordVPN").

2. CHAPTERS. Divide the show content into chapters a listener would want to
jump between: typically 5-12 for an hour. Titles: short (2-6 words),
specific to what is discussed, in the show's own terms (e.g. a segment's
name, or the topic of a fact). The first chapter starts at 00:00. Do not make
a chapter for an ad break; the chapter before it simply continues.

Answer with ONLY a JSON object, no prose, no code fence:
{{"ads":[{{"start":"MM:SS","end":"MM:SS","kind":"inserted","confidence":0.9,"label":"..."}}],
 "chapters":[{{"start":"MM:SS","title":"..."}}]}}

TRANSCRIPT:
{transcript}
"""

# The JSON shape the model must return (response_format json_schema).
SCHEMA = {
    'type': 'object', 'additionalProperties': False, 'required': ['ads', 'chapters'],
    'properties': {
        'ads': {'type': 'array', 'items': {
            'type': 'object', 'additionalProperties': False,
            'required': ['start', 'end', 'kind', 'confidence', 'label'],
            'properties': {'start': {'type': 'string'}, 'end': {'type': 'string'},
                           'kind': {'type': 'string', 'enum': ['inserted', 'host-read', 'promo']},
                           'confidence': {'type': 'number'}, 'label': {'type': 'string'}}}},
        'chapters': {'type': 'array', 'items': {
            'type': 'object', 'additionalProperties': False, 'required': ['start', 'title'],
            'properties': {'start': {'type': 'string'}, 'title': {'type': 'string'}}}},
    },
}


def clock(t):
    t = int(round(t))
    h, m, s = t // 3600, (t % 3600) // 60, t % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def parse_clock(s, duration):
    s = str(s).strip().upper()
    if s == 'END':
        return duration
    parts = [float(p) for p in re.findall(r'\d+(?:\.\d+)?', s)]
    if not parts:
        return None
    t = 0.0
    for p in parts:
        t = t * 60 + p
    return t


def lines_from_whisper(j, max_len=12.0):
    """Join whisper segments into reading lines: up to ~12 s, or a sentence end."""
    lines, cur = [], None
    for seg in j['transcription']:
        text = re.sub(r'\s+', ' ', seg['text']).strip()
        if not text or re.fullmatch(r'[\[(][^\])]*[\])]', text):
            continue
        a, b = seg['offsets']['from'] / 1000, seg['offsets']['to'] / 1000
        if cur and (b - cur['start'] <= max_len) and not re.search(r'[.?!]["\')]?$', cur['text']):
            cur['text'] += ' ' + text
            cur['end'] = b
        else:
            if cur:
                lines.append(cur)
            cur = {'start': a, 'end': b, 'text': text}
    if cur:
        lines.append(cur)
    return lines


def plain_notes(notes, limit=3000):
    """Show notes arrive as the shim's sanitised HTML; the model wants text."""
    if not notes:
        return ''
    text = re.sub(r'<(br|/p|/li)\s*/?>', '\n', notes, flags=re.I)
    text = html.unescape(re.sub(r'<[^>]+>', ' ', text))
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n\s*\n+', '\n', text).strip()
    return text[:limit]


def build_prompt(lines, show='', title='', notes=''):
    notes = plain_notes(notes)
    return PROMPT.format(
        show=show or '(unknown)', title=title or '(unknown)',
        notes_section=f"Show notes (may name this episode's sponsors):\n{notes}\n" if notes else '',
        transcript='\n'.join(f"[{clock(l['start'])}] {l['text']}" for l in lines))


# ── the API call ───────────────────────────────────────────────────────────

def settings():
    """(model, reasoning param or None, label) from the environment."""
    model = os.environ.get('OPENROUTER_MODEL', '').strip() or DEFAULT_MODEL
    r = (os.environ.get('OPENROUTER_REASONING', '').strip() or DEFAULT_REASONING).lower()
    if r == 'default':
        reasoning = None
    elif r in ('off', 'none', 'false'):
        # Claude 5 can't disable thinking: the lowest it goes is effort low.
        reasoning = {'effort': 'low'} if model.startswith('anthropic/') else {'enabled': False}
    elif r in ('minimal', 'low', 'medium', 'high'):
        reasoning = {'effort': r}
    else:
        raise RuntimeError(f'OPENROUTER_REASONING={r!r}: want low, medium, high, off or default')
    return model, reasoning, r


def build_payload(prompt, model, reasoning, structured=True):
    payload = {
        'model': model,
        'messages': [{'role': 'user', 'content': prompt}],
        'max_tokens': 16000,
        'usage': {'include': True},   # token + cost accounting inline
    }
    if structured:
        payload['response_format'] = {'type': 'json_schema', 'json_schema': {
            'name': 'podcast_ads_and_chapters', 'strict': True, 'schema': SCHEMA}}
    if model.startswith('anthropic/'):
        # No sampling params on Claude (4.7+ rejects temperature), and thinking
        # can't be off on Claude 5: the default `low` keeps it cheap.
        payload['reasoning'] = reasoning or {'effort': 'low'}
    else:
        payload['temperature'] = 0.1
        if reasoning:
            payload['reasoning'] = reasoning
    return payload


def call_openrouter(prompt, attempts=4):
    """POST the prompt to OpenRouter; returns (parsed answer, meta). Retries
    408/429/5xx (honouring retry-after), network errors, error bodies with a
    retryable code, and empty completions. Raises RuntimeError otherwise."""
    model, reasoning, reasoning_label = settings()
    structured = True
    headers = {'Authorization': f"Bearer {os.environ['OPENROUTER_API_KEY']}",
               'Content-Type': 'application/json',
               'HTTP-Referer': 'https://github.com/jowtron', 'X-Title': 'abs-shim podcast-transcribe'}
    last = None
    i = 0
    while i < attempts:
        wait = min(60, 5 * 2 ** i)
        body = json.dumps(build_payload(prompt, model, reasoning, structured)).encode()
        try:
            req = urllib.request.Request(API_URL, data=body, method='POST', headers=headers)
            with urllib.request.urlopen(req, timeout=300) as r:
                result = json.load(r)
        except urllib.error.HTTPError as e:
            detail = e.read(2000).decode('utf-8', 'replace')
            try:
                detail = json.loads(detail)['error']['message']
            except (ValueError, KeyError, TypeError):
                pass
            last = f'HTTP {e.code}: {detail}'
            if e.code == 400 and structured and ('response_format' in detail or 'json_schema' in detail):
                structured = False   # this provider can't do structured output: rely on the prompt
                continue
            if e.code not in RETRYABLE:
                raise RuntimeError(f'OpenRouter {last}') from None
            try:
                wait = max(wait, float(e.headers.get('retry-after') or 0))
            except ValueError:
                pass
            result = None
        except (urllib.error.URLError, TimeoutError, ConnectionError, ValueError) as e:
            last = str(getattr(e, 'reason', e))
            result = None
        if result is not None:
            if 'error' in result:   # OpenRouter can answer 200 with an error object
                err = result['error'] if isinstance(result['error'], dict) else {'message': str(result['error'])}
                last = f"error {err.get('code')}: {err.get('message')}"
                if err.get('code') not in RETRYABLE:
                    raise RuntimeError(f'OpenRouter {last}')
            else:
                choice = (result.get('choices') or [{}])[0]
                msg = choice.get('message') or {}
                content = msg.get('content')
                if isinstance(content, list):   # some providers return content parts
                    content = ''.join(p.get('text', '') for p in content if isinstance(p, dict))
                if msg.get('refusal'):
                    raise RuntimeError(f"the model declined this transcript: {str(msg['refusal'])[:200]}")
                if content and content.strip():
                    if choice.get('finish_reason') == 'length':
                        raise RuntimeError('the answer hit max_tokens')
                    break
                last = f"empty completion (finish_reason={choice.get('finish_reason')})"
        i += 1
        if i == attempts:
            raise RuntimeError(f'OpenRouter failed after {attempts} attempts: {last}')
        time.sleep(wait)
    usage = result.get('usage') or {}
    details = usage.get('completion_tokens_details') or {}
    return extract_json(content), {
        'backend': 'openrouter', 'model': result.get('model') or model, 'requestedModel': model,
        'reasoning': reasoning_label, 'structuredOutput': structured,
        'usage': {'prompt_tokens': usage.get('prompt_tokens'), 'completion_tokens': usage.get('completion_tokens'),
                  'reasoning_tokens': details.get('reasoning_tokens')},
        'costUsd': usage.get('cost')}


def extract_json(text):
    text = text.strip()
    text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text)
    a, b = text.find('{'), text.rfind('}')
    return json.loads(text[a:b + 1])


def snap(t, starts):
    """Nearest line start (the model copies line times; this undoes rounding)."""
    return min(starts, key=lambda s: abs(s - t)) if starts else t


def clean(raw, lines, duration):
    starts = [l['start'] for l in lines]
    ads = []
    for a in raw.get('ads', []):
        s = parse_clock(a.get('start'), duration)
        e = parse_clock(a.get('end'), duration)
        if s is None or e is None:
            continue
        s = snap(s, starts)
        e = duration if e >= duration - 1 else snap(e, starts)
        if e - s < 5:
            continue
        ads.append({'start': round(s, 2), 'end': round(e, 2),
                    'confidence': float(a.get('confidence', 0.5)),
                    'kind': a.get('kind') if a.get('kind') in ('inserted', 'host-read', 'promo') else 'inserted',
                    'label': str(a.get('label', ''))[:60]})
    ads.sort(key=lambda x: x['start'])
    merged = []
    for a in ads:   # overlapping or touching breaks are one break
        if merged and a['start'] <= merged[-1]['end'] + 1 and a['kind'] == merged[-1]['kind']:
            merged[-1]['end'] = max(merged[-1]['end'], a['end'])
            merged[-1]['label'] = ', '.join(x for x in (merged[-1]['label'], a['label']) if x)
        else:
            merged.append(a)
    chapters = []
    for c in raw.get('chapters', []):
        s = parse_clock(c.get('start'), duration)
        title = str(c.get('title', '')).strip()[:80]
        if s is None or not title or s >= duration:
            continue
        s = snap(s, starts) if s > 0 else 0.0
        if chapters and s - chapters[-1]['start'] < 30:
            continue   # too close to the last one to be worth a jump
        chapters.append({'start': round(s, 2), 'title': title})
    if chapters:
        chapters[0]['start'] = 0.0
    return merged, chapters


class NoApiKey(RuntimeError):
    """OPENROUTER_API_KEY isn't set: the caller skips the LLM step."""


def analyse(wj, duration, show="", title="", notes=""):
    """Whisper JSON → (ads, chapters, meta). Raises NoApiKey without a key,
    and anything else the API call raises."""
    if not os.environ.get('OPENROUTER_API_KEY'):
        raise NoApiKey('no OPENROUTER_API_KEY')
    lines = lines_from_whisper(wj)
    prompt = build_prompt(lines, show, title, notes)
    raw, meta = call_openrouter(prompt)
    ads, chapters = clean(raw, lines, duration)
    meta.update(lines=len(lines), promptChars=len(prompt))
    return ads, chapters, meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--whisper', required=True)
    ap.add_argument('--show', default='')
    ap.add_argument('--title', default='')
    ap.add_argument('--notes', help='show notes file (sponsors are often listed there)')
    ap.add_argument('--duration', type=float)
    ap.add_argument('--dump-prompt', help='write the prompt here and stop')
    ap.add_argument('-o', '--out', default='-')
    a = ap.parse_args()

    j = json.load(open(a.whisper, encoding='utf-8'))
    duration = a.duration or (j['transcription'][-1]['offsets']['to'] / 1000)
    notes = open(a.notes, encoding='utf-8').read() if a.notes else ''
    if a.dump_prompt:
        lines = lines_from_whisper(j)
        prompt = build_prompt(lines, a.show, a.title, notes)
        open(a.dump_prompt, 'w', encoding='utf-8').write(prompt)
        print(f'{len(lines)} lines, {len(prompt)} chars', file=sys.stderr)
        return
    ads, chapters, meta = analyse(j, duration, a.show, a.title, notes)
    s = json.dumps({'ads': ads, 'chapters': chapters, 'meta': meta}, ensure_ascii=False, indent=1)
    if a.out == '-':
        print(s)
    else:
        open(a.out, 'w', encoding='utf-8').write(s + '\n')


if __name__ == '__main__':
    main()
