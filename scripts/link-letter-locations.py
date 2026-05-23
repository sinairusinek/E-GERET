#!/usr/bin/env python3
"""Link the Location field of every E-GERET letter to a Kima place.

Two passes, prior decisions take precedence:

  1. **Reuse:** if a unique Location string exactly matches a `nameHeb`
     in `output/entity-index.json`, take that entry's Kima decision
     from `egeret_places_decisions.json` directly. (~65% coverage.)

  2. **Engine residual:** for the rest, run the Kimatch engine on the
     raw Location string. If the engine resolves to a Kima ID that has
     already been decided for some entity-index entry, inherit that
     decision (consistency). Otherwise record the engine result as-is
     — NAME_EXACT gets auto-linked, NAME_AMBIGUOUS / FUZZY / NO_MATCH
     are written without coordinates so the map renderer can skip them.

Writes  output/location-links.json
  { location_string: {
      kima_id, kima_name_rom, kima_name_heb, kima_url,
      wikidata_id, geonames_id, lat, lon,
      match_status,  # name_exact | name_ambiguous | fuzzy | no_match
      via,           # heb_join | engine | inherited
      letter_count, ambiguous_candidates?, fuzzy_candidates?
    }, ... }
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

KIMATCH = Path("/Users/sinairusinek/Documents/GitHub/Kimatch")
sys.path.insert(0, str(KIMATCH))

from kimatch.core.matcher import match_place, MatchResult
from kimatch.core.models import InputPlace
from kimatch.data.loader import KimaDB

REPO = Path(__file__).resolve().parent.parent
BATCH = REPO / "output" / "e-geret-batch-export.json"
INDEX = REPO / "output" / "entity-index.json"
DECISIONS = KIMATCH / "data" / "egeret" / "egeret_places_decisions.json"
OUT = REPO / "output" / "location-links.json"


def kima_record(db: KimaDB, kima_id: int) -> dict:
    """Authority fields for a Kima place id."""
    kp = db.places.get(kima_id)
    if not kp:
        return {
            "kima_id":  kima_id,
            "kima_url": f"https://data.geo-kima.org/Places/Details/{kima_id}",
        }
    return {
        "kima_id":       kp.kima_id,
        "kima_name_rom": kp.primary_rom,
        "kima_name_heb": kp.primary_heb,
        "kima_url":      f"https://data.geo-kima.org/Places/Details/{kp.kima_id}",
        "wikidata_id":   kp.wikidata_id or "",
        "geonames_id":   kp.geonames_id or "",
        "lat":           kp.lat,
        "lon":           kp.lon,
    }


def main() -> None:
    print("Loading data…", file=sys.stderr)
    batch = json.loads(BATCH.read_text(encoding="utf-8"))
    index = json.loads(INDEX.read_text(encoding="utf-8"))
    decisions = json.loads(DECISIONS.read_text(encoding="utf-8"))

    # Build heb→entity_index entry + name→decision lookups
    by_heb = {(p.get("nameHeb") or "").strip(): p
              for p in index["places"] if (p.get("nameHeb") or "").strip()}
    decided_kima_ids: set[int] = set()
    decision_for_name: dict[str, int] = {}
    for name, dec in decisions.items():
        action = dec.get("action", "")
        if action.startswith("map_to:"):
            try:
                kid = int(action.split(":", 1)[1])
                decided_kima_ids.add(kid)
                decision_for_name[name] = kid
            except ValueError:
                pass

    # Count Locations
    locs: Counter[str] = Counter()
    for r in batch["results"]:
        loc = (r.get("extracted", {}).get("Location") or "").strip()
        if loc:
            locs[loc] += 1

    print(f"  {len(locs)} unique Locations across {sum(locs.values())} letters",
          file=sys.stderr)
    print("Loading KimaDB…", file=sys.stderr)
    db = KimaDB.load(KIMATCH / "20250126KimaPlacesCSVx.csv",
                     KIMATCH / "Kima-Variants-20250929.tsv")

    result: dict[str, dict] = {}
    n_join = n_engine_auto = n_engine_inherit = 0
    n_ambig = n_fuzzy = n_none = 0

    for loc, n in locs.most_common():
        entry: dict = {"letter_count": n}

        # 1. Direct Hebrew-form join with entity-index
        ix = by_heb.get(loc)
        if ix and ix["name"] in decision_for_name:
            kid = decision_for_name[ix["name"]]
            entry.update(kima_record(db, kid))
            entry["match_status"] = "name_exact"
            entry["via"]          = "heb_join"
            result[loc] = entry
            n_join += 1
            continue

        # 2. Engine residual
        m = match_place(InputPlace(input_id=loc, names=[loc]), db)
        entry["match_status"] = m.status
        entry["confidence"]   = round(m.confidence, 3)

        if m.status in (MatchResult.NAME_EXACT, MatchResult.EXACT_ID) and m.kima_place:
            entry.update(kima_record(db, m.kima_place.kima_id))
            entry["via"] = "engine"
            n_engine_auto += 1
        elif m.status == MatchResult.NAME_AMBIGUOUS:
            # If any candidate is already decided elsewhere, inherit it
            chosen = next((c for c in m.candidates if c.kima_id in decided_kima_ids), None)
            if chosen:
                entry.update(kima_record(db, chosen.kima_id))
                entry["match_status"] = "name_exact"
                entry["via"]          = "inherited"
                n_engine_inherit += 1
            else:
                entry["ambiguous_candidates"] = [
                    {"kima_id": c.kima_id, "rom": c.primary_rom, "heb": c.primary_heb,
                     "lat": c.lat, "lon": c.lon}
                    for c in m.candidates
                ]
                n_ambig += 1
        elif m.status == MatchResult.FUZZY:
            entry["fuzzy_candidates"] = [
                {"kima_id": c.kima_id, "rom": c.primary_rom, "heb": c.primary_heb}
                for c in m.candidates[:5]
            ]
            n_fuzzy += 1
        else:
            n_none += 1

        result[loc] = entry

    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    linked_unique  = n_join + n_engine_auto + n_engine_inherit
    linked_letters = sum(v["letter_count"] for v in result.values() if v.get("kima_id"))
    total_letters  = sum(locs.values())

    print(f"\nUnique Locations: {len(result)}", file=sys.stderr)
    print(f"  reuse via heb-join     : {n_join}", file=sys.stderr)
    print(f"  engine NAME_EXACT      : {n_engine_auto}", file=sys.stderr)
    print(f"  engine ambig inherited : {n_engine_inherit}", file=sys.stderr)
    print(f"  ambiguous (no decision): {n_ambig}", file=sys.stderr)
    print(f"  fuzzy                  : {n_fuzzy}", file=sys.stderr)
    print(f"  no_match               : {n_none}", file=sys.stderr)
    print(f"  TOTAL LINKED           : {linked_unique} / {len(result)} "
          f"({linked_unique/len(result)*100:.1f}%)", file=sys.stderr)
    print(f"\nLetters covered: {linked_letters} / {total_letters} "
          f"({linked_letters/total_letters*100:.1f}%)", file=sys.stderr)
    print(f"\n→ {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
