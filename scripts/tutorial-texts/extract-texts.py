#!/usr/bin/env python3
"""Extract all editable tutorial copy from both workshop labs into a TSV.

Sources:
  lab1 = docs/lab/index.html            (edited directly — it's the live file)
  lab2 = scripts/build-lab2/index.template.html  (master; docs/lab2 is rebuilt via splice.py)

Output (next to this script):
  tutorial-texts.tsv       — id, file, tab, kind, n, text   (edit the `text` column)
  tutorial-texts.map.json  — id → exact source substring    (used by apply-texts.py)

What is extracted:
  - block  : inner HTML of .explain strips and .anatomy items (inline <b>/<code> kept)
  - text   : every other Hebrew-bearing text node (steplines, buttons, pane heads,
             legends, hints, options, <title>…)
  - attr   : Hebrew placeholder/title/value attributes
  - js     : Hebrew string literals in the page script (chat messages, status
             messages, prompts, case notes…)

Deliberately NOT extracted: the embedded letter samples (text/plain scripts),
the JSON datasets, English-only strings (tags/ids), and the WD_FALLBACK data block.
"""
import re, os, json

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
FILES = {
    'lab1': 'docs/lab/index.html',
    'lab2': 'scripts/build-lab2/index.template.html',
}
TAB_LABELS = {
    'lab1': {'md': '1 טקסט·Markdown', 'html': '2 HTML', 'xml': '3 מ־HTML ל־XML', 'tei': '4 לקראת TEI'},
    'lab2': {'tei': '1 המסמך·TEI', 'ner': '2 זיהוי·NER', 'link': '3 קישור', 'lod': '4 LOD'},
}
HEB = re.compile(r'[֐-׿]')


def find_matching(src, open_pos, tag):
    """offset of the char after the matching </tag> for the tag opened at open_pos"""
    depth = 0
    for m in re.finditer(r'</?' + tag + r'\b', src[open_pos:]):
        if m.group(0).startswith('</'):
            depth -= 1
            if depth == 0:
                end = src.index('>', open_pos + m.start()) + 1
                return end
        else:
            depth += 1
    return None


def inner_span(src, open_pos, tag):
    """(inner_start, inner_end, block_end) of the element opened at open_pos"""
    inner_start = src.index('>', open_pos) + 1
    block_end = find_matching(src, open_pos, tag)
    inner_end = src.rindex('</' + tag, inner_start, block_end)
    return inner_start, inner_end, block_end


def covered(pos, ranges):
    return any(a <= pos < b for a, b in ranges)


def norm(s):
    return re.sub(r'\s+', ' ', s.replace('\t', ' ')).strip()


rows, mapping = [], {}
counters = {}


def add(fkey, offset, tab, kind, exact, display):
    display = norm(display)
    if not display or not HEB.search(display):
        return
    # dedup identical replacement targets within a file
    for r in rows:
        if r['file'] == fkey and mapping[r['id']]['exact'] == exact:
            r['n'] += 1
            return
    counters[fkey] = counters.get(fkey, 0) + 1
    rid = f'{fkey.upper()}-{counters[fkey]:03d}'
    rows.append({'id': rid, 'file': fkey, 'offset': offset, 'tab': tab, 'kind': kind, 'n': 1, 'text': display})
    mapping[rid] = {'file': FILES[fkey], 'kind': kind, 'exact': exact}


for fkey, rel in FILES.items():
    src = open(os.path.join(ROOT, rel), encoding='utf-8').read()

    # ---- ranges to skip for text-node extraction ----
    skip = []
    for m in re.finditer(r'<script\b[^>]*>', src):
        end = src.index('</script>', m.end()) + len('</script>')
        skip.append((m.start(), end))
    for m in re.finditer(r'<style\b[^>]*>', src):
        end = src.index('</style>', m.end()) + len('</style>')
        skip.append((m.start(), end))

    # ---- tab panel ranges, for the context column ----
    panels = []
    for m in re.finditer(r'<section class="tab-panel[^"]*" id="panel-([a-z]+)">', src):
        end = find_matching(src, m.start(), 'section')
        panels.append((m.start(), end, m.group(1)))

    def tab_of(pos):
        for a, b, name in panels:
            if a <= pos < b:
                return TAB_LABELS[fkey].get(name, name)
        return 'כללי'

    # ---- block mode: explain strips ----
    block_ranges = []
    for m in re.finditer(r'<div class="explain[^"]*"[^>]*>', src):
        a, b, blk_end = inner_span(src, m.start(), 'div')
        exact = src[a:b]
        add(fkey, m.start(), tab_of(m.start()), 'strip', exact, exact)
        block_ranges.append((m.start(), blk_end))

    # ---- block mode: anatomy boxes (li / p / an-title inside) ----
    for m in re.finditer(r'<div class="anatomy">', src):
        a, b, blk_end = inner_span(src, m.start(), 'div')
        block_ranges.append((m.start(), blk_end))
        inner = src[a:b]
        for sub_tag, sub_re in (('li', r'<li>'), ('p', r'<p\b[^>]*>'), ('div', r'<div class="an-title">')):
            for sm in re.finditer(sub_re, inner):
                sa, sb, _ = inner_span(inner, sm.start(), sub_tag)
                exact = inner[sa:sb]
                if HEB.search(exact):
                    add(fkey, a + sm.start(), tab_of(m.start()), 'anatomy', exact, exact)

    # ---- attributes ----
    for m in re.finditer(r'(placeholder|title|value)="([^"]*)"', src):
        if covered(m.start(), skip) or not HEB.search(m.group(2)):
            continue
        add(fkey, m.start(), tab_of(m.start()), 'attr:' + m.group(1), m.group(0), m.group(2))

    # ---- remaining Hebrew text nodes ----
    for m in re.finditer(r'>([^<>]+)<', src):
        if not HEB.search(m.group(1)):
            continue
        if covered(m.start(1), skip) or covered(m.start(1), block_ranges):
            continue
        add(fkey, m.start(1), tab_of(m.start(1)), 'text', m.group(0), m.group(1))

    # ---- js literals in the page script (skip typed scripts = samples/data) ----
    for m in re.finditer(r'<script>', src):
        end = src.index('</script>', m.end())
        js = src[m.end():end]
        # mask the factual-data block so its strings are not offered for editing
        fb = js.find('const WD_FALLBACK')
        if fb != -1:
            fb_end = js.index('};', fb) + 2
            js = js[:fb] + ' ' * (fb_end - fb) + js[fb_end:]
        for lm in re.finditer(r"'((?:[^'\\\n]|\\.)*)'", js):
            body = lm.group(1)
            if not HEB.search(body):
                continue
            display = body.replace("\\'", "'").replace('\\n', ' ')
            add(fkey, m.end() + lm.start(), 'script', 'js', lm.group(0), display)

rows.sort(key=lambda r: (r['file'], r['offset']))

tsv_path = os.path.join(HERE, 'tutorial-texts.tsv')
with open(tsv_path, 'w', encoding='utf-8') as f:
    f.write('id\tfile\ttab\tkind\tn\ttext\n')
    for r in rows:
        f.write('\t'.join([r['id'], r['file'], r['tab'], r['kind'], str(r['n']), r['text']]) + '\n')

json.dump(mapping, open(os.path.join(HERE, 'tutorial-texts.map.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=0)

from collections import Counter
print(f'{len(rows)} rows → {tsv_path}')
print(Counter((r["file"], r["kind"].split(":")[0]) for r in rows))
