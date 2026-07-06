#!/usr/bin/env python3
"""Select the personal-letter pool for the lab-2 hybrid allocation round.

Criteria: mid-length letters with a healthy entity yield whose place names
actually resolve in the lab's embedded mini-gazetteer, one letter per sender,
Kovner's letter (the shared sample) excluded. Emits data/pool.json.
"""
import json, os, re, html, unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'output')
POOL_SIZE = 16

# ---- port of the page's normHe(), so coverage checks match runtime behavior ----
FINALS = str.maketrans('ךםןףץ', 'כמנפצ')
def norm_he(s):
    s = unicodedata.normalize('NFC', s or '')
    s = re.sub(r'[֑-ׇ]', '', s)
    s = s.replace('״', '"').replace('”', '"')
    s = re.sub(r"[׳’']", '', s)
    s = re.sub(r'[־–—-]', ' ', s)
    s = re.sub(r'[().,:;!?"]', '', s)
    s = s.translate(FINALS)
    s = re.sub(r'\s+', ' ', s).strip().lower()
    s = unicodedata.normalize('NFD', s)
    return re.sub(r'[̀-ͯ]', '', s)

# ---- gazetteer exact-match key set ----
gaz = json.load(open(os.path.join(HERE, 'data', 'gazetteer.json'), encoding='utf-8'))
gaz_keys = set()
for p in gaz:
    for v in p['v']:
        gaz_keys.add(norm_he(v))
    gaz_keys.add(norm_he(re.sub(r'\s*\(.*\)$', '', p['heb'])))
    gaz_keys.add(norm_he(re.sub(r'\s*\(.*\)$', '', p['rom'])))

# ---- NER entities per letter ----
ner = json.load(open(os.path.join(OUT, 'e-geret-ner-export.json'), encoding='utf-8'))
ner_by_id = {}
for r in (ner['results'] if isinstance(ner, dict) else ner):
    ner_by_id[r['id']] = r.get('entities') or {}

# ---- batch export ----
batch = json.load(open(os.path.join(OUT, 'e-geret-batch-export.json'), encoding='utf-8'))

def clean_text(s):
    s = html.unescape(s or '')
    s = s.replace(' ', ' ')
    return s.strip()

def paras(content):
    t = clean_text(content)
    parts = [p.strip() for p in re.split(r'\n+', t) if p.strip()]
    if len(parts) >= 3:
        return parts
    # fall back: cluster sentences into ~350-500 char paragraphs
    sents = re.split(r'(?<=[.!?…]) +', t)
    out, cur = [], ''
    for s in sents:
        cur = (cur + ' ' + s).strip()
        if len(cur) >= 350:
            out.append(cur)
            cur = ''
    if cur:
        out.append(cur)
    return out

cands = []
for r in batch['results']:
    if r['id'].startswith('40830'):        # the shared Kovner sample
        continue
    ex = r.get('extracted') or {}
    meta = r.get('csvMetadata') or {}
    content = clean_text(ex.get('Content'))
    if not (800 <= len(content) <= 3500):
        continue
    if not ex.get('DateISO') or not ex.get('Sender') or not ex.get('Recipient'):
        continue
    ents = ner_by_id.get(r['id']) or {}
    persons = ents.get('persons') or []
    places = ents.get('places') or []
    if len(persons) < 3 or not (1 <= len(places) <= 5):
        continue
    place_names = [p.get('name', '') for p in places if p.get('name')]
    if not place_names:
        continue
    hits = sum(1 for n in place_names if norm_he(n) in gaz_keys)
    cov = hits / len(place_names)
    if cov < 0.8:
        continue
    cands.append({
        'id': r['id'],
        'title': meta.get('title', ''),
        'sender': clean_text(ex.get('Sender')),
        'recipient': clean_text(ex.get('Recipient')),
        'dateISO': ex.get('DateISO'),
        'dateText': clean_text(ex.get('Date')),
        'location': clean_text(ex.get('Location')),
        'url': meta.get('url', ''),
        'author': meta.get('authorString', ''),
        'paras': paras(ex.get('Content')),
        '_score': hits + min(len(persons), 8) * 0.5 + (1 if ex.get('Location') else 0),
        '_places': place_names,
        '_cov': cov,
    })

# one letter per sender/author, greedy by score, prefer location diversity
cands.sort(key=lambda c: -c['_score'])
pool, seen_auth, seen_loc = [], set(), set()
for c in cands:
    ak = c['author'] or c['sender']
    if ak in seen_auth:
        continue
    lk = norm_he(c['location'])
    if lk in seen_loc and len(pool) < POOL_SIZE - 4:   # keep some location diversity early on
        continue
    seen_auth.add(ak)
    seen_loc.add(lk)
    pool.append(c)
    if len(pool) == POOL_SIZE:
        break

print(f'candidates: {len(cands)}  pool: {len(pool)}')
for c in pool:
    print(f"  {c['id']:>9}  {c['sender'][:22]:<22} → {c['recipient'][:18]:<18} "
          f"{c['dateISO']:<10} {c['location'][:14]:<14} places={len(c['_places'])} cov={c['_cov']:.0%} "
          f"paras={len(c['paras'])} len={sum(len(p) for p in c['paras'])}")

for c in pool:
    for k in ('_score', '_places', '_cov'):
        del c[k]

out_path = os.path.join(HERE, 'data', 'pool.json')
json.dump(pool, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('wrote', out_path, os.path.getsize(out_path), 'bytes')
