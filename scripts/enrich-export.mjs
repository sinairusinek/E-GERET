/**
 * One-shot script: Backfill existing JSON/TSV export with 3 new pseudocatalogue fields.
 * Adds authorUris, translatorUris, sourceEdition to each result's csvMetadata.
 * Regenerates both JSON and TSV.
 *
 * Usage: node scripts/enrich-export.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.resolve(ROOT, 'output');
const JSON_FILE = path.join(OUTPUT_DIR, 'e-geret-batch-export.json');
const TSV_FILE = path.join(OUTPUT_DIR, 'e-geret-batch-export.tsv');
const PSEUDO_CSV = path.resolve(ROOT, '..', 'public_domain_dump', 'pseudocatalogue.csv');

// ── CSV parsing ──────────────────────────────────────────────────────────────

function parseCSVRow(line) {
  const fields = []; let current = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i+1] === '"') { current += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { fields.push(current); current = ''; }
      else current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ── Load pseudocatalogue index ───────────────────────────────────────────────

console.log('Loading pseudocatalogue...');
const pseudoText = fs.readFileSync(PSEUDO_CSV, 'utf-8');
const pseudoLines = pseudoText.split('\n').filter(l => l.trim());
const pseudoHeaders = parseCSVRow(pseudoLines[0]);
const pseudoCol = {};
pseudoHeaders.forEach((h, i) => pseudoCol[h] = i);

const pseudoIndex = {};
for (let i = 1; i < pseudoLines.length; i++) {
  const cols = parseCSVRow(pseudoLines[i]);
  const id = cols[pseudoCol['ID']];
  if (!id) continue;
  pseudoIndex[id] = {
    authorUris: cols[pseudoCol['author_uris']] || '',
    translatorUris: cols[pseudoCol['translator_uris']] || '',
    sourceEdition: cols[pseudoCol['source_edition']] || '',
  };
}
console.log(`Pseudocatalogue: ${Object.keys(pseudoIndex).length} entries indexed`);

// ── Enrich export ────────────────────────────────────────────────────────────

console.log('Loading export JSON...');
const data = JSON.parse(fs.readFileSync(JSON_FILE, 'utf-8'));
const total = data.results.length;

let enriched = 0;
let noMatch = 0;

for (const r of data.results) {
  const id = String(r.csvMetadata?.id ?? '');
  const pseudo = pseudoIndex[id];
  if (pseudo) {
    r.csvMetadata.authorUris = pseudo.authorUris;
    r.csvMetadata.translatorUris = pseudo.translatorUris;
    r.csvMetadata.sourceEdition = pseudo.sourceEdition;
    enriched++;
  } else {
    r.csvMetadata.authorUris = r.csvMetadata.authorUris || '';
    r.csvMetadata.translatorUris = r.csvMetadata.translatorUris || '';
    r.csvMetadata.sourceEdition = r.csvMetadata.sourceEdition || '';
    noMatch++;
  }
}

console.log(`Enriched: ${enriched}, No match: ${noMatch}, Total: ${total}`);

// ── Save JSON ────────────────────────────────────────────────────────────────

console.log('Saving JSON...');
fs.writeFileSync(JSON_FILE, JSON.stringify(data, null, 2), 'utf-8');

// ── Regenerate TSV ───────────────────────────────────────────────────────────

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

console.log('\n✓ Done! JSON and TSV updated with authorUris, translatorUris, sourceEdition.');
