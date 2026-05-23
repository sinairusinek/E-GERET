#!/usr/bin/env node
/**
 * Extract recipient locations from each letter's Recipient field.
 *
 * The Recipient field is free text and often includes the recipient's
 * place ("ד\"ר יעקב טהון, ירושלים", "Herrn Senior Sachs in Berlin",
 * "למר מ. ז. פייערברג, נובוגרד-וואלינסק"). For each letter we scan the
 * Recipient field for the longest substring that matches a known linked
 * place (a Hebrew Location string with coordinates OR a Hebrew/Roman
 * variant of a Kima place we've already mapped). When found, we take it
 * as the recipient location for arrow drawing.
 *
 * Inputs:
 *   output/e-geret-batch-export.json
 *   output/location-links.json   (Hebrew Location → Kima)
 *   output/entity-index.json     (nameHeb of NER places — for variants)
 *   Kimatch/data/egeret/egeret_places_decisions.json
 *
 * Output:
 *   output/recipient-locations.json
 *     { letter_id: {
 *         matched_substring,
 *         kima_id, kima_name_rom, kima_name_heb, lat, lon
 *       }, ... }
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
const KIMATCH = path.resolve(REPO, '..', 'Kimatch');
const BATCH = path.join(REPO, 'output', 'e-geret-batch-export.json');
const LOC   = path.join(REPO, 'output', 'location-links.json');
const IDX   = path.join(REPO, 'output', 'entity-index.json');
const DEC   = path.join(KIMATCH, 'data', 'egeret', 'egeret_places_decisions.json');
const OUT   = path.join(REPO, 'output', 'recipient-locations.json');

const batch = JSON.parse(fs.readFileSync(BATCH, 'utf8'));
const locLinks = JSON.parse(fs.readFileSync(LOC, 'utf8'));
const idx = JSON.parse(fs.readFileSync(IDX, 'utf8'));
const decisions = JSON.parse(fs.readFileSync(DEC, 'utf8'));

// Build kima_id → {rom, heb, lat, lon} from anything we've linked
const kimaInfo = new Map();
for (const v of Object.values(locLinks)) {
  if (v.kima_id && v.lat != null) kimaInfo.set(Number(v.kima_id), v);
}

// Build place-string → kima_id from Locations (Hebrew strings)
const phraseToKima = new Map();
for (const [str, link] of Object.entries(locLinks)) {
  if (link.kima_id && link.lat != null) {
    phraseToKima.set(str, Number(link.kima_id));
  }
}
// Also add nameHeb of NER places with a decision (covers more spellings)
for (const p of idx.places) {
  const dec = decisions[p.name];
  if (!dec) continue;
  const action = dec.action || '';
  if (!action.startsWith('map_to:')) continue;
  const kid = Number(action.slice(7));
  if (!Number.isFinite(kid)) continue;
  // Cache info for kima id if not already
  if (!kimaInfo.has(kid)) {
    kimaInfo.set(kid, { kima_id: kid });   // lat/lon may be missing; rely on coords lookup later
  }
  const heb = (p.nameHeb || '').trim();
  if (heb && !phraseToKima.has(heb)) phraseToKima.set(heb, kid);
  // English form too (Recipient field occasionally Roman: "Herrn Sachs in Berlin")
  const rom = (p.name || '').trim();
  if (rom && !phraseToKima.has(rom)) phraseToKima.set(rom, kid);
}

// Need coordinates for every kima_id in phraseToKima. Pull from location-links
// where present; for the rest, ask the Kima db via a tiny Python sidecar would
// be heavy — instead we just skip phrases whose kima_id has no coords. (The
// majority of linked Locations DO have coords; this affects only a few.)
const coordsByKima = new Map();
for (const [k, v] of kimaInfo) {
  if (v.lat != null && v.lon != null) coordsByKima.set(k, v);
}

// Drop phrases pointing at coordinate-less Kima ids
for (const [phrase, kid] of [...phraseToKima]) {
  if (!coordsByKima.has(kid)) phraseToKima.delete(phrase);
}

// Hebrew words that happen to BE Kima place names but in free-text Recipient
// context are almost always common-noun homographs ("here", "land", etc.).
// Drop them to suppress false-positive arrows.
const STOPWORDS = new Set([
  'פה', 'ארץ', 'יהוד', 'ציון',     // here / land / Judah-or-Jew / Zion (generic)
  'עיר', 'כפר', 'בית',             // city / village / house
]);
for (const phrase of [...phraseToKima.keys()]) {
  if (phrase.length < 4) phraseToKima.delete(phrase);
  else if (STOPWORDS.has(phrase)) phraseToKima.delete(phrase);
}

// Sort phrases by length (longest first) so "תל אביב" matches before "תל"
const sortedPhrases = [...phraseToKima.keys()].sort((a, b) => b.length - a.length);

console.error(`${sortedPhrases.length} phrase candidates with coordinates`);

// Scan Recipient fields
const out = {};
let nLetters = 0, nMatched = 0, nSelfLoop = 0;
const matchCounts = new Map();
for (const r of batch.results) {
  const recip = (r.extracted?.Recipient || '').trim();
  const senderLoc = (r.extracted?.Location || '').trim();
  if (!recip) continue;
  nLetters++;
  let best = null;
  for (const phrase of sortedPhrases) {
    if (recip.includes(phrase)) { best = phrase; break; }
  }
  if (!best) continue;
  const kid = phraseToKima.get(best);
  const info = coordsByKima.get(kid);
  // Detect when recipient and sender resolve to the same Kima place — record
  // but mark, since drawing a "self-arrow" is pointless on the map.
  let isSelf = false;
  if (senderLoc && locLinks[senderLoc]?.kima_id === kid) isSelf = true;
  if (isSelf) nSelfLoop++;
  out[r.id] = {
    matched_substring: best,
    kima_id:           kid,
    kima_name_rom:     info.kima_name_rom || '',
    kima_name_heb:     info.kima_name_heb || '',
    lat:               info.lat,
    lon:               info.lon,
    self_loop:         isSelf,
  };
  nMatched++;
  matchCounts.set(best, (matchCounts.get(best) || 0) + 1);
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

console.error(`\nletters with Recipient: ${nLetters}`);
console.error(`recipient-location extracted: ${nMatched} (${(nMatched/nLetters*100).toFixed(1)}%)`);
console.error(`  self-loop (same place as sender): ${nSelfLoop}`);
console.error(`\ntop matched phrases:`);
for (const [p, c] of [...matchCounts].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.error(`  ${String(c).padStart(4)}  ${p}`);
}
console.error(`\n→ ${path.relative(REPO, OUT)}`);
