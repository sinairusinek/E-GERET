#!/usr/bin/env python3
"""Audit TSV of E-GERET place names that Kima resolves to >1 distinct place.

Calls Kimatch's match engine directly (in-process) — no Kimatch script edits.
Surfaces places that the pre-guard engine likely silently mis-linked.

Output: output/places-ambiguous-audit.tsv
"""
from __future__ import annotations
import csv
import json
import sys
from pathlib import Path

KIMATCH = Path("/Users/sinairusinek/Documents/GitHub/Kimatch")
sys.path.insert(0, str(KIMATCH))

from kimatch.core.matcher import match_place, MatchResult
from kimatch.core.models import InputPlace
from kimatch.data.loader import KimaDB

REPO = Path(__file__).resolve().parent.parent
INDEX = REPO / "output" / "entity-index.json"
DECISIONS = KIMATCH / "data" / "egeret" / "egeret_places_decisions.json"
OUT = REPO / "output" / "places-ambiguous-audit.tsv"

decisions = json.loads(DECISIONS.read_text(encoding="utf-8"))
index = json.loads(INDEX.read_text(encoding="utf-8"))

linked = set(decisions.keys())
unlinked = [p for p in index["places"] if p["name"] not in linked]
print(f"{len(unlinked)} unlinked places", file=sys.stderr)

print(f"Loading KimaDB …", file=sys.stderr)
db = KimaDB.load(KIMATCH / "20250126KimaPlacesCSVx.csv",
                 KIMATCH / "Kima-Variants-20250929.tsv")

rows = []
for p in unlinked:
    name = p["name"]
    name_heb = p.get("nameHeb", "")
    names = [name] + ([name_heb] if name_heb and name_heb != name else [])
    place = InputPlace(input_id=name, names=names)
    res = match_place(place, db)
    if res.status != MatchResult.NAME_AMBIGUOUS:
        continue
    cands = [{"kima_id": c.kima_id, "rom": c.primary_rom, "heb": c.primary_heb,
              "wikidata": c.wikidata_id or ""}
             for c in res.candidates]
    rows.append({
        "source_name": name,
        "name_heb": name_heb,
        "count": p["count"],
        "n_candidates": len(cands),
        "kima_candidates": json.dumps(cands, ensure_ascii=False),
        "letter_ids_sample": "|".join((p.get("letters") or [])[:5]),
    })

rows.sort(key=lambda r: -r["count"])

with OUT.open("w", encoding="utf-8", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()) if rows else
                       ["source_name", "name_heb", "count", "n_candidates",
                        "kima_candidates", "letter_ids_sample"],
                       delimiter="\t")
    w.writeheader()
    w.writerows(rows)

print(f"Wrote {len(rows)} ambiguous places → {OUT}", file=sys.stderr)
