#!/usr/bin/env python3
"""LLM pass over a whisper.cpp transcript of the SERVED file: label ad reads
(inserted and host-read) and cut titled chapters.

  llm_pass.py --whisper ep.json [--title "..."] [--show "..."] [--notes notes.txt]
              [--dynamic-ads true|false] -o llm.json   (needs OPENROUTER_API_KEY)

Output: {"ads": [{"start","end","confidence","kind","label"}],
         "chapters": [{"start","title"}], "meta": {...}}

Backend: OpenRouter's chat completions API over plain HTTPS (urllib: no SDK,
no venv on any node), as eastsidefm's core/chapter_pipeline.py does it. All
settings come from the project's .env (the nodes run
WHARF_ENV_PASSTHROUGH=strict, so the manifest lists each one):

  OPENROUTER_API_KEY    required; without it analyse() raises NoApiKey and
                        the handler reports the step as skipped
  OPENROUTER_MODEL      default anthropic/claude-haiku-5.5
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

The transcript goes in as paragraphs "m:ss text" of ~15 s (a new one at any
pause of 2 s or more, since the seam before an inserted spot is nearly always
a pause), ~200 lines and ~23k input tokens (Claude's tokenizer) an hour: the
per-line "[MM:SS]" stamps of the first version were a fifth of the bill. The model answers
each ad with a line time plus the ad's first words and the show's first words
after it; the code snaps the times to lines, then moves each edge onto the
quoted words (segment-interpolated word times), so an ad that starts
mid-paragraph is still cut within a second or two. An ad's end is pulled back
to its last word when music follows (LUP's pre-roll runs into 11 s of the
show's own intro music).

Model (2026-10-13 tuning, llmtune/REPORT.md in that session's scratchpad: six
episodes, LUP 688, three Fish stitches, This American Life 899, Linux
Matters): with this prompt Haiku 5.5 labelled all 48 inserted spots it was
shown "inserted" and, with the guards in clean(), invented none, at ~$0.003
an hour of audio against
Sonnet 5.5's ~$0.065 with the first prompt. What made the difference: telling
the model whether the host inserts ads dynamically (the shim's `dynamicAds`),
defining "inserted" by where an ad sits and who made it rather than by who
voices it (LUP's pre-roll is read by a host), saying that a produced trailer
for another podcast is inserted while the hosts' own plug is a promo, naming
housekeeping as not-a-promo, and the guards in clean(). With the old prompt
Haiku called pre-rolls host-read, iHeart spots promos and LUP's housekeeping a
promo. Its chapters are the weaker part (looser boundaries, sometimes 13-15 an
hour); `openai/gpt-6-luna` (same price, fewer tokens) cut cleaner chapters and
was as good on ads with this prompt, but once called both iHeart mid-rolls
"promo" under the previous wording. Sonnet 5.5 with this prompt is ~$0.054 an
hour and still the best at chapters.
"""
import argparse, html, json, os, re, sys, time
import urllib.error, urllib.request

API_URL = 'https://openrouter.ai/api/v1/chat/completions'
DEFAULT_MODEL = 'anthropic/claude-haiku-5.5'   # llmtune 2026-10-13: Sonnet's answers at ~1/20 of the cost
DEFAULT_REASONING = 'low'
RETRYABLE = (408, 429, 500, 502, 503, 504, 529)

PROMPT = """Label this podcast episode for a podcast player: its ads, and chapters.

Show: {show}
Episode: {title}
Length: {length}
{dynamic}{notes}
The transcript is speech recognition of the file listeners download (expect misheard words and missing punctuation). Each line starts with its time (m:ss or h:mm:ss).

ADS. Every ad, with its kind:
- "inserted": not part of the recorded show but placed into the file: a spot produced elsewhere for a brand, another podcast or a network (often a different voice or announcer, with its own call to action), or any sponsor read that sits before the show's own opening or after its final goodbye. Inserted ads are skipped automatically, so use this kind only when you are sure; music or silence alone is never an ad.
- "host-read": the show's own hosts reading a sponsor message inside the show, usually led into and out of from the conversation ("this episode is sponsored by...", "stop the podcast... on with the show"). Sponsors named in the show notes are usually read this way.
- "promo": the show's own hosts plugging, inside the show, something of the show's or its network's that listeners can join, buy or listen to (membership, Patreon, merch, tickets, another podcast). A produced spot or trailer for another podcast, in its own voice, is "inserted".
Not ads: the show's intro, theme, credits, housekeeping (the hosts announcing their own events or news), listener segments, a host introducing the episode, and products the hosts discuss as part of the conversation.
Consecutive ads of one kind form one entry; an inserted spot running straight into a host-read is two entries.
"start": the time of the line where the ad begins; "startWords": the first 4-8 words of the ad itself, copied exactly from the transcript, even when the ad begins mid-line. "end": the time of the line where the show resumes, or "END" if the ad runs to the end of the file; "resumeWords": the first 4-8 words of the show after the ad, copied exactly, even mid-line ("" for END). "confidence": 0.9+ when certain, under 0.5 when guessing. "label": the advertiser or podcast.

CHAPTERS. {chapters} chapters a listener would jump between, at real changes of topic or segment, titled in 2-6 words in the show's own terms (the segment's name, the fact or story discussed). The first starts at 0:00 and is named for the show's opening, never for an ad. No chapter starts inside an ad.

Reply with only JSON: {{"ads":[{{"start":"m:ss","startWords":"","end":"m:ss","resumeWords":"","kind":"inserted|host-read|promo","confidence":0.0,"label":""}}],"chapters":[{{"start":"m:ss","title":""}}]}}

TRANSCRIPT:
{transcript}
"""

# The shim knows whether the episode's host stitches ads in per download
# (hasDynamicAds in src/lib/podcast-shapes.ts) and sends it as `dynamicAds`.
# Without it the old prompt's cheaper models called a host-voiced pre-roll
# "host-read", which turns the automatic skip into a button.
DYNAMIC_ADS = ("This show's host inserts ads dynamically: each download gets its own ads, typically a pre-roll before "
               "the show opens, mid-rolls at breaks and a post-roll after the goodbye. Those are \"inserted\" even when "
               "a host voices them.\n")
NO_DYNAMIC_ADS = ("This show's host does not insert ads dynamically, so \"inserted\" ads are unlikely: use that kind only "
                  "for a clearly separate produced spot.\n")
MIN_CONFIDENCE = 0.5   # below this the prompt says the model is guessing
# An inserted ad is skipped without asking, so it needs more: Haiku called This
# American Life's own 8 s "our story continues after a break" bumper inserted
# at 0.5 in 3 of 3 runs, while every real inserted spot came back at >= 0.8.
MIN_CONFIDENCE_INSERTED = 0.7

# The JSON shape the model must return (response_format json_schema).
SCHEMA = {
    'type': 'object', 'additionalProperties': False, 'required': ['ads', 'chapters'],
    'properties': {
        'ads': {'type': 'array', 'items': {
            'type': 'object', 'additionalProperties': False,
            'required': ['start', 'startWords', 'end', 'resumeWords', 'kind', 'confidence', 'label'],
            'properties': {'start': {'type': 'string'}, 'startWords': {'type': 'string'},
                           'end': {'type': 'string'}, 'resumeWords': {'type': 'string'},
                           'kind': {'type': 'string', 'enum': ['inserted', 'host-read', 'promo']},
                           'confidence': {'type': 'number'}, 'label': {'type': 'string'}}}},
        'chapters': {'type': 'array', 'items': {
            'type': 'object', 'additionalProperties': False, 'required': ['start', 'title'],
            'properties': {'start': {'type': 'string'}, 'title': {'type': 'string'}}}},
    },
}


def clock(t):
    """m:ss or h:mm:ss (no leading zero: fewer tokens, and an hour reads the same)."""
    t = int(t)
    h, m, s = t // 3600, (t % 3600) // 60, t % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


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


def whisper_segments(j):
    """whisper.cpp -ojf → [{start,end,text}] without [Music]/(laughs) segments."""
    segs = []
    for seg in j['transcription']:
        text = re.sub(r'\s+', ' ', seg['text']).strip()
        if not text or re.fullmatch(r'[\[(][^\])]*[\])]', text):
            continue
        segs.append({'start': seg['offsets']['from'] / 1000, 'end': seg['offsets']['to'] / 1000, 'text': text})
    return segs


SENTENCE_END = re.compile(r'[.?!]["\')]?$')


def lines_from_whisper(j, target=15.0, max_len=24.0, gap=2.0):
    """Join whisper segments into paragraphs: a new one at a pause >= gap,
    after a sentence end once the paragraph is >= target long, or before it
    would pass max_len. Returns (lines, segments)."""
    segs = whisper_segments(j)
    lines, cur = [], None
    for s in segs:
        if cur:
            if not (s['start'] - cur['end'] >= gap or s['end'] - cur['start'] > max_len
                    or (cur['end'] - cur['start'] >= target and SENTENCE_END.search(cur['text']))):
                cur['text'] += ' ' + s['text']
                cur['end'] = s['end']
                continue
            lines.append(cur)
        cur = dict(s)
    if cur:
        lines.append(cur)
    return lines, segs


def plain_notes(notes, limit=1500):
    """Show notes arrive as the shim's sanitised HTML; the model wants text."""
    if not notes:
        return ''
    text = re.sub(r'<(br|/p|/li)\s*/?>', '\n', notes, flags=re.I)
    text = html.unescape(re.sub(r'<[^>]+>', ' ', text))
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n\s*\n+', '\n', text).strip()
    return text[:limit]


def chapter_count(duration):
    m = (duration or 0) / 60
    return '3-6' if m < 20 else '5-10' if m < 40 else '6-12'


def build_prompt(lines, show='', title='', notes='', duration=0.0, dynamic_ads=None):
    notes = plain_notes(notes)
    return PROMPT.format(
        show=show or '(unknown)', title=title or '(unknown)', length=clock(duration or lines[-1]['end'] if lines else 0),
        dynamic='' if dynamic_ads is None else DYNAMIC_ADS if dynamic_ads else NO_DYNAMIC_ADS,
        notes=f"Show notes (may name this episode's sponsors):\n{notes}\n" if notes else '',
        chapters=chapter_count(duration),
        transcript='\n'.join(f"{clock(l['start'])} {l['text']}" for l in lines))


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


def _bill(spend, result):
    """Add one answer's OpenRouter `usage.cost` (USD) to `spend`."""
    cost = (result.get('usage') or {}).get('cost') if isinstance(result, dict) else None
    if isinstance(cost, (int, float)) and not isinstance(cost, bool):
        spend['usd'] += float(cost)
        spend['billed'] = True


def call_openrouter(prompt, attempts=4, spend=None):
    """POST the prompt to OpenRouter; returns (parsed answer, meta). Retries
    408/429/5xx (honouring retry-after), network errors, error bodies with a
    retryable code, and empty completions. Raises RuntimeError otherwise.

    `spend`, a dict, is filled in as calls are made, so it still holds what
    was spent when this raises: `calls` (requests sent) and `usd` (the sum of
    `usage.cost` over every answer received: a retried empty completion, an
    answer that hit max_tokens and one that doesn't parse are billed too).
    meta's `costUsd` is that same sum, for this call."""
    if spend is None:
        spend = {}
    spend.setdefault('calls', 0)
    spend.setdefault('usd', 0.0)
    usd_before = spend['usd']
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
            spend['calls'] += 1
            with urllib.request.urlopen(req, timeout=300) as r:
                result = json.load(r)
            _bill(spend, result)
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
        'costUsd': round(spend['usd'] - usd_before, 8) if spend.get('billed') else usage.get('cost')}


def extract_json(text):
    text = text.strip()
    text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text)
    a, b = text.find('{'), text.rfind('}')
    return json.loads(text[a:b + 1])


def snap(t, starts):
    """Nearest line start (the model copies line times; this undoes rounding)."""
    return min(starts, key=lambda s: abs(s - t)) if starts else t


WORD = re.compile(r'[a-z0-9]+')


def word_times(segs):
    """Every word with a time interpolated inside its segment."""
    out = []
    for s in segs:
        ws = WORD.findall(s['text'].lower().replace("'", ''))
        for i, w in enumerate(ws):
            out.append((w, s['start'] + (s['end'] - s['start']) * i / max(len(ws), 1)))
    return out


def locate(words, quote, t, window=30.0):
    """Time of the first word of `quote` within `window` s of t (the line the
    model chose), allowing one misheard word in up to six; None when the quote
    is too short or not there. The window stops a wrong quote dragging an
    edge: Haiku once gave a resumeWords from inside the read, 41 s early."""
    q = WORD.findall((quote or '').lower().replace("'", ''))[:6]
    if len(q) < 3:
        return None
    best = None
    for i in range(len(words) - len(q) + 1):
        wt = words[i][1]
        if abs(wt - t) > window:
            continue
        m = sum(1 for a, b in zip(q, words[i:i + len(q)]) if a == b[0])
        if m >= max(3, len(q) - 1) and (best is None or (m, -abs(wt - t)) > best[0]):
            best = ((m, -abs(wt - t)), wt)
    return best[1] if best else None


def clean(raw, lines, duration, segs=None):
    starts = [l['start'] for l in lines]
    words = word_times(segs) if segs else []
    ads = []
    for a in raw.get('ads', []):
        try:
            conf = float(a.get('confidence', 0.5))
        except (TypeError, ValueError):
            conf = 0.5
        if conf < (MIN_CONFIDENCE_INSERTED if a.get('kind') == 'inserted' else MIN_CONFIDENCE):
            continue   # the model's own "guessing", or not sure enough to skip by itself
        s = parse_clock(a.get('start'), duration)
        e = parse_clock(a.get('end'), duration)
        if s is None or e is None:
            continue
        s = snap(s, starts)
        at_end = e >= duration - 1
        e = duration if at_end else snap(e, starts)
        if words:   # the quoted words put the edges inside a paragraph
            s2 = locate(words, a.get('startWords'), s)
            e2 = None if at_end else locate(words, a.get('resumeWords'), e)
            if s2 is not None and (e2 if e2 is not None else e) - s2 > 5:
                s = max(0.0, s2 - 0.3)
            if e2 is not None and e2 - s > 5:
                e = e2 - 0.3
        if not at_end and segs:
            # end on the ad's last word, not on the show's next one, when music
            # or silence sits between them (it belongs to the show)
            last = max((x['end'] for x in segs if s <= x['start'] < e - 0.5), default=None)
            if last is not None and e - last >= 3:
                e = last + 0.5
        if e - s < (15 if a.get('kind') == 'inserted' else 5):
            continue   # a dynamically inserted spot is 15 s or more; shorter is a bumper or a stray line
        ads.append({'start': round(s, 2), 'end': round(e, 2), 'confidence': conf,
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
    inserted = [a for a in merged if a['kind'] == 'inserted']
    reads = [a for a in merged if a['kind'] in ('inserted', 'host-read')]   # not promo: a wrong one would move real chapters
    chapters = []
    for c in raw.get('chapters', []):
        s = parse_clock(c.get('start'), duration)
        title = str(c.get('title', '')).strip()[:80]
        if s is None or not title or s >= duration:
            continue
        s = snap(s, starts) if s > 0 else 0.0
        for a in reads:   # a chapter never starts inside (or just before) an ad read: Haiku's "Sponsor Break"
            if s > 0 and a['start'] - 5 <= s < a['end'] - 1:
                s = a['end']
        chapters.append({'start': round(s, 2), 'title': title})
    chapters.sort(key=lambda c: c['start'])
    pre = next((a for a in inserted if a['start'] <= 1), None)
    if pre and len(chapters) > 1 and chapters[1]['start'] <= pre['end'] + 30:
        chapters = chapters[1:]   # the 0:00 chapter was the pre-roll ("Berkeley Life Ad")
    out = []
    for c in chapters:
        if out and c['start'] - out[-1]['start'] < 30:
            continue   # too close to the last one to be worth a jump
        out.append(c)
    if out:
        out[0]['start'] = 0.0
    return merged, out


class NoApiKey(RuntimeError):
    """OPENROUTER_API_KEY isn't set: the caller skips the LLM step."""


def analyse(wj, duration, show="", title="", notes="", dynamic_ads=None, spend=None):
    """Whisper JSON → (ads, chapters, meta). `dynamic_ads`: the shim's
    `dynamicAds` (True/False), or None when it didn't say. `spend`: a dict
    that collects what the OpenRouter calls cost (see call_openrouter), also
    when this raises. Raises NoApiKey without a key, and anything else the
    API call raises."""
    if not os.environ.get('OPENROUTER_API_KEY'):
        raise NoApiKey('no OPENROUTER_API_KEY')
    lines, segs = lines_from_whisper(wj)
    prompt = build_prompt(lines, show, title, notes, duration, dynamic_ads)
    raw, meta = call_openrouter(prompt, spend=spend)
    ads, chapters = clean(raw, lines, duration, segs)
    meta.update(lines=len(lines), promptChars=len(prompt))
    return ads, chapters, meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--whisper', required=True)
    ap.add_argument('--show', default='')
    ap.add_argument('--title', default='')
    ap.add_argument('--notes', help='show notes file (sponsors are often listed there)')
    ap.add_argument('--duration', type=float)
    ap.add_argument('--dynamic-ads', choices=('true', 'false'), help="the host stitches ads in per download")
    ap.add_argument('--dump-prompt', help='write the prompt here and stop')
    ap.add_argument('-o', '--out', default='-')
    a = ap.parse_args()

    j = json.load(open(a.whisper, encoding='utf-8'))
    duration = a.duration or (j['transcription'][-1]['offsets']['to'] / 1000)
    notes = open(a.notes, encoding='utf-8').read() if a.notes else ''
    dyn = None if a.dynamic_ads is None else a.dynamic_ads == 'true'
    if a.dump_prompt:
        lines, _ = lines_from_whisper(j)
        prompt = build_prompt(lines, a.show, a.title, notes, duration, dyn)
        open(a.dump_prompt, 'w', encoding='utf-8').write(prompt)
        print(f'{len(lines)} lines, {len(prompt)} chars', file=sys.stderr)
        return
    ads, chapters, meta = analyse(j, duration, a.show, a.title, notes, dyn)
    s = json.dumps({'ads': ads, 'chapters': chapters, 'meta': meta}, ensure_ascii=False, indent=1)
    if a.out == '-':
        print(s)
    else:
        open(a.out, 'w', encoding='utf-8').write(s + '\n')


if __name__ == '__main__':
    main()
