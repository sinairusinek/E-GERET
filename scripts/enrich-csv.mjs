/**
 * One-shot script: Enrich benyehuda-full-metadata.csv with 3 columns from pseudocatalogue.csv.
 * Adds: author_uris, translator_uris, source_edition
 * Joins on id (our CSV) = ID (pseudocatalogue).
 *
 * Usage: node scripts/enrich-csv.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PSEUDO_CSV = path.resolve(ROOT, '..', 'public_domain_dump', 'pseudocatalogue.csv');
const CSV_FILE = path.join(ROOT, 'benyehuda-full-metadata.csv');
const CSV_PUBLIC = path.join(ROOT, 'public', 'benyehuda-full-metadata.csv');

// ── CSV parsing (same as batch-extract.mjs) ──────────────────────────────────

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

function escapeCSVField(value) {
  if (!value) return '';
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

// ── Load pseudocatalogue index ───────────────────────────────────────────────

console.log('Loading pseudocatalogue...');
const pseudoText = fs.readFileSync(PSEUDO_CSV, 'utf-8');
const pseudoLines = pseudoText.split('\n').filter(l => l.trim());
const pseudoHeaders = parseCSVRow(pseudoLines[0]);
const pseudoCol = {};
pseudoHeaders.forEach((h, i) => pseudoCol[h] = i);

const pseudoIndex = {}; // id → { author_uris, translator_uris, source_edition }
for (let i = 1; i < pseudoLines.length; i++) {
  const cols = parseCSVRow(pseudoLines[i]);
  const id = cols[pseudoCol['ID']];
  if (!id) continue;
  pseudoIndex[id] = {
    author_uris: cols[pseudoCol['author_uris']] || '',
    translator_uris: cols[pseudoCol['translator_uris']] || '',
    source_edition: cols[pseudoCol['source_edition']] || '',
  };
}
console.log(`Pseudocatalogue: ${Object.keys(pseudoIndex).length} entries indexed`);

// ── Enrich our CSV ───────────────────────────────────────────────────────────

console.log('Loading benyehuda-full-metadata.csv...');
const csvText = fs.readFileSync(CSV_FILE, 'utf-8');
const csvLines = csvText.split('\n');

// Check if already enriched
const header = csvLines[0];
if (header.includes('author_uris')) {
  console.log('CSV already contains author_uris column — skipping enrichment.');
  process.exit(0);
}

const enrichedLines = [];
// Append new columns to header
enrichedLines.push(header.trimEnd() + ',author_uris,translator_uris,source_edition');

let matched = 0;
let unmatched = 0;

for (let i = 1; i < csvLines.length; i++) {
  const line = csvLines[i];
  if (!line.trim()) continue;
  const cols = parseCSVRow(line);
  // id is column index 1 (file_name=0, id=1)
  const id = cols[1];
  const pseudo = pseudoIndex[id];
  if (pseudo) {
    matched++;
    enrichedLines.push(
      line.trimEnd() + ',' +
      escapeCSVField(pseudo.author_uris) + ',' +
      escapeCSVField(pseudo.translator_uris) + ',' +
      escapeCSVField(pseudo.source_edition)
    );
  } else {
    unmatched++;
    enrichedLines.push(line.trimEnd() + ',,,');
  }
}

const output = enrichedLines.join('\n') + '\n';

// Write to both locations
fs.writeFileSync(CSV_FILE, output, 'utf-8');
fs.writeFileSync(CSV_PUBLIC, output, 'utf-8');

console.log(`\n✓ Enriched CSV written to:`);
console.log(`  ${CSV_FILE}`);
console.log(`  ${CSV_PUBLIC}`);
console.log(`  Matched: ${matched}, Unmatched: ${unmatched}, Total data rows: ${matched + unmatched}`);
