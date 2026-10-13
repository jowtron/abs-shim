#!/usr/bin/env python3
"""Align a whisper.cpp transcript of the SERVED audio (the ad-stitched file the
shim proxies to listeners) against what the publisher made from the MASTER:
its transcript (WebVTT / SRT / Podcasting 2.0 JSON) and chapters.

Produces one JSON result for the shim:

  {
    "version": 1,
    "duration": <served file length, s>,
    "offsets": [{"from": m0, "to": m1, "shift": s}],   # master ranges; served = master + shift
    "cuts":    [{"from": m0, "to": m1}],                # master audio the served file doesn't have
    "ads":     [{"start", "end", "confidence", "source": "align"|"llm", "kind"}],  # served time
    "transcript": {"source": "publisher-vtt"|"whisper", "cues": [{"start","end","speaker","text"}]},
    "chapters": [{"start", "title", "source"}],        # served time
    "stats": {...}
  }

How (the idea from alignvtt.py, made robust):
  1. words with times on both sides: whisper's token timestamps (-ojf) for the
     served file, linear inside each cue for the publisher's transcript;
  2. anchors = word 3-grams that occur exactly once on EACH side;
  3. the longest chain of anchors increasing in both times (drops the few
     coincidental matches);
  4. that chain cut into runs of constant offset (served - master); a run
     boundary is where the file differs from the master: offset grows =
     audio inserted (an ad), offset shrinks = master audio cut;
  5. each gap between runs re-anchored with local 2-grams so the boundary is
     placed to within a word or two, then classified.

No publisher transcript: the transcript is whisper's own, there are no
offsets, and ads/chapters come from llm_pass.py (merged with --llm).

Pure standard library, so it runs on any wharf node with python3.
"""
import argparse, bisect, json, re, statistics, sys
from collections import Counter, defaultdict

TOL = 2.5          # s: anchors within this of a run's offset belong to it
MIN_RUN = 4        # anchors needed for a run to count
MIN_EVENT = 4.0    # s: offset changes smaller than this are timing jitter
SHORT_INSERT = 10.0  # s: insertions shorter than this are never auto-skipped


def norm_words(s):
    s = s.lower().replace('’', "'").replace('‘', "'")
    return re.findall(r"[a-z0-9]+(?:'[a-z]+)?", s)


# ── served side: whisper.cpp JSON ────────────────────────────────────────────

def token_time(tk):
    # DTW timestamps (-dtw <model>, needs -nfa) are in centiseconds and far
    # steadier than the decoder's own token times, which drift by several
    # seconds inside a long segment and around music.
    d = tk.get('t_dtw', -1)
    return d / 100 if d is not None and d >= 0 else tk['offsets']['from'] / 1000


def whisper_words(j):
    """[(t, word)] from -ojf token timestamps, else linear inside segments."""
    out = []
    for seg in j['transcription']:
        toks = seg.get('tokens')
        if toks:
            cur, t0 = '', None
            for tk in toks:
                tx = tk['text']
                if tx.startswith('[_') or (tx.startswith('[') and tx.endswith(']')):
                    continue
                if tx.startswith(' ') and cur:
                    out.extend((t0, w) for w in norm_words(cur))
                    cur, t0 = '', None
                if t0 is None:
                    t0 = token_time(tk)
                cur += tx
            if cur:
                out.extend((t0, w) for w in norm_words(cur))
        else:
            a, b = seg['offsets']['from'] / 1000, seg['offsets']['to'] / 1000
            ws = norm_words(seg['text'])
            out.extend((a + (b - a) * k / max(1, len(ws)), w) for k, w in enumerate(ws))
    out.sort(key=lambda x: x[0])
    return out


def whisper_cues(j):
    cues = []
    for seg in j['transcription']:
        text = re.sub(r'\s+', ' ', seg['text']).strip()
        if not text or re.fullmatch(r'[\[(][^\])]*[\])]', text):   # [Music], (laughs)
            continue
        cues.append({'start': seg['offsets']['from'] / 1000, 'end': seg['offsets']['to'] / 1000,
                     'speaker': None, 'text': text})
    return cues


# ── master side: publisher transcript ────────────────────────────────────────

CLOCK = r'(?:(\d+):)?(\d\d):(\d\d)[.,](\d{1,3})'


def _clock(h, m, s, ms):
    return int(h or 0) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, '0')) / 1000


def parse_captions(body):
    """WebVTT or SRT → [{start,end,speaker,text}] (speaker from <v Name>)."""
    cues = []
    body = body.replace('\r\n', '\n').replace('\r', '\n')
    for block in re.split(r'\n\s*\n', body):
        m = re.search(CLOCK + r'\s*-->\s*' + CLOCK, block)
        if not m:
            continue
        t0, t1 = _clock(*m.groups()[:4]), _clock(*m.groups()[4:])
        lines = block[m.end():].strip('\n').split('\n')
        speaker = None
        text = []
        for ln in lines:
            v = re.match(r'<v(?:\.[^ >]*)?\s+([^>]+)>', ln)
            if v:
                speaker = v.group(1).strip()
            text.append(re.sub(r'<[^>]+>', '', ln))
        txt = re.sub(r'\s+', ' ', ' '.join(text)).strip()
        if txt:
            cues.append({'start': t0, 'end': t1, 'speaker': speaker, 'text': txt})
    return cues


def parse_json_transcript(data):
    """Podcasting 2.0 JSON transcript: {segments:[{startTime,endTime,body,speaker}]}."""
    cues = []
    for s in data.get('segments', []):
        try:
            cues.append({'start': float(s['startTime']), 'end': float(s.get('endTime', s['startTime'])),
                         'speaker': s.get('speaker'), 'text': str(s.get('body', '')).strip()})
        except (KeyError, ValueError, TypeError):
            continue
    return [c for c in cues if c['text']]


def parse_transcript(body, content_type='', duration=None):
    """A publisher transcript's text → sorted cues. Podcasting 2.0 JSON when
    the type says json or the body is an object, else WebVTT/SRT. Plain text
    and HTML carry no times and come back empty: they can't be aligned."""
    ctype = (content_type or '').lower()
    stripped = body.lstrip('﻿ \t\r\n')
    if 'json' in ctype or stripped.startswith('{'):
        try:
            cues = parse_json_transcript(json.loads(stripped))
        except (ValueError, AttributeError):
            cues = []
    else:
        cues = parse_captions(body)
    cues.sort(key=lambda c: c['start'])
    return fix_offset(cues, duration)


def fix_offset(cues, duration=None):
    """The shim's fixOffset: an SRT exported from a video editor starts at
    01:00:00 (Linux & Open Source News: every cue an hour late). Remove whole
    hours when the first cue is past the hour mark and, given the file's
    length, the shifted cues then fit inside it."""
    if not cues or cues[0]['start'] < 3600:
        return cues
    sh = int(cues[0]['start'] // 3600) * 3600
    if duration and cues[-1]['end'] - sh > duration + 60:
        return cues
    if duration and cues[-1]['end'] <= duration + 60:
        return cues   # they already fit: a long episode that really starts talking late
    for c in cues:
        c['start'] -= sh
        c['end'] -= sh
    return cues


def load_transcript(path, duration=None):
    body = open(path, encoding='utf-8', errors='replace').read()
    return parse_transcript(body, 'application/json' if path.endswith('.json') else '', duration)


def master_words(cues):
    out = []
    for c in cues:
        ws = norm_words(c['text'])
        for k, w in enumerate(ws):
            out.append((c['start'] + (c['end'] - c['start']) * k / max(1, len(ws)), w))
    return out


def load_chapters(path):
    d = json.load(open(path, encoding='utf-8'))
    raw = d.get('chapters', d) if isinstance(d, dict) else d
    out = []
    for c in raw:
        if c.get('toc') is False:
            continue
        st = c.get('startTime', c.get('start'))
        try:
            out.append({'start': float(st), 'title': str(c.get('title') or '').strip()})
        except (TypeError, ValueError):
            pass
    return sorted(out, key=lambda c: c['start'])


# ── alignment ────────────────────────────────────────────────────────────────

def grams(words, n):
    return [tuple(w for _, w in words[i:i + n]) for i in range(len(words) - n + 1)]


def unique_anchors(sw, mw, n=3):
    sg, mg = grams(sw, n), grams(mw, n)
    sc, mc = Counter(sg), Counter(mg)
    mpos = {g: i for i, g in enumerate(mg) if mc[g] == 1}
    out = []
    for i, g in enumerate(sg):
        if sc[g] == 1 and g in mpos:
            out.append((sw[i][0], mw[mpos[g]][0]))
    return sorted(out)


def longest_chain(anchors):
    """Longest subsequence increasing in master time (anchors sorted by served time)."""
    tails, tails_idx, prev = [], [], [-1] * len(anchors)
    for i, (_, m) in enumerate(anchors):
        k = bisect.bisect_left(tails, m)
        if k == len(tails):
            tails.append(m); tails_idx.append(i)
        else:
            tails[k] = m; tails_idx[k] = i
        prev[i] = tails_idx[k - 1] if k else -1
    out, i = [], tails_idx[-1] if tails_idx else -1
    while i >= 0:
        out.append(anchors[i]); i = prev[i]
    return out[::-1]


def runs_of(chain):
    """Cut the chain into runs of constant offset; drop lone outliers."""
    runs, cur = [], []
    i = 0
    while i < len(chain):
        s, m = chain[i]
        d = s - m
        if not cur or abs(d - statistics.median(x[0] - x[1] for x in cur[-15:])) <= TOL:
            cur.append(chain[i]); i += 1
            continue
        ahead = [x[0] - x[1] for x in chain[i:i + 5]]
        if sum(abs(a - d) <= TOL for a in ahead) >= 3:
            runs.append(cur); cur = [chain[i]]
        i += 1   # an outlier is skipped either way
    if cur:
        runs.append(cur)
    runs = [r for r in runs if len(r) >= MIN_RUN]
    return drop_excursions(merge_same(runs))


def merge_same(runs):
    merged = []
    for r in runs:   # neighbours with the same offset are one run
        if merged and abs(med_off(merged[-1]) - med_off(r)) <= TOL:
            merged[-1] = merged[-1] + r
        else:
            merged.append(r)
    return merged


EXCURSION = 45.0   # s: a run shorter than this between two equal offsets is timing noise


def drop_excursions(runs):
    """A short stretch at another offset that returns to where it was (A, B, A)
    is whisper's timestamps wandering (a dropped sentence, a long segment
    around a jingle), not an edit: a real insertion or cut moves the offset
    for good. Drop such stretches and merge the two sides."""
    changed = True
    while changed and len(runs) >= 3:
        changed = False
        for i in range(1, len(runs) - 1):
            j = i
            while j < len(runs) - 1 and span(runs[j]) < EXCURSION:
                j += 1
            if j > i and j < len(runs) and abs(med_off(runs[i - 1]) - med_off(runs[j])) <= TOL \
                    and all(span(r) < EXCURSION for r in runs[i:j]):
                runs = runs[:i - 1] + [runs[i - 1] + runs[j]] + runs[j + 1:]
                changed = True
                break
    return runs


def span(run):
    return run[-1][0] - run[0][0]


def med_off(run):
    return statistics.median(s - m for s, m in run)


def refine_gap(sw, mw, a_run, b_run):
    """Extend both runs into the gap between them with LOCAL 2-gram matches
    (non-unique globally, unique inside the gap windows), so the boundary
    lands within a word or two."""
    s0, s1 = a_run[-1][0], b_run[0][0]
    m0, m1 = a_run[-1][1], b_run[0][1]
    da, db = med_off(a_run), med_off(b_run)
    sws = [x for x in sw if s0 < x[0] < s1]
    mws = [x for x in mw if m0 - 1 < x[0] < m1 + 1]
    if len(sws) < 2 or len(mws) < 2:
        return a_run, b_run
    mg = defaultdict(list)
    for i in range(len(mws) - 1):
        mg[(mws[i][1], mws[i + 1][1])].append(mws[i][0])
    ext_a, ext_b = [], []
    for i in range(len(sws) - 1):
        t = sws[i][0]
        for mt in mg.get((sws[i][1], sws[i + 1][1]), []):
            if abs((t - mt) - da) <= TOL:
                ext_a.append((t, mt))
            elif abs((t - mt) - db) <= TOL:
                ext_b.append((t, mt))
    # Only a monotone prefix/suffix is believable: a-run words come first.
    if ext_a and ext_b:
        cut = min(t for t, _ in ext_b)
        ext_a = [x for x in ext_a if x[0] < cut]
    return a_run + sorted(ext_a), sorted(ext_b) + b_run


def words_between(words, t0, t1):
    return [w for t, w in words if t0 <= t < t1]


def master_vocab_near(mw, m0, m1, pad=30):
    return {w for t, w in mw if m0 - pad <= t <= m1 + pad}


def classify(sw, mw, prev, nxt, duration, master_end):
    """One transition between two runs (prev/nxt may be None for the file's
    start / end). Returns (ads, cuts, boundary_master_time)."""
    ads, cuts = [], []
    if prev is None:
        a_s, a_m, da = 0.0, 0.0, 0.0
    else:
        a_s, a_m, da = prev[-1][0], prev[-1][1], med_off(prev)
    if nxt is None:
        b_s, b_m, db = duration, master_end, None
    else:
        b_s, b_m, db = nxt[0][0], nxt[0][1], med_off(nxt)
    # Small pad: an anchor's time is a 3-gram's first word.
    gap_s0 = a_s + (1.5 if prev is not None else 0)
    served_gap = max(0.0, b_s - gap_s0)
    master_gap = max(0.0, b_m - a_m)
    gwords = words_between(sw, gap_s0, b_s)
    vocab = master_vocab_near(mw, a_m, b_m)
    foreign = [w for w in gwords if w not in vocab and len(w) > 2]
    foreign_frac = len(foreign) / max(1, len([w for w in gwords if len(w) > 2]))

    if db is None:
        # Tail: anything after the master's last words that isn't in the master.
        extra = served_gap - master_gap
        if extra > MIN_EVENT and len(foreign) >= 15 and foreign_frac > 0.6:
            first = next((t for t, w in sw if t >= gap_s0 and w in foreign), gap_s0)
            ads.append({'start': round(first, 2), 'end': round(duration, 2),
                        'confidence': 0.75, 'source': 'align', 'kind': 'inserted', 'where': 'post-roll'})
        return ads, cuts, None

    delta = db - da
    if delta > MIN_EVENT:
        # Inserted audio of ~delta seconds somewhere in [gap_s0, b_s]. Put it
        # where the served words don't belong to the master.
        start = place_window(sw, mw, gap_s0, b_s, a_m, b_m, delta)
        conf = 0.95 if served_gap - delta < 6 else (0.85 if foreign_frac > 0.5 else 0.7)
        # A real inserted ad is 15 s or longer; an insertion under 10 s is
        # as likely a sting or a misplaced anchor, so it gets the "Skip ad"
        # pill (< 0.8) rather than an automatic jump (Joseph, 2026-10-13).
        if delta < SHORT_INSERT: conf = min(conf, 0.7)
        ads.append({'start': round(start, 2), 'end': round(start + delta, 2), 'confidence': conf,
                    'source': 'align', 'kind': 'inserted',
                    'where': 'pre-roll' if prev is None else 'mid-roll'})
        boundary = start - da          # master time where the insertion sits
    elif delta < -MIN_EVENT:
        # Master audio cut (the publisher's own sponsor read, usually). If the
        # served gap still has foreign speech, something was put in its place.
        cut_len = -delta
        if served_gap > 8 and len(foreign) >= 10 and foreign_frac > 0.6:
            ins = served_gap - max(0.0, master_gap - cut_len)
            ads.append({'start': round(gap_s0, 2), 'end': round(gap_s0 + ins, 2), 'confidence': 0.7,
                        'source': 'align', 'kind': 'inserted', 'where': 'replacement'})
            cut_len += ins
        c0 = a_m + max(0.0, (master_gap - cut_len) / 2)
        cuts.append({'from': round(c0, 2), 'to': round(c0 + cut_len, 2)})
        boundary = c0 + cut_len
    else:
        # Same offset either side: a stretch the anchors missed. Only call it
        # an ad when whisper heard plenty of words the master doesn't have
        # nearby (an equal-length swap).
        if served_gap > 15 and len(foreign) >= 20 and foreign_frac > 0.7:
            ads.append({'start': round(gap_s0, 2), 'end': round(b_s, 2), 'confidence': 0.5,
                        'source': 'align', 'kind': 'inserted', 'where': 'swap'})
        boundary = (a_m + b_m) / 2
    return ads, cuts, boundary


def place_window(sw, mw, s0, s1, m0, m1, length):
    """Start of the `length`-second window in [s0, s1] that best fits an
    insertion: as few served words as possible that pair up with the master
    near [m0, m1] (word bigrams, so "the" alone proves nothing), and as many
    as possible that don't (the ad's own speech). Ties → earliest."""
    if s1 - s0 <= length + 0.5:
        return s0
    near = [w for t, w in mw if m0 - 5 <= t <= m1 + 5]
    bi = set(zip(near, near[1:]))
    vocab = set(near)
    g = [(t, w) for t, w in sw if s0 - 1 <= t <= s1 + 1]
    marks = []
    for i, (t, w) in enumerate(g):
        prev_w = g[i - 1][1] if i else None
        next_w = g[i + 1][1] if i + 1 < len(g) else None
        ours = (prev_w, w) in bi or (w, next_w) in bi
        foreign = not ours and w not in vocab and len(w) > 2
        marks.append((t, ours, foreign))
    best, best_t = None, s0
    t = s0
    while t + length <= s1 + 0.01:
        inside = [m for m in marks if t <= m[0] < t + length]
        score = sum(1 for m in inside if m[1]) * 2 - sum(1 for m in inside if m[2]) * 0.5
        if best is None or score < best - 1e-9:
            best, best_t = score, t
        t += 0.25
    return best_t


def align(sw, mw, duration):
    anchors = unique_anchors(sw, mw, 3)
    chain = longest_chain(anchors)
    runs = runs_of(chain)
    for i in range(len(runs) - 1):
        runs[i], runs[i + 1] = refine_gap(sw, mw, runs[i], runs[i + 1])
    master_end = mw[-1][0] if mw else 0.0
    ads, cuts, offsets = [], [], []
    seq = [None] + runs + [None]
    bounds = []
    for k in range(len(seq) - 1):
        a, c, b = classify(sw, mw, seq[k], seq[k + 1], duration, master_end)
        ads += a; cuts += c
        if b is not None:
            bounds.append(b)
    # offsets: run i covers master [bounds[i-1], bounds[i]); first from 0.
    # bounds[0] is the pre-roll boundary (the insertion point, normally 0).
    edges = [0.0] + bounds[1:] + [max(master_end, duration) + 1]
    for i, r in enumerate(runs):
        offsets.append({'from': round(edges[i], 2), 'to': round(edges[i + 1], 2), 'shift': round(med_off(r), 2)})
    aligned_s = sum(r[-1][0] - r[0][0] for r in runs)
    stats = {'anchors': len(anchors), 'chain': len(chain), 'runs': len(runs),
             'served_seconds_aligned': round(aligned_s, 1)}
    return offsets, cuts, ads, stats


def master_to_served(m, offsets, cuts):
    """Map a master time to the served file. A time inside a cut lands where
    the cut was; a time exactly at an insertion point lands AFTER the ad."""
    for c in cuts:
        if c['from'] <= m < c['to']:
            m = c['to']
            break
    for o in offsets:
        if o['from'] <= m < o['to']:
            return m + o['shift']
    if offsets:
        o = offsets[0] if m < offsets[0]['from'] else offsets[-1]
        return m + o['shift']
    return m


def shift_cues(cues, offsets, cuts):
    out = []
    for c in cues:
        if any(k['from'] <= c['start'] and c['end'] <= k['to'] for k in cuts):
            continue   # said only in the master
        s = master_to_served(c['start'], offsets, cuts)
        e = master_to_served(max(c['start'], c['end'] - 0.001), offsets, cuts)
        out.append({**c, 'start': round(s, 3), 'end': round(max(s, e), 3)})
    return out


def shift_chapters(chapters, offsets, cuts):
    out = []
    for c in chapters:
        s = 0.0 if c['start'] <= 0.5 else master_to_served(c['start'], offsets, cuts)
        out.append({'start': round(s, 2), 'title': c['title'], 'source': 'publisher'})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--whisper', required=True, help='whisper.cpp JSON (-oj or -ojf) of the served file')
    ap.add_argument('--transcript', help="publisher transcript (.vtt/.srt/.json), made from the master")
    ap.add_argument('--chapters', help='publisher chapters (Podcasting 2.0 JSON)')
    ap.add_argument('--llm', help='llm_pass.py output to merge (ads with source=llm, generated chapters)')
    ap.add_argument('--duration', type=float, help='served file length, s (default: last whisper time)')
    ap.add_argument('--size', type=int, help='served file byte size (the stitch this result is for)')
    ap.add_argument('-o', '--out', default='-')
    a = ap.parse_args()

    wj = json.load(open(a.whisper, encoding='utf-8'))
    sw = whisper_words(wj)
    duration = a.duration or (wj['transcription'][-1]['offsets']['to'] / 1000 if wj['transcription'] else 0)
    result = {'version': 1, 'duration': round(duration, 3), 'size': a.size,
              'model': (wj.get('params') or {}).get('model', '').split('/')[-1],
              'offsets': [], 'cuts': [], 'ads': [], 'transcript': None, 'chapters': [], 'stats': {}}
    pub_chapters = load_chapters(a.chapters) if a.chapters else []

    if a.transcript:
        cues = load_transcript(a.transcript)
        mw = master_words(cues)
        offsets, cuts, ads, stats = align(sw, mw, duration)
        result.update(offsets=offsets, cuts=cuts, ads=ads, stats=stats)
        result['transcript'] = {'source': 'publisher', 'cues': shift_cues(cues, offsets, cuts)}
        result['chapters'] = shift_chapters(pub_chapters, offsets, cuts)
    else:
        result['transcript'] = {'source': 'whisper', 'cues': whisper_cues(wj)}
        result['chapters'] = [{'start': c['start'], 'title': c['title'], 'source': 'publisher'} for c in pub_chapters]
        result['stats'] = {'words': len(sw)}

    if a.llm:
        llm = json.load(open(a.llm, encoding='utf-8'))
        for ad in llm.get('ads', []):
            # An LLM ad that overlaps an aligned one adds nothing.
            if any(x['start'] < ad['end'] and ad['start'] < x['end'] for x in result['ads']):
                continue
            result['ads'].append({**ad, 'source': 'llm'})
        if not result['chapters'] and llm.get('chapters'):
            result['chapters'] = [{'start': c['start'], 'title': c['title'], 'source': 'llm'} for c in llm['chapters']]
    result['ads'].sort(key=lambda x: x['start'])

    text = json.dumps(result, ensure_ascii=False, indent=1)
    if a.out == '-':
        sys.stdout.write(text + '\n')
    else:
        open(a.out, 'w', encoding='utf-8').write(text + '\n')


if __name__ == '__main__':
    main()
