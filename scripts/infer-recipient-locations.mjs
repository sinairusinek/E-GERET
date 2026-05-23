#!/usr/bin/env node
/**
 * Infer recipient locations using a conservative "flanking anchors" rule.
 *
 * RULE (per Sinai, 2026-05-23):
 *   For person P, a letter L without an explicit recipient location, we may
 *   infer location K iff
 *     (a) P has an anchor at K *before* L.date AND
 *     (b) P has an anchor at K *after* L.date AND
 *     (c) NO anchor at a *different* location exists in the gap.
 *
 *   An "anchor" for P is a known (date, kima_id) pair from either:
 *     • a letter where P is the Sender and the letter has a linked Location, OR
 *     • a letter where P is the Recipient and we extracted an explicit
 *       recipient location (extract-recipient-locations.mjs).
 *
 *   This refuses to fabricate a location for someone who moved around — if
 *   their anchors disagree, no inference is made.
 *
 *   Every inferred location is tagged `via: "inferred"` and carries the two
 *   anchor letter ids, so derived data can be filtered or audited later.
 *
 * Inputs:
 *   output/e-geret-batch-export.json
 *   output/location-links.json
 *   output/recipient-locations.json   (explicit recipient locations only)
 *
 * Output:
 *   output/recipient-locations.inferred.json
 *     superset of recipient-locations.json: same keys for the explicit
 *     entries (with via:"extracted") plus new keys for inferred letters
 *     (with via:"inferred", anchor_before, anchor_after).
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
const BATCH    = path.join(REPO, 'output', 'e-geret-batch-export.json');
const LOC      = path.join(REPO, 'output', 'location-links.json');
const RECIP_EX = path.join(REPO, 'output', 'recipient-locations.json');
const OUT      = path.join(REPO, 'output', 'recipient-locations.inferred.json');

const batch    = JSON.parse(fs.readFileSync(BATCH, 'utf8'));
const links    = JSON.parse(fs.readFileSync(LOC, 'utf8'));
const recipEx  = JSON.parse(fs.readFileSync(RECIP_EX, 'utf8'));

// Generic non-name recipient strings to skip (titles, roles, organizations
// commonly addressed in the corpus).
const GENERIC_RECIPIENTS = new Set([
  'ידידי', 'אשתו', 'הנ"ל', 'ידידי היקר', 'הוריו', 'אחי היקר', 'בני היקר',
  'הנהגת ב"מ', 'אחיאסף', 'ידידי!', 'אחי', 'בני', 'אבי', 'אמי', 'אחותי',
  'ידיד', 'ידידיו', 'חבר', 'חברי', 'חברתי', 'אדוני', 'אדון', 'גברתי',
  'להנ"ל', 'להנהלת אחיאסף', 'להוצאת אחיאסף',
]);

function clean(s) {
  if (!s) return '';
  s = s.trim().replace(/[.,;:!?]+$/, '').trim();
  s = s.split(',')[0].trim();
  // Drop common Hebrew title prefixes
  const prefixes = ['מר ', 'מ"ר ', 'ד"ר ', "ד'ר ", 'הד"ר ', 'הרב ', 'אדוני ',
    'אדון ', 'לאדון ', 'ה' + "'" + ' ', 'Herrn ', 'Mr. ', 'Dr. ', 'Frau '];
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of prefixes) {
      if (s.startsWith(p)) { s = s.slice(p.length).trim(); changed = true; }
    }
  }
  return s;
}

function isoOf(letter) {
  return (letter.extracted?.DateISO || '').trim() || null;
}

function kimaOfLocation(letter) {
  const loc = (letter.extracted?.Location || '').trim();
  const link = loc && links[loc];
  if (link && link.kima_id && link.lat != null) return Number(link.kima_id);
  return null;
}

// ── 1. Build anchor timeline per cleaned person name ────────────────────────
// anchors: Map<name, Array<{date, kima_id, letter_id, role}>>
const anchors = new Map();
function addAnchor(name, entry) {
  if (!name || !entry.date || entry.kima_id == null) return;
  if (!anchors.has(name)) anchors.set(name, []);
  anchors.get(name).push(entry);
}

for (const r of batch.results) {
  const date = isoOf(r);
  if (!date) continue;
  const senderName = clean(r.extracted?.Sender);
  const recipName  = clean(r.extracted?.Recipient);

  // Anchor from sender + Location
  const senderKima = kimaOfLocation(r);
  if (senderName && senderKima != null) {
    addAnchor(senderName, { date, kima_id: senderKima, letter_id: r.id, role: 'sender' });
  }

  // Anchor from explicit recipient location (when known)
  const recipEntry = recipEx[r.id];
  if (recipName && recipEntry && recipEntry.kima_id != null) {
    addAnchor(recipName, { date, kima_id: Number(recipEntry.kima_id), letter_id: r.id, role: 'recipient' });
  }
}

// Sort each timeline by date
for (const arr of anchors.values()) arr.sort((a, b) => a.date.localeCompare(b.date));

console.error(`Persons with ≥1 anchor: ${anchors.size}`);
const multi = [...anchors.values()].filter(a => a.length >= 2).length;
console.error(`Persons with ≥2 anchors (eligible for inference): ${multi}`);

// ── 2. Inference pass ───────────────────────────────────────────────────────
// Take location-links coords to copy into inferred entries
const inferred = { ...recipEx };
// Tag existing as extracted
for (const k of Object.keys(inferred)) {
  if (!inferred[k].via) inferred[k].via = 'extracted';
}

// Build kima_id → coords lookup from location-links (only kima ids that
// already have coords; if the inference picks an anchor kima_id we always
// have coords because anchors are derived from linked Locations).
const coordsByKima = new Map();
for (const v of Object.values(links)) {
  if (v.kima_id && v.lat != null) {
    coordsByKima.set(Number(v.kima_id), {
      kima_id:       Number(v.kima_id),
      kima_name_rom: v.kima_name_rom || '',
      kima_name_heb: v.kima_name_heb || '',
      lat:           v.lat,
      lon:           v.lon,
    });
  }
}

let nInferred = 0, nConflict = 0, nNoAnchors = 0, nOnlyOneSide = 0,
    nGeneric = 0, nAlreadyHas = 0, nAnchorIsSelf = 0, nNoDate = 0;

for (const r of batch.results) {
  if (inferred[r.id]) { nAlreadyHas++; continue; }
  const date = isoOf(r);
  if (!date) { nNoDate++; continue; }
  const recipName = clean(r.extracted?.Recipient);
  if (!recipName) continue;
  if (GENERIC_RECIPIENTS.has(recipName)) { nGeneric++; continue; }

  const tl = anchors.get(recipName);
  if (!tl || tl.length < 2) { nNoAnchors++; continue; }

  // Find flanking anchors. Exclude the letter itself from anchor pool (it
  // shouldn't be in there anyway — only sender / explicit-recipient anchors).
  let before = null, after = null;
  for (const a of tl) {
    if (a.letter_id === r.id) continue;
    if (a.date < date) {
      if (!before || a.date > before.date) before = a;
    } else if (a.date > date) {
      if (!after || a.date < after.date) after = a;
    }
    // a.date === date: ignore (same-day ambiguity)
  }

  if (!before || !after) { nOnlyOneSide++; continue; }
  if (before.kima_id !== after.kima_id) { nConflict++; continue; }

  // SELF-LOOP CHECK: if the inferred recipient kima matches the sender's
  // own Location on this letter, the arrow would be self-loop; record but
  // mark.
  const senderKima = kimaOfLocation(r);
  const isSelf = senderKima != null && senderKima === before.kima_id;
  if (isSelf) nAnchorIsSelf++;

  const info = coordsByKima.get(before.kima_id);
  if (!info) continue;   // safety: anchor came from a linked Location so this should exist

  inferred[r.id] = {
    ...info,
    matched_substring: recipName,
    self_loop:         isSelf,
    via:               'inferred',
    anchor_before:     { letter_id: before.letter_id, date: before.date, role: before.role },
    anchor_after:      { letter_id: after.letter_id,  date: after.date,  role: after.role },
  };
  nInferred++;
}

fs.writeFileSync(OUT, JSON.stringify(inferred, null, 2));

const nExtracted = Object.values(inferred).filter(v => v.via === 'extracted').length;
const nInf = Object.values(inferred).filter(v => v.via === 'inferred').length;
console.error('');
console.error(`Inference pass:`);
console.error(`  newly inferred       : ${nInferred}`);
console.error(`    - of which self-loop: ${nAnchorIsSelf}`);
console.error(`  conflicting anchors  : ${nConflict}  (refused per rule)`);
console.error(`  anchors only on one side: ${nOnlyOneSide}`);
console.error(`  recipient has no ≥2 anchors: ${nNoAnchors}`);
console.error(`  recipient is generic : ${nGeneric}`);
console.error(`  already had explicit : ${nAlreadyHas}`);
console.error(`  letter has no DateISO: ${nNoDate}`);
console.error('');
console.error(`Combined recipient-locations: ${Object.keys(inferred).length}`);
console.error(`  extracted: ${nExtracted}`);
console.error(`  inferred : ${nInf}`);
console.error(`\n→ ${path.relative(REPO, OUT)}`);
