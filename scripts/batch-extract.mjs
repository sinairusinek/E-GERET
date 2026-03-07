/**
 * E-GERET Standalone Batch Extractor
 * Runs independently of the browser/Vite server.
 * Reads corpus from disk, calls Gemini Flash, saves results to output/.
 * Resumes automatically from output/checkpoint.json if it exists.
 *
 * Usage: node scripts/batch-extract.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CORPUS_ROOT = path.resolve(ROOT, '..', 'public_domain_dump', 'html');
const OUTPUT_DIR = path.resolve(ROOT, 'output');
const CHECKPOINT_FILE = path.join(OUTPUT_DIR, 'checkpoint.json');
const CSV_FILE = path.join(ROOT, 'public', 'benyehuda-full-metadata.csv');
const PSEUDO_CSV = path.resolve(ROOT, '..', 'public_domain_dump', 'pseudocatalogue.csv');

const TIMEOUT_MS = 30_000;
const CHECKPOINT_EVERY = 50;
const CONCURRENCY = 10;              // parallel Gemini calls (paid tier)
const BATCH_DELAY_MS = 200;          // small pause between batches
const MAX_RETRIES = 3;               // retry up to 3× per unit
const CONSECUTIVE_FAIL_LIMIT = 10;  // pause after this many consecutive failures
const CONSECUTIVE_FAIL_PAUSE_MS = 60_000; // pause duration (1 min) before resuming
const SUPPLEMENT_MODE = process.argv.includes('--supplement'); // process only new files, merge into existing export

// ── Load API key ─────────────────────────────────────────────────────────────

const envPath = path.join(ROOT, '.env.local');
const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
const apiKeyMatch = envContent.match(/VITE_GEMINI_API_KEY\s*=\s*(.+)/);
const API_KEY = apiKeyMatch?.[1]?.trim();
if (!API_KEY) { console.error('No VITE_GEMINI_API_KEY in .env.local'); process.exit(1); }

const ai = new GoogleGenAI({ apiKey: API_KEY });

// ── HTML utilities (regex-based, no jsdom needed) ────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

function detectContainerTag(html) {
  if (/<h2[\s>]/i.test(html)) return 'h2';
  if (/<h3[\s>]/i.test(html)) return 'h3';
  if (/<h4[\s>]/i.test(html)) return 'h4';
  return 'body';
}

function detectFootnotePattern(html) {
  if (/class="[^"]*footnotes[^"]*"[\s\S]*?<li/i.test(html)) return 'div.footnotes li';
  if (/id="fn:/i.test(html)) return 'li[id^="fn:"]';
  return '';
}

function splitByHeading(html, tag) {
  // Split at each opening <h2>, <h3>, etc.
  const re = new RegExp(`(<${tag}[\\s>])`, 'gi');
  const parts = html.split(re);
  // parts = [before_first, '<h2 ', content, '<h2 ', content, ...]
  if (parts.length <= 1) return [html];
  const units = [];
  for (let i = 1; i < parts.length; i += 2) {
    const chunk = (parts[i] || '') + (parts[i + 1] || '');
    if (chunk.trim()) units.push(chunk);
  }
  return units.length > 0 ? units : [html];
}

function correlateFootnotes(sectionHtml, fullHtml) {
  const refs = [...sectionHtml.matchAll(/href="#(fn:[^"]+)"/gi)];
  return refs.map(m => {
    const id = m[1];
    const fnRe = new RegExp(`id="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>([\\s\\S]*?)<\\/li>`, 'i');
    const found = fullHtml.match(fnRe);
    return found ? `[${id}] ${stripHtml(found[1])}` : '';
  }).filter(Boolean).join('\n');
}

function extractUnits(html) {
  const tag = detectContainerTag(html);
  const fnPattern = detectFootnotePattern(html);
  let sections;
  if (tag === 'body') {
    sections = [html];
  } else {
    sections = splitByHeading(html, tag);
  }
  return sections.map((section, index) => ({
    index,
    fullText: stripHtml(section).slice(0, 8000),
    footnotes: fnPattern ? correlateFootnotes(section, html) : '',
    headingText: (section.match(/<h[1-6][^>]*>([^<]*)<\/h[1-6]>/i) || [])[1]?.trim() || '',
  }));
}

// ── CSV parsing ───────────────────────────────────────────────────────────────

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
      else if (ch === ',') { fields.push(current.trim()); current = ''; }
      else current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/** Build id→path index from pseudocatalogue.csv for fallback path resolution. */
function loadPseudoPaths() {
  if (!fs.existsSync(PSEUDO_CSV)) return {};
  const text = fs.readFileSync(PSEUDO_CSV, 'utf-8');
  const lines = text.split('\n').filter(l => l.trim());
  const headers = parseCSVRow(lines[0]);
  const col = {};
  headers.forEach((h, i) => col[h] = i);
  const index = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVRow(lines[i]);
    const id = cols[col['ID']];
    const p = cols[col['path']]; // e.g. /p370/m1752
    if (id && p) index[id] = path.join(CORPUS_ROOT, ...p.split('/').filter(Boolean)) + '.html';
  }
  return index;
}

function loadManifest() {
  const pseudoPaths = loadPseudoPaths();
  const text = fs.readFileSync(CSV_FILE, 'utf-8');
  const lines = text.split('\n').filter(l => l.trim());
  const headers = parseCSVRow(lines[0]);
  const col = {};
  headers.forEach((h, i) => col[h] = i);
  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVRow(lines[i]);
    if ((cols[col['genre']] || '') !== 'letters') continue;
    const id = parseInt(cols[col['id']], 10);
    const authorIds = (cols[col['author_ids']] || '').match(/\d+/g)?.map(Number) || [];
    const firstAuthorId = authorIds[0];
    if (!firstAuthorId || isNaN(id)) continue;
    let htmlPath = path.join(CORPUS_ROOT, `p${firstAuthorId}`, `m${id}.html`);
    // Fallback to pseudocatalogue path if primary doesn't exist
    if (!fs.existsSync(htmlPath) && pseudoPaths[String(id)]) {
      htmlPath = pseudoPaths[String(id)];
    }
    entries.push({
      csv: {
        id, title: cols[col['title']] || '',
        authorString: cols[col['author_string']] || '',
        authorIds, origLang: cols[col['orig_lang']] || '',
        origPublicationDate: cols[col['orig_publication_date']] || '',
        period: cols[col['period']] || '',
        intellectualProperty: cols[col['intellectual_property']] || '',
        url: cols[col['url']] || '',
        authorUris: cols[col['author_uris']] || '',
        translatorUris: cols[col['translator_uris']] || '',
        sourceEdition: cols[col['source_edition']] || '',
      },
      htmlPath,
    });
  }
  return entries;
}

// ── Gemini Flash classification ───────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Single attempt with a hard timeout. */
async function classifyWithTimeout(text, footnotes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Given this Hebrew/multilingual letter text, identify and extract the following fields.
Return each field's value as extracted from the text. If a field is not present, return "".

FIELDS TO EXTRACT:
- Recipient: Who the letter is addressed to (name/title from salutation or header)
- Sender: Who wrote/signed the letter (name from closing/signature)
- Date: The date as written in the original text (any format/language)
- DateISO: The date normalized to ISO 8601 (YYYY-MM-DD, YYYY-MM, or YYYY). Convert from any calendar.
- Location: Where the letter was written from (city/place name)
- Content: The main body text of the letter (FULL text, not a summary)
- Signature: The closing/signature block (valediction + name)

IMPORTANT:
- Recipient is who RECEIVES the letter, Sender is who WRITES it. Do not confuse them.
- For Content, include the FULL body text, not a summary or excerpt.
- For DateISO, convert Hebrew calendar dates to Gregorian if possible.

LETTER TEXT:
${text}`,
      config: {
        thinkingConfig: { thinkingBudget: 0 },  // disable thinking → much faster
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            Recipient: { type: Type.STRING }, Sender: { type: Type.STRING },
            Date: { type: Type.STRING }, DateISO: { type: Type.STRING },
            Location: { type: Type.STRING }, Content: { type: Type.STRING },
            Signature: { type: Type.STRING },
          },
          required: ['Recipient','Sender','Date','DateISO','Location','Content','Signature'],
        },
      },
    });
    clearTimeout(timer);
    const parsed = JSON.parse(response.text || '{}');
    parsed.Footnotes = footnotes || '';
    return parsed;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Classify with exponential-backoff retry.
 * Distinguishes quota errors (RESOURCE_EXHAUSTED / 429) from transient errors.
 */
async function classifyWithRetry(text, footnotes) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await classifyWithTimeout(text, footnotes);
      return result;
    } catch (err) {
      lastErr = err;
      const msg = (err.message || '').toLowerCase();
      const cause = (err.cause?.message || err.cause?.code || '').toLowerCase();
      const isQuota = msg.includes('resource_exhausted') || msg.includes('429') ||
                      msg.includes('quota') || cause.includes('resource_exhausted');
      const isTimeout = err.name === 'AbortError';

      if (attempt < MAX_RETRIES) {
        const delay = isQuota
          ? 60_000                        // quota hit → wait 1 min before retry
          : Math.pow(2, attempt) * 2_000; // transient → 2s, 4s, 8s
        const reason = isTimeout ? 'timeout' : isQuota ? 'quota' : `network (${cause || msg.slice(0, 60)})`;
        process.stdout.write(`\n  ↩ attempt ${attempt + 1} failed (${reason}), retrying in ${delay / 1000}s...`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

// ── Export helpers ────────────────────────────────────────────────────────────

function saveJSON(results, missing, existingOutputResults = []) {
  const newOutputResults = results.map(r => ({
    id: r.id, letterIndex: r.letterIndex, sourceFile: r.sourceFile, csvMetadata: r.csv, extracted: r.data,
  }));
  const allOutputResults = [...existingOutputResults, ...newOutputResults];
  const out = {
    summary: {
      totalLettersExtracted: allOutputResults.length,
      totalFiles: new Set(allOutputResults.map(r => r.sourceFile)).size,
      missingFiles: missing.length,
    },
    results: allOutputResults,
    missingFiles: missing.map(m => ({ id: m.csv.id, title: m.csv.title, htmlPath: m.htmlPath })),
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'e-geret-batch-export.json'), JSON.stringify(out, null, 2), 'utf-8');
}

/** TSV regeneration from output format (used in supplement mode and by backfill-sender). */
function saveTSVFromOutput(outputResults) {
  if (!outputResults.length) return;
  const fieldNames = [...new Set(outputResults.flatMap(r => Object.keys(r.extracted)))];
  const csvCols = ['id','title','authorString','period','origPublicationDate','origLang','intellectualProperty','url','authorUris','translatorUris','sourceEdition'];
  const esc = v => (v || '').replace(/\t/g,' ').replace(/\n/g,' ').replace(/\r/g,'');
  const header = [...csvCols, 'sourceFile','letterIndex','templateUsed', ...fieldNames].join('\t');
  const rows = outputResults.map(r => [
    ...csvCols.map(c => esc(String((r.csvMetadata || {})[c] ?? ''))),
    esc(r.sourceFile), String(r.letterIndex), esc(r.templateName || ''),
    ...fieldNames.map(f => esc(r.extracted[f] || '')),
  ].join('\t'));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'e-geret-batch-export.tsv'), '\uFEFF' + [header,...rows].join('\n'), 'utf-8');
}

function saveTSV(results) {
  if (!results.length) return;
  const fieldNames = [...new Set(results.flatMap(r => Object.keys(r.data)))];
  const csvCols = ['id','title','authorString','period','origPublicationDate','origLang','intellectualProperty','url','authorUris','translatorUris','sourceEdition'];
  const esc = v => (v || '').replace(/\t/g,' ').replace(/\n/g,' ').replace(/\r/g,'');
  const header = [...csvCols, 'sourceFile','letterIndex','templateUsed', ...fieldNames].join('\t');
  const rows = results.map(r => [
    ...csvCols.map(c => esc(String(r.csv[c] ?? ''))),
    esc(r.sourceFile), String(r.letterIndex), esc(r.templateName || ''),
    ...fieldNames.map(f => esc(r.data[f] || '')),
  ].join('\t'));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'e-geret-batch-export.tsv'), '\uFEFF' + [header,...rows].join('\n'), 'utf-8');
}

function saveDeferred(deferred) {
  fs.writeFileSync(path.join(OUTPUT_DIR, 'e-geret-deferred-files.json'), JSON.stringify(deferred, null, 2), 'utf-8');
}

function saveCheckpoint(results, deferred, totalUnits) {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({
    savedAt: new Date().toISOString(),
    classified: results.length, deferred: deferred.length, totalUnits,
    results, deferredList: deferred,
  }, null, 2), 'utf-8');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('Loading manifest...');
  let allEntries = loadManifest();
  console.log(`Manifest: ${allEntries.length} letter files`);

  // ── Supplement mode: load existing export and exclude already-processed files ──
  let existingOutputResults = [];
  if (SUPPLEMENT_MODE) {
    const exportPath = path.join(OUTPUT_DIR, 'e-geret-batch-export.json');
    if (!fs.existsSync(exportPath)) {
      console.error('--supplement requires an existing output/e-geret-batch-export.json'); process.exit(1);
    }
    const existingData = JSON.parse(fs.readFileSync(exportPath, 'utf-8'));
    existingOutputResults = existingData.results || [];
    const processedFileIds = new Set(
      existingOutputResults.map(r => { const m = r.sourceFile?.match(/m(\d+)/); return m?.[1]; }).filter(Boolean)
    );
    const before = allEntries.length;
    allEntries = allEntries.filter(e => !processedFileIds.has(String(e.csv.id)));
    console.log(`Supplement mode: ${processedFileIds.size} already processed, ${before - allEntries.length} excluded, ${allEntries.length} new to process`);
  }

  // Filter to files that exist on disk
  const entries = allEntries.filter(e => fs.existsSync(e.htmlPath));
  const missing = allEntries.filter(e => !fs.existsSync(e.htmlPath));
  console.log(`Available: ${entries.length}, Missing: ${missing.length}`);

  // ── PASS 1: DOM structural extraction ────────────────────────────────────
  console.log('\nPass 1: DOM structural extraction...');
  const pendingUnits = [];
  for (const entry of entries) {
    const html = fs.readFileSync(entry.htmlPath, 'utf-8');
    const units = extractUnits(html);
    for (const unit of units) {
      pendingUnits.push({ entry, unit });
    }
  }
  console.log(`Found ${pendingUnits.length} letter units across ${entries.length} files\n`);

  // ── Resume from checkpoint if available ──────────────────────────────────
  let results = [];
  let deferred = [];
  let startIndex = 0;

  if (!SUPPLEMENT_MODE && fs.existsSync(CHECKPOINT_FILE)) {
    try {
      const ckpt = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf-8'));
      const alreadyDone = new Set(ckpt.results?.map(r => r.id) || []);
      results = ckpt.results || [];
      // Clear old deferred list — those units will be retried fresh this run
      deferred = [];
      // Find where to resume: first unit whose id isn't already in results
      startIndex = pendingUnits.findIndex(({ entry, unit }) =>
        !alreadyDone.has(`${entry.csv.id}-${unit.index}`)
      );
      if (startIndex === -1) startIndex = pendingUnits.length; // all done
      console.log(`Resuming from checkpoint: ${results.length} already classified, starting at unit ${startIndex} (old deferred list cleared for retry)`);
    } catch {
      console.log('Checkpoint unreadable, starting fresh');
    }
  }

  // ── PASS 2: Flash classification (concurrent batches) ────────────────────
  console.log('Pass 2: Flash classification...');
  const total = pendingUnits.length;
  let consecutiveFails = 0;
  let batchCount = 0;

  for (let i = startIndex; i < total; i += CONCURRENCY) {
    const batch = pendingUnits.slice(i, Math.min(i + CONCURRENCY, total));

    // Classify all units in this batch concurrently
    const settled = await Promise.allSettled(
      batch.map(({ entry, unit }) =>
        classifyWithRetry(unit.fullText, unit.footnotes)
          .then(classified => ({ ok: true, entry, unit, classified }))
          .catch(err => ({ ok: false, entry, unit, err }))
      )
    );

    for (const s of settled) {
      const { ok, entry, unit, classified, err } = s.value;
      const id = `${entry.csv.id}-${unit.index}`;
      if (ok) {
        consecutiveFails = 0;
        results.push({
          id,
          sourceFile: path.relative(CORPUS_ROOT, entry.htmlPath),
          csv: entry.csv,
          letterIndex: unit.index + 1,
          data: classified,
          templateName: 'auto-structural',
        });
      } else {
        consecutiveFails++;
        const msg = (err && err.message) || '';
        const cause = (err && (err.cause?.message || err.cause?.code)) || '';
        const reason = (err && err.name === 'AbortError') ? 'flash-timeout' : 'flash-error';
        deferred.push({
          fileId: entry.csv.id, title: entry.csv.title,
          htmlPath: entry.htmlPath, reason,
          error: cause ? `${msg} (cause: ${cause})` : msg,
        });
        process.stdout.write(`\n  ✗ [${id}] ${reason}: ${cause || msg.slice(0, 80)}`);
      }
    }

    const processed = Math.min(i + CONCURRENCY, total);
    const pct = Math.round((processed / total) * 100);
    process.stdout.write(`\r${processed}/${total} (${pct}%) | done: ${results.length} | deferred: ${deferred.length}   `);

    // Checkpoint every N batches
    batchCount++;
    if (batchCount % Math.ceil(CHECKPOINT_EVERY / CONCURRENCY) === 0) {
      saveCheckpoint(results, deferred, total);
    }

    // Too many consecutive failures → pause (likely quota exhausted)
    if (consecutiveFails >= CONSECUTIVE_FAIL_LIMIT) {
      process.stdout.write(`\n\n⚠️  ${consecutiveFails} consecutive failures. Pausing ${CONSECUTIVE_FAIL_PAUSE_MS / 1000}s...`);
      saveCheckpoint(results, deferred, total);
      await sleep(CONSECUTIVE_FAIL_PAUSE_MS);
      consecutiveFails = 0;
      process.stdout.write(' Resuming.\n');
    }

    // Small pause between batches to avoid burst
    await sleep(BATCH_DELAY_MS);
  }

  console.log('\n\nSaving final output...');
  saveCheckpoint(results, deferred, total);
  saveJSON(results, missing, existingOutputResults);
  if (SUPPLEMENT_MODE) {
    // Regenerate TSV from merged output format so all records have consistent columns
    const allOutputResults = [
      ...existingOutputResults,
      ...results.map(r => ({ id: r.id, letterIndex: r.letterIndex, sourceFile: r.sourceFile, csvMetadata: r.csv, extracted: r.data })),
    ];
    saveTSVFromOutput(allOutputResults);
  } else {
    saveTSV(results);
  }
  if (deferred.length > 0) saveDeferred(deferred);

  console.log(`\n✓ Done!`);
  if (SUPPLEMENT_MODE) {
    console.log(`  ${results.length} new letters added; total ${existingOutputResults.length + results.length} in export`);
  } else {
    console.log(`  ${results.length} letters saved to output/e-geret-batch-export.json + .tsv`);
  }
  if (deferred.length > 0) console.log(`  ${deferred.length} deferred → output/e-geret-deferred-files.json`);
  if (missing.length > 0) console.log(`  ${missing.length} files not found on disk`);
}

main().catch(err => { console.error('\nFatal:', err); process.exit(1); });
