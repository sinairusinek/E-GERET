#!/usr/bin/env python3
"""Build the embedded datasets for docs/lab2:
   1. mini-Kima gazetteer (places + variants) from the Kimatch dumps
   2. corpus place queue (curated ambiguity cases from the audit file)
   3. map data (linked places with coords + letter counts)
"""
import csv, json, sys, re
csv.field_size_limit(10_000_000)
from collections import defaultdict

KIMATCH = '/Users/sinairusinek/Documents/GitHub/Kimatch'
OUT = '/Users/sinairusinek/Documents/GitHub/E-GERET/output'
SCRATCH = '/private/tmp/claude-501/-Users-sinairusinek-Documents-GitHub-E-GERET/c9dcd538-0bce-4cb5-a988-0e21cba92e15/scratchpad'

# ---- load corpus link results ----
links = json.load(open(f'{OUT}/location-links.json', encoding='utf-8'))

audit_rows = list(csv.DictReader(open(f'{OUT}/places-ambiguous-audit.tsv', encoding='utf-8'), delimiter='\t'))

# ---- choose Kima place ids ----
ids = set()
name_counts = {}  # heb name -> letter_count
for name, rec in links.items():
    name_counts[name] = rec.get('letter_count', 0)
    if rec.get('kima_id'):
        ids.add(int(rec['kima_id']))

audit_ids = set()
for r in audit_rows:
    try:
        cands = json.loads(r['kima_candidates'])
    except Exception:
        continue
    for c in cands:
        audit_ids.add(int(c['kima_id']))
ids |= audit_ids
ids.add(156)  # Lomza — the sample letter's place

print(f'linked ids: {len(ids)} (audit adds {len(audit_ids - ids)})', file=sys.stderr)

# ---- load dumps ----
places = {}
with open(f'{KIMATCH}/20250126KimaPlacesCSVx.csv', encoding='utf-8-sig') as f:
    for row in csv.DictReader(f):
        pid = int(row['id'])
        places[pid] = row

variants = defaultdict(set)
with open(f'{KIMATCH}/Kima-Variants-20250929.tsv', encoding='utf-8') as f:
    for row in csv.DictReader(f, delimiter='\t'):
        try:
            pid = int(row['PlaceId'])
        except Exception:
            continue
        v = (row['variant'] or '').strip()
        if v:
            variants[pid].add(v)

# ---- ambiguity clusters: for every exact variant of a chosen place, include
#      OTHER places registered under the same spelling (that's the real-world trap) ----
by_variant = defaultdict(set)
for pid, vs in variants.items():
    for v in vs:
        by_variant[v.lower()].add(pid)
extra = set()
for pid in list(ids):
    for v in variants.get(pid, []):
        others = by_variant[v.lower()] - ids
        if 0 < len(others) <= 4:      # small clusters only; skip mega-common spellings
            extra |= others
# cap the extras to keep the page lean
extra = set(list(extra)[:250])
ids |= extra
print(f'with ambiguity clusters: {len(ids)}', file=sys.stderr)

HEB = re.compile(r'[֐-׿]')

def clean(s):
    return (s or '').strip()

gaz = []
for pid in sorted(ids):
    p = places.get(pid)
    if not p:
        continue
    vs = variants.get(pid, set())
    heb_vs = sorted(v for v in vs if HEB.search(v))
    lat_vs = sorted(v for v in vs if not HEB.search(v))[:6]
    rec = {
        'id': pid,
        'rom': clean(p['primary_rom_full']),
        'heb': clean(p['primary_heb_full']),
        'v': heb_vs + lat_vs,
    }
    if clean(p['WikiData_Id']) not in ('', 'NULL'): rec['wd'] = clean(p['WikiData_Id'])
    if clean(p['Geoname_ID']) not in ('', 'NULL'): rec['gn'] = clean(p['Geoname_ID'])
    if clean(p['VIAF_ID']) not in ('', 'NULL'): rec['viaf'] = clean(p['VIAF_ID'])
    if clean(p['MAZAL_ID']) not in ('', 'NULL'): rec['nli'] = clean(p['MAZAL_ID'])
    if clean(p['description']) not in ('', 'NULL'): rec['d'] = clean(p['description'])[:80]
    try:
        rec['lat'] = round(float(p['lat']), 3); rec['lon'] = round(float(p['lon']), 3)
    except Exception:
        pass
    gaz.append(rec)

# ---- map data: linked corpus places with coords ----
mapdata = []
for name, rec in links.items():
    if rec.get('lat') and rec.get('lon'):
        mapdata.append({
            'n': name, 'r': (rec.get('kima_name_rom') or '').split(' (')[0],
            'lat': round(rec['lat'], 3), 'lon': round(rec['lon'], 3),
            'c': rec.get('letter_count', 1)
        })
mapdata.sort(key=lambda x: -x['c'])

# ---- corpus queue: curated didactic cases from the audit ----
wanted = ['אודיסא', 'ירושלים', 'וורשה', 'קושטא', 'בריסק', 'רוסיה']
queue = []
for r in audit_rows:
    if r['name_heb'] in wanted or len(queue) < 0:
        try:
            cands = json.loads(r['kima_candidates'])
        except Exception:
            continue
        case = {'name': r['name_heb'], 'rom': r['source_name'],
                'count': int(r['count']), 'cands': cands}
        proj = links.get(r['name_heb'])
        if proj and proj.get('kima_id'):
            case['project'] = {'kima_id': proj['kima_id'],
                               'rom': proj.get('kima_name_rom', ''),
                               'status': proj.get('match_status', '')}
        queue.append(case)
print('audit picks:', [q['name'] for q in queue], file=sys.stderr)

# ---- NER lexicon for the semi-automatic pass (dictionary-based suggester) ----
idx = json.load(open(f'{OUT}/entity-index.json', encoding='utf-8'))
def top_names(kind, n, minlen=3):
    out = []
    for e in idx[kind][:n]:
        nm = (e.get('nameHeb') or e.get('name') or '').strip()
        if len(nm) >= minlen and re.search(r'[֐-׿]', nm):
            out.append(nm)
    return out

persons_full = top_names('persons', 300)
# surnames (last token, len>=4) — hits mentions like "ה' בריינין"
surnames = sorted({nm.split()[-1] for nm in persons_full
                   if len(nm.split()) > 1 and len(nm.split()[-1]) >= 4})
orgs = top_names('organizations', 100)
place_lex = sorted({v for p in gaz for v in p['v'] if HEB.search(v) and len(v) >= 3})
lexicon = {'personsFull': persons_full, 'personsSurname': surnames,
           'orgs': orgs, 'places': place_lex}
json.dump(lexicon, open(f'{SCRATCH}/lexicon.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

json.dump(gaz, open(f'{SCRATCH}/gazetteer.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
json.dump(mapdata, open(f'{SCRATCH}/mapdata.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
json.dump(queue, open(f'{SCRATCH}/queue.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

import os
for fn in ('gazetteer.json', 'mapdata.json', 'queue.json', 'lexicon.json'):
    print(fn, os.path.getsize(f'{SCRATCH}/{fn}'), 'bytes', file=sys.stderr)
