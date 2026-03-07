/**
 * Post-processing: backfill missing Sender fields from CSV authorString metadata.
 *
 * Pattern: most letters without explicit senders come from single-author collections
 * (e.g. "אגרות דוד ילין", "איגרות אחד העם") where csvMetadata.authorString IS the sender.
 *
 * This script:
 * 1. Reads e-geret-batch-export.json
 * 2. For each letter with empty/placeholder Sender, fills from csvMetadata.authorString
 * 3. Adds SenderSource field: "extracted" (original) or "csv-metadata" (backfilled)
 * 4. Rewrites both JSON and TSV exports
 *
 * Usage: node scripts/backfill-sender.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '..', 'output');
const JSON_FILE = path.join(OUTPUT_DIR, 'e-geret-batch-export.json');
const TSV_FILE = path.join(OUTPUT_DIR, 'e-geret-batch-export.tsv');

function isMissingSender(sender) {
  if (!sender || sender === '') return true;
  const s = sender.trim();
  if (s === '') return true;
  const placeholders = ['לא צוין', 'לא נמצא', 'לא ידוע', 'N/A', 'unknown', 'n/a', 'לא צויין'];
  return placeholders.some(p => s.includes(p));
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('Loading dataset...');
const data = JSON.parse(fs.readFileSync(JSON_FILE, 'utf-8'));
const total = data.results.length;

let backfilled = 0;
let alreadyHad = 0;
let stillMissing = 0;

for (const r of data.results) {
  if (isMissingSender(r.extracted.Sender)) {
    const author = (r.csvMetadata && r.csvMetadata.authorString) || '';
    if (author && author.trim() !== '') {
      r.extracted.Sender = author.trim();
      r.extracted.SenderSource = 'csv-metadata';
      backfilled++;
    } else {
      r.extracted.SenderSource = 'missing';
      stillMissing++;
    }
  } else {
    r.extracted.SenderSource = 'extracted';
    alreadyHad++;
  }
}

console.log(`\nResults:`);
console.log(`  Already had sender (extracted): ${alreadyHad}`);
console.log(`  Backfilled from CSV author:     ${backfilled}`);
console.log(`  Still missing (no CSV author):   ${stillMissing}`);
console.log(`  Total:                           ${total}`);
console.log(`  New sender coverage:             ${alreadyHad + backfilled} / ${total} (${Math.round((alreadyHad + backfilled) / total * 100)}%)`);

// Update summary
data.summary.senderBackfilled = backfilled;
data.summary.senderCoverage = `${alreadyHad + backfilled}/${total} (${Math.round((alreadyHad + backfilled) / total * 100)}%)`;

// ── Save JSON ─────────────────────────────────────────────────────────────────

console.log('\nSaving JSON...');
fs.writeFileSync(JSON_FILE, JSON.stringify(data, null, 2), 'utf-8');

// ── Regenerate TSV ────────────────────────────────────────────────────────────

console.log('Saving TSV...');
const fieldNames = [...new Set(data.results.flatMap(r => Object.keys(r.extracted)))];
const csvCols = ['id', 'title', 'authorString', 'period', 'origPublicationDate', 'origLang', 'intellectualProperty', 'url', 'authorUris', 'translatorUris', 'sourceEdition'];
const esc = v => (v || '').replace(/\t/g, ' ').replace(/\n/g, ' ').replace(/\r/g, '');
const header = [...csvCols, 'sourceFile', 'letterIndex', 'templateUsed', ...fieldNames].join('\t');
const rows = data.results.map(r => [
  ...csvCols.map(c => esc(String((r.csvMetadata || {})[c] ?? ''))),
  esc(r.sourceFile), String(r.letterIndex), esc(r.templateName || ''),
  ...fieldNames.map(f => esc(r.extracted[f] || '')),
].join('\t'));
fs.writeFileSync(TSV_FILE, '\uFEFF' + [header, ...rows].join('\n'), 'utf-8');

console.log('\n✓ Done! Both JSON and TSV updated.');
