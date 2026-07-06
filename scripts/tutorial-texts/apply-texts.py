#!/usr/bin/env python3
"""Map an edited tutorial-texts.tsv back into the two lab sources.

Usage:
  python3 apply-texts.py [edited.tsv] [--check]

Reads tutorial-texts.map.json (written by extract-texts.py) for the exact
source substrings; a row is applied only when its `text` cell differs from
the original (whitespace-normalized). lab1 (docs/lab/index.html) is patched
in place; lab2 patches go into the template and splice.py is run to rebuild
docs/lab2/index.html.
"""
import re, os, json, sys, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')

args = [a for a in sys.argv[1:] if a != '--check']
CHECK = '--check' in sys.argv
tsv_path = args[0] if args else os.path.join(HERE, 'tutorial-texts.tsv')

mapping = json.load(open(os.path.join(HERE, 'tutorial-texts.map.json'), encoding='utf-8'))


def norm(s):
    return re.sub(r'\s+', ' ', s.replace('\t', ' ')).strip()


def original_display(kind, exact):
    if kind in ('strip', 'anatomy'):
        return norm(exact)
    if kind == 'text':
        return norm(exact[1:-1])
    if kind.startswith('attr:'):
        m = re.match(r'\w+="(.*)"$', exact, re.S)
        return norm(m.group(1))
    if kind == 'js':
        return norm(exact[1:-1].replace("\\'", "'").replace('\\n', ' '))
    return norm(exact)


def replacement(kind, exact, edited):
    if kind in ('strip', 'anatomy'):
        return edited
    if kind == 'text':
        return '>' + edited + '<'
    if kind.startswith('attr:'):
        attr = kind.split(':')[1]
        return attr + '="' + edited.replace('"', '&quot;') + '"'
    if kind == 'js':
        return "'" + edited.replace('\\', '\\\\').replace("'", "\\'") + "'"
    return edited


def read_tsv_raw(path):
    """Tab-split parser — csv-module quoting corrupts cells that start with a
    double quote. Handles Excel/Sheets re-export, which wraps such cells in
    quotes and doubles inner quotes: that convention is auto-detected per file."""
    lines = open(path, encoding='utf-8').read().replace('\r\n', '\n').replace('\r', '\n').split('\n')
    header = lines[0].split('\t')
    out = []
    for ln in lines[1:]:
        if not ln.strip():
            continue
        parts = ln.split('\t', len(header) - 1)
        if len(parts) != len(header):
            print(f'!! malformed line skipped: {ln[:60]}')
            continue
        out.append(dict(zip(header, parts)))
    return out


def unquote(v):
    if len(v) >= 2 and v.startswith('"') and v.endswith('"'):
        return v[1:-1].replace('""', '"')
    return v


rows = read_tsv_raw(tsv_path)
# detect spreadsheet-style quote wrapping: rows whose raw text mismatches the
# original but whose unquoted text matches it prove the file was re-quoted
wrapped = sum(1 for r in rows if (m := mapping.get(r['id'])) and norm(r['text']) != original_display(m['kind'], m['exact'])
              and norm(unquote(r['text'])) == original_display(m['kind'], m['exact']))
if wrapped:
    print(f'(spreadsheet quote-wrapping detected on {wrapped} rows — unquoting all wrapped cells)')
    for r in rows:
        r['text'] = unquote(r['text'])
changes = {}   # file -> [(exact, new, id)]
skipped, missing_id = 0, []
for r in rows:
    rid = r['id']
    m = mapping.get(rid)
    if not m:
        missing_id.append(rid)
        continue
    edited = norm(r['text'])
    if edited == original_display(m['kind'], m['exact']):
        skipped += 1
        continue
    if not edited:
        print(f'!! {rid}: empty text — skipped (delete content in the HTML directly if intended)')
        continue
    changes.setdefault(m['file'], []).append((m['exact'], replacement(m['kind'], m['exact'], edited), rid))

if missing_id:
    print(f'!! {len(missing_id)} row ids not in map (edited ids?): {missing_id[:5]}')

applied, notfound = 0, []
for rel, edits in changes.items():
    path = os.path.join(ROOT, rel)
    src = open(path, encoding='utf-8').read()
    # longest exact first, so no replacement can corrupt a longer pending target
    for exact, new, rid in sorted(edits, key=lambda e: -len(e[0])):
        n = src.count(exact)
        if n == 0:
            notfound.append(rid)
            continue
        if CHECK:
            print(f'~ {rid} ({rel}, ×{n}): {norm(exact)[:60]} → {norm(new)[:60]}')
        else:
            src = src.replace(exact, new)
        applied += 1
    if not CHECK:
        open(path, 'w', encoding='utf-8').write(src)

print(f'{applied} changes {"found" if CHECK else "applied"}, {skipped} rows unchanged'
      + (f', NOT FOUND (source drifted — re-extract): {notfound}' if notfound else ''))

if not CHECK and any('build-lab2' in f for f in changes):
    subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'build-lab2', 'splice.py')], check=True)
if not CHECK and changes:
    print('NOTE: re-run extract-texts.py before the next editing round (offsets/exacts changed).')
