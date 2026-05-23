#!/usr/bin/env node
/**
 * Apply Kimatch place decisions into E-GERET outputs.
 *
 * Handles both flat decisions (`{ action: "map_to:X" }`) and per-mention
 * decisions (`{ mentions: { "letter_id": { action: "map_to:X", kima_id: "X" } } }`).
 *
 * Reads:
 *   ../Kimatch/data/egeret/egeret_places_decisions.json
 *   ../Kimatch/data/egeret/egeret_linked_places.tsv  (for Kima authority fields)
 *   output/entity-index.json
 *   output/e-geret-ner-export.json
 *
 * Writes:
 *   output/entity-index.linked.json   entity-index enriched with kima fields
 *                                     (places with any decision) and a
 *                                     per_mention flag where applicable.
 *   output/e-geret-ner-linked.json    NER export enriched per place mention
 *                                     with kima_id, kima_name_rom/heb,
 *                                     kima_url, wikidata_id, geonames_id, and
 *                                     a `linked_by` provenance tag (auto /
 *                                     manual / per_mention / split / skip /
 *                                     unlink / unlinked).
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO    = path.resolve(new URL('.', import.meta.url).pathname, '..');
const KIMATCH = path.resolve(REPO, '..', 'Kimatch');
const DECISIONS = path.join(KIMATCH, 'data', 'egeret', 'egeret_places_decisions.json');
const LINKED    = path.join(KIMATCH, 'data', 'egeret', 'egeret_linked_places.tsv');
const INDEX_IN  = path.join(REPO, 'output', 'entity-index.json');
const NER_IN    = path.join(REPO, 'output', 'e-geret-ner-export.json');
const INDEX_OUT = path.join(REPO, 'output', 'entity-index.linked.json');
const NER_OUT   = path.join(REPO, 'output', 'e-geret-ner-linked.json');

// ── Load Kima authority lookup (kima_id → primary names / urls) ─────────────
const tsvLines = fs.readFileSync(LINKED, 'utf8').trim().split('\n');
const tsvHeader = tsvLines.shift().split('\t');
const kimaById = new Map();
const kimaByName = new Map();     // source_name → row (for primary heb lookup of decisions)
for (const line of tsvLines) {
  const cells = line.split('\t');
  const row = Object.fromEntries(tsvHeader.map((h, i) => [h, cells[i] ?? '']));
  kimaById.set(String(row.kima_id), row);
  kimaByName.set(row.source_name, row);
}

const decisions = JSON.parse(fs.readFileSync(DECISIONS, 'utf8'));

// ── Helpers ────────────────────────────────────────────────────────────────
function parseMapAction(action) {
  if (!action || !action.startsWith('map_to:')) return null;
  const id = action.slice(7);
  return id && id !== '__manual__' ? id : null;
}

function kimaFields(kima_id) {
  const r = kimaById.get(String(kima_id));
  if (!r) {
    return { kima_id: Number(kima_id), kima_url: `https://data.geo-kima.org/Places/Details/${kima_id}` };
  }
  return {
    kima_id:       Number(kima_id),
    kima_name_rom: r.kima_name_rom,
    kima_name_heb: r.kima_name_heb,
    kima_url:      r.kima_url,
    wikidata_id:   r.wikidata_id || undefined,
    geonames_id:   r.geonames_id || undefined,
  };
}

function resolveFor(placeName, letterId) {
  const dec = decisions[placeName];
  if (!dec) return { linked_by: 'unlinked' };

  // Per-mention override wins
  const mention = dec.mentions && dec.mentions[letterId];
  if (mention) {
    const m = mention.action;
    if (m === 'split')  return { linked_by: 'split' };
    if (m === 'skip')   return { linked_by: 'skip' };
    if (m === 'unlink') return { linked_by: 'unlink' };
    const id = parseMapAction(m);
    if (id) return { ...kimaFields(id), linked_by: 'per_mention' };
    return { linked_by: 'unlinked' };
  }

  // Flat decision
  const id = parseMapAction(dec.action);
  if (id) {
    return { ...kimaFields(id), linked_by: dec.auto ? 'auto' : 'manual' };
  }
  if (dec.action === 'ambiguous')      return { linked_by: 'ambiguous' };
  if (dec.action === 'no_match_found') return { linked_by: 'no_match' };

  // No flat action but has per-mention decisions — fall back to "needs per-letter"
  if (dec.mentions && Object.keys(dec.mentions).length > 0) {
    return { linked_by: 'per_mention_unset' };
  }

  return { linked_by: 'unlinked' };
}

// ── 1. Enrich entity-index ──────────────────────────────────────────────────
const idx = JSON.parse(fs.readFileSync(INDEX_IN, 'utf8'));
let linkedFlat = 0, linkedPerMention = 0;
for (const p of idx.places) {
  const dec = decisions[p.name];
  if (!dec) continue;
  const id = parseMapAction(dec.action);
  if (id) {
    Object.assign(p, kimaFields(id));
    p.linked_by = dec.auto ? 'auto' : 'manual';
    linkedFlat++;
  }
  if (dec.mentions && Object.keys(dec.mentions).length > 0) {
    p.per_mention_decisions = Object.keys(dec.mentions).length;
    linkedPerMention++;
  }
}
idx.meta = idx.meta || {};
idx.meta.linkedPlaces = linkedFlat;
idx.meta.linkedPlacesPerMention = linkedPerMention;
idx.meta.linkedPlacesSource = 'kimatch egeret_places_decisions.json';
fs.writeFileSync(INDEX_OUT, JSON.stringify(idx, null, 2));
console.error(`entity-index: ${linkedFlat} flat + ${linkedPerMention} per-mention → ${path.relative(REPO, INDEX_OUT)}`);

// ── 2. Enrich NER export per place mention ──────────────────────────────────
const ner = JSON.parse(fs.readFileSync(NER_IN, 'utf8'));
const counts = {};
for (const letter of ner.results) {
  const places = letter.entities && letter.entities.places;
  if (!Array.isArray(places)) continue;
  for (const place of places) {
    const placeName = place.nameNormalized || place.name;
    const resolved = resolveFor(placeName, letter.id);
    Object.assign(place, resolved);
    counts[resolved.linked_by] = (counts[resolved.linked_by] || 0) + 1;
  }
}
ner.summary = ner.summary || {};
ner.summary.placeLinkingCounts = counts;
fs.writeFileSync(NER_OUT, JSON.stringify(ner));
console.error(`ner-linked: ${path.relative(REPO, NER_OUT)}`);
console.error('  place-mention counts by linked_by:');
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.error(`    ${k.padEnd(20)} ${v}`);
}
