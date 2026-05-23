#!/usr/bin/env node
/**
 * Build a compact letters-meta.json sidecar for the Kimatch review UI.
 *
 * For each of the 4,721 letters, emits:
 *   { id, sender, recipient, date, dateISO, location, title, ben_yehuda_url }
 *
 * No letter content — context excerpts aren't shown in the per-mention card;
 * the reviewer clicks through to Ben Yehuda for full text.
 *
 * Output: written to ../Kimatch/data/egeret/letters-meta.json so the deployed
 * Streamlit app reads it from its own repo.
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
const SRC  = path.join(REPO, 'output', 'e-geret-batch-export.json');
const DST  = path.resolve(REPO, '..', 'Kimatch', 'data', 'egeret', 'letters-meta.json');

const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));

// Decode numeric HTML entities (&#8220; → "), collapse whitespace.
function clean(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const out = {};
for (const r of data.results) {
  out[r.id] = {
    sender:    (r.extracted?.Sender || '').trim(),
    recipient: (r.extracted?.Recipient || '').trim(),
    date:      (r.extracted?.Date || '').trim(),
    dateISO:   (r.extracted?.DateISO || '').trim(),
    location:  (r.extracted?.Location || '').trim(),
    title:     (r.csvMetadata?.title || '').trim(),
    url:       (r.csvMetadata?.url || '').trim(),
    // Letter body — used by the backend to extract a windowed excerpt
    // around each place mention for the per-mention review card.
    content:   clean(r.extracted?.Content),
  };
}

fs.writeFileSync(DST, JSON.stringify(out));
const stat = fs.statSync(DST);
console.log(`Wrote ${Object.keys(out).length} letters → ${path.relative(REPO, DST)} (${(stat.size/1024).toFixed(0)} KB)`);
