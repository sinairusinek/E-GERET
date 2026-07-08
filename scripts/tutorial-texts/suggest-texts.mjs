/**
 * Adds a Gemini-generated `suggestion` column to tutorial-texts.tsv:
 * one alternative Hebrew phrasing per row, markup and technical terms preserved.
 * apply-texts.py ignores the extra column; extract-texts.py drops it on the
 * next extraction round (suggestions are per-round scaffolding, not state).
 *
 * Usage: node scripts/tutorial-texts/suggest-texts.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const TSV = path.join(__dirname, 'tutorial-texts.tsv');

const MODEL = 'gemini-3-flash-preview';
const BATCH_SIZE = 12;
const CONCURRENCY = 6;
const MAX_RETRIES = 3;

const key = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf-8').match(/VITE_GEMINI_API_KEY=(.+)/);
if (!key) throw new Error('VITE_GEMINI_API_KEY not found in .env.local');
const ai = new GoogleGenAI({ apiKey: key[1].trim() });

// ── TSV round-trip (same tab-split convention as apply-texts.py) ─────────────

const lines = fs.readFileSync(TSV, 'utf-8').replace(/\r\n?/g, '\n').split('\n');
const header = lines[0].split('\t');
const rows = lines.slice(1).filter(l => l.trim()).map(l => {
  const parts = l.split('\t', header.length);
  return Object.fromEntries(header.map((h, i) => [h, parts[i] ?? '']));
});
console.log(`${rows.length} rows read`);

const HEBREW = /[א-ת]/;
const candidates = rows.filter(r => HEBREW.test(r.text));
console.log(`${candidates.length} rows with Hebrew text → requesting suggestions`);

// ── Gemini ───────────────────────────────────────────────────────────────────

const SYSTEM = `אתם עורכי לשון של אתר לימוד עברי (RTL) על תיוג טקסטים: Markdown, HTML, XML, TEI, זיהוי ישויות (NER) ונתונים מקושרים. תקבלו רשימת מחרוזות ממשק ותוכן הדרכתי, ולכל אחת תציעו ניסוח חלופי אחד — בהיר, מדויק ובגובה העיניים, בלי לוותר על הדיוק המקצועי.

כללים מחייבים:
- שמרו על כל תגיות ה־HTML, התכונות והמבנה בדיוק כפי שהם; שנו רק את הטקסט העברי שביניהן.
- אל תשנו תוכן שבתוך <code>...</code>, מונחים טכניים, מילים באנגלית, שמות מוצרים, סמלים (⤓, ←) ורצפי escape כמו \\n.
- אורך דומה למקור (זהו ממשק — כפתור נשאר קצר, פסקה נשארת פסקה).
- אם למחרוזת אין מה לשפר או שאין בה עברית של ממש, החזירו מחרוזת ריקה.
- אל תוסיפו תווי טאב או שורות חדשות.`;

const schema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.STRING },
      alt: { type: Type.STRING },
    },
    required: ['id', 'alt'],
  },
};

async function suggestBatch(batch, attempt = 0) {
  try {
    const res = await ai.models.generateContent({
      model: MODEL,
      contents: JSON.stringify(batch.map(r => ({ id: r.id, text: r.text }))),
      config: {
        systemInstruction: SYSTEM,
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 0.7,
      },
    });
    return JSON.parse(res.text);
  } catch (err) {
    if (attempt >= MAX_RETRIES) throw err;
    const wait = /429|quota/i.test(String(err)) ? 60_000 : 2_000 * 2 ** attempt;
    console.log(`  retry ${attempt + 1} in ${wait / 1000}s: ${String(err).slice(0, 80)}`);
    await new Promise(r => setTimeout(r, wait));
    return suggestBatch(batch, attempt + 1);
  }
}

const batches = [];
for (let i = 0; i < candidates.length; i += BATCH_SIZE) batches.push(candidates.slice(i, i + BATCH_SIZE));

const suggestions = new Map();
let done = 0;
for (let i = 0; i < batches.length; i += CONCURRENCY) {
  const results = await Promise.all(batches.slice(i, i + CONCURRENCY).map(b =>
    suggestBatch(b).catch(err => { console.log(`  batch failed: ${String(err).slice(0, 100)}`); return []; })
  ));
  for (const arr of results) for (const { id, alt } of arr) suggestions.set(id, alt);
  done = Math.min(i + CONCURRENCY, batches.length);
  console.log(`${done}/${batches.length} batches`);
}

// ── write back with the extra column ─────────────────────────────────────────

const clean = s => (s || '').replace(/[\t\n\r]+/g, ' ').trim();
const out = [[...header, 'suggestion'].join('\t')];
for (const r of rows) {
  const alt = clean(suggestions.get(r.id));
  out.push([...header.map(h => r[h]), alt === r.text.trim() ? '' : alt].join('\t'));
}
fs.writeFileSync(TSV, out.join('\n') + '\n');

const filled = rows.filter(r => clean(suggestions.get(r.id))).length;
console.log(`done: ${filled}/${rows.length} rows got a suggestion → ${TSV}`);
