#!/usr/bin/env node
/**
 * Build a self-contained Leaflet HTML map of E-GERET correspondence.
 *
 * Three toggleable layers, all driven by one year slider:
 *   - Origins  (orange) — where each letter was written FROM
 *   - Mentions (blue)   — Kima places named inside letter content (NER)
 *   - Arrows   (purple) — sender-location → recipient-location, per edge
 *                         (curved Bezier-style polylines weighted by count)
 *
 * Inputs:
 *   output/e-geret-batch-export.json
 *   output/location-links.json        (Location string → Kima for origins)
 *   output/e-geret-ner-linked.json    (per-letter places with kima_id)
 *   output/recipient-locations.json   (letter_id → recipient Kima place)
 *
 * Output: output/map/index.html (no server needed, just open).
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
const KIMATCH = path.resolve(REPO, '..', 'Kimatch');
const BATCH    = path.join(REPO, 'output', 'e-geret-batch-export.json');
const LOC      = path.join(REPO, 'output', 'location-links.json');
const NER      = path.join(REPO, 'output', 'e-geret-ner-linked.json');
const RECIP_EX = path.join(REPO, 'output', 'recipient-locations.json');
const RECIP_INF = path.join(REPO, 'output', 'recipient-locations.inferred.json');
// Prefer the inferred superset when available (carries extracted+inferred).
const RECIP    = fs.existsSync(RECIP_INF) ? RECIP_INF : RECIP_EX;
const KIMA_CSV = path.join(KIMATCH, '20250126KimaPlacesCSVx.csv');
const OUTDIR   = path.join(REPO, 'output', 'map');
const OUT      = path.join(OUTDIR, 'index.html');

const batch  = JSON.parse(fs.readFileSync(BATCH, 'utf8'));
const links  = JSON.parse(fs.readFileSync(LOC, 'utf8'));
const ner    = JSON.parse(fs.readFileSync(NER, 'utf8'));
const recip  = fs.existsSync(RECIP) ? JSON.parse(fs.readFileSync(RECIP, 'utf8')) : {};

// ── Load lat/lon for every Kima place so mentioned-but-never-an-origin places
//    can also be plotted (e-geret-ner-linked.json carries kima_id but no coords).
const kimaCoords = new Map();   // kima_id → { lat, lon, rom, heb, kima_url, wikidata_id }
{
  const lines = fs.readFileSync(KIMA_CSV, 'utf8').split('\n');
  const header = lines.shift().split(',');
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const line of lines) {
    if (!line) continue;
    // Kima CSV is plain (no embedded commas in the fields we read) — split is fine.
    const c = line.split(',');
    const id = Number(c[col.id]);
    const lat = Number(c[col.lat]);
    const lon = Number(c[col.lon]);
    if (!Number.isFinite(id) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    kimaCoords.set(id, {
      lat, lon,
      rom:         c[col.primary_rom_full] || '',
      heb:         c[col.primary_heb_full] || '',
      kima_url:    `https://data.geo-kima.org/Places/Details/${id}`,
      wikidata_id: (c[col.WikiData_Id] || '').replace(/^NULL$/, ''),
    });
  }
}
console.error(`Loaded ${kimaCoords.size} Kima places with coordinates.`);

// ── Build a kima_id → coords lookup from all linked sources ─────────────────
const coords = new Map();    // kima_id → { kima_id, rom, heb, lat, lon, kima_url, wikidata_id }
function noteCoords(kima_id, info) {
  if (kima_id == null || info?.lat == null || info?.lon == null) return;
  if (coords.has(Number(kima_id))) return;
  coords.set(Number(kima_id), {
    kima_id:     Number(kima_id),
    rom:         info.kima_name_rom || info.rom || '',
    heb:         info.kima_name_heb || info.heb || '',
    lat:         info.lat,
    lon:         info.lon,
    kima_url:    info.kima_url || `https://data.geo-kima.org/Places/Details/${kima_id}`,
    wikidata_id: info.wikidata_id || '',
  });
}
for (const v of Object.values(links)) noteCoords(v.kima_id, v);
for (const v of Object.values(recip)) noteCoords(v.kima_id, v);
// Backfill from KimaDB so all linked places (incl. those mentioned but never
// an origin) get coordinates + canonical names.
for (const [id, info] of kimaCoords) noteCoords(id, info);

// ── Per-letter year helper ───────────────────────────────────────────────────
function yearOf(letter) {
  const iso = (letter.extracted?.DateISO || '').trim();
  const y = Number(iso.slice(0, 4));
  if (!y || y < 1700 || y > 2030) return null;
  return y;
}

// ── Aggregate letters per Kima place: origin events + mention events ────────
const origins  = new Map();   // kima_id → { ...coords, letters: [{id, year, sender, recipient, title, url, loc_raw}] }
const mentions = new Map();   // kima_id → { ...coords, letters: [{id, year, sender, recipient, title, url, place_name_in_text}] }
const edges    = new Map();   // "from→to" → { from_kima_id, to_kima_id, from_coords, to_coords, letters: [{id, year, sender, recipient, title, url}] }

// Quick letter lookup by id (for NER → letter join, since NER export shares ids)
const letterById = new Map();
for (const r of batch.results) letterById.set(r.id, r);

let used_origin = 0, used_mention = 0, used_edge = 0;
let dropped = { no_year: 0, no_origin_link: 0, no_recip_link: 0 };

for (const r of batch.results) {
  const ex = r.extracted || {};
  const year = yearOf(r);
  if (!year) { dropped.no_year++; continue; }

  const senderInfo  = {
    id:        r.id,
    year,
    sender:    (ex.Sender || '').trim(),
    recipient: (ex.Recipient || '').trim(),
    title:     (r.csvMetadata?.title || '').trim(),
    url:       (r.csvMetadata?.url || '').trim(),
    loc_raw:   (ex.Location || '').trim(),
  };

  // 1. Origin
  const locStr = senderInfo.loc_raw;
  const origLink = locStr && links[locStr];
  const fromKima = (origLink && origLink.kima_id && origLink.lat != null) ? Number(origLink.kima_id) : null;
  if (fromKima != null) {
    if (!origins.has(fromKima)) origins.set(fromKima, { ...coords.get(fromKima), letters: [] });
    origins.get(fromKima).letters.push(senderInfo);
    used_origin++;
  } else {
    dropped.no_origin_link++;
  }

  // 2. Edge (sender_loc → recipient_loc), only when both resolved AND distinct.
  //    Split into extracted vs inferred so the renderer can style each.
  const recipEntry = recip[r.id];
  const toKima = (recipEntry && recipEntry.kima_id && recipEntry.lat != null) ? Number(recipEntry.kima_id) : null;
  if (fromKima != null && toKima != null && fromKima !== toKima) {
    const via = recipEntry.via || 'extracted';
    const key = `${via}:${fromKima}→${toKima}`;
    if (!edges.has(key)) {
      edges.set(key, {
        key,
        via,
        from_kima_id: fromKima,
        to_kima_id:   toKima,
        from_coords:  coords.get(fromKima),
        to_coords:    coords.get(toKima),
        letters:      [],
      });
    }
    edges.get(key).letters.push({
      ...senderInfo,
      anchor_before: recipEntry.anchor_before,
      anchor_after:  recipEntry.anchor_after,
    });
    used_edge++;
  } else if (recipEntry && !toKima) {
    dropped.no_recip_link++;
  }
}

// 3. Mentions — from ner-linked, per place mention per letter
for (const r of ner.results) {
  const letter = letterById.get(r.id);
  if (!letter) continue;
  const year = yearOf(letter);
  if (!year) continue;
  const places = r.entities?.places || [];
  // de-dup multiple mentions of the same Kima id in the same letter
  const seenKima = new Set();
  for (const p of places) {
    if (!p.kima_id) continue;
    const kid = Number(p.kima_id);
    if (seenKima.has(kid)) continue;
    seenKima.add(kid);
    const info = coords.get(kid);
    if (!info) continue;   // unlikely now that we backfilled from KimaDB
    if (!mentions.has(kid)) mentions.set(kid, { ...info, letters: [] });
    mentions.get(kid).letters.push({
      id:                r.id,
      year,
      sender:            (letter.extracted?.Sender || '').trim(),
      recipient:         (letter.extracted?.Recipient || '').trim(),
      title:             (letter.csvMetadata?.title || '').trim(),
      url:               (letter.csvMetadata?.url || '').trim(),
      place_name_in_text: p.name || p.nameNormalized || '',
    });
    used_mention++;
  }
}

// ── Year range for the slider (driven by all events) ────────────────────────
const allYears = [
  ...origins.values(),  ...mentions.values(),
].flatMap(p => p.letters.map(l => l.year));
const yearMin = Math.min(...allYears);
const yearMax = Math.max(...allYears);

const originsArr  = Array.from(origins.values()).sort((a, b) => b.letters.length - a.letters.length);
const mentionsArr = Array.from(mentions.values()).sort((a, b) => b.letters.length - a.letters.length);
const edgesArr    = Array.from(edges.values()).sort((a, b) => b.letters.length - a.letters.length);

fs.mkdirSync(OUTDIR, { recursive: true });

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>E-GERET — Correspondence Map</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  html, body { margin: 0; padding: 0; height: 100%; font-family: system-ui, sans-serif; }
  #app { display: grid; grid-template-rows: auto 1fr auto; height: 100%; }
  header { padding: 10px 16px; background: #1a1a1a; color: #fff; }
  header h1 { margin: 0; font-size: 1.1em; }
  header .meta { font-size: 0.8em; opacity: 0.7; margin-top: 2px; }
  #map { width: 100%; height: 100%; }
  #controls { padding: 12px 16px; background: #f5f5f5; border-top: 1px solid #ddd; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  #yearLabel { font-weight: 600; min-width: 140px; }
  .range-wrap { position: relative; flex: 1; min-width: 240px; height: 28px; }
  .range-wrap input[type=range] {
    position: absolute; top: 0; left: 0; width: 100%; height: 28px;
    background: transparent; pointer-events: none; -webkit-appearance: none; appearance: none;
  }
  .range-wrap input[type=range]::-webkit-slider-thumb {
    pointer-events: auto; -webkit-appearance: none; appearance: none;
    width: 16px; height: 16px; border-radius: 50%; background: #1a1a1a; cursor: pointer; border: 0;
  }
  .range-wrap input[type=range]::-moz-range-thumb {
    pointer-events: auto; width: 16px; height: 16px; border-radius: 50%;
    background: #1a1a1a; cursor: pointer; border: 0;
  }
  .range-wrap input[type=range]::-webkit-slider-runnable-track { background: transparent; }
  .range-wrap input[type=range]::-moz-range-track { background: transparent; }
  .range-wrap .track-bg, .range-wrap .track-fill { position: absolute; left: 0; right: 0; top: 12px; height: 4px; border-radius: 2px; pointer-events: none; }
  .range-wrap .track-bg   { background: #d4d4d4; }
  .range-wrap .track-fill { background: #1a1a1a; }
  button { padding: 4px 10px; font-size: 0.9em; cursor: pointer; }
  button.active { background: #1a1a1a; color: #fff; }
  .layer-toggles { display: flex; gap: 6px; }
  .layer-toggles label { font-size: 0.9em; padding: 4px 10px; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; user-select: none; }
  .layer-toggles label.on { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  .layer-toggles input { display: none; }
  .leaflet-popup-content { max-height: 280px; overflow-y: auto; max-width: 360px; }
  .leaflet-popup-content h3 { margin: 0 0 6px; font-size: 1em; }
  .leaflet-popup-content .letter { padding: 4px 0; border-top: 1px solid #eee; font-size: 0.85em; }
  .leaflet-popup-content .letter:first-of-type { border-top: 0; }
  .leaflet-popup-content .meta { color: #666; font-size: 0.78em; }
</style>
</head>
<body>
<div id="app">
  <header>
    <h1>E-GERET — Correspondence Map</h1>
    <div class="meta">
      ${used_origin} letter origins · ${used_mention} place mentions · ${used_edge} sender→recipient links
      · ${originsArr.length} origin places · ${mentionsArr.length} mention places · ${edgesArr.length} edges
      · ${yearMin}–${yearMax}
    </div>
  </header>
  <div id="map"></div>
  <div id="controls">
    <div class="layer-toggles">
      <label class="on"><input type="checkbox" id="lO" checked>🟠 Origins</label>
      <label class="on"><input type="checkbox" id="lM" checked>🔵 Mentions</label>
      <label class="on"><input type="checkbox" id="lA" checked>🟣 Arrows (solid = explicit · dashed = inferred)</label>
    </div>
    <button id="allBtn" class="active">All years</button>
    <span id="yearLabel">All years</span>
    <div class="range-wrap">
      <div class="track-bg"></div>
      <div class="track-fill" id="trackFill"></div>
      <input type="range" id="yearFrom" min="${yearMin}" max="${yearMax}" value="${yearMin}" step="1">
      <input type="range" id="yearTo"   min="${yearMin}" max="${yearMax}" value="${yearMax}" step="1">
    </div>
    <button id="playBtn">▶ Play decades</button>
  </div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const ORIGINS  = ${JSON.stringify(originsArr)};
const MENTIONS = ${JSON.stringify(mentionsArr)};
const EDGES    = ${JSON.stringify(edgesArr)};
const YEAR_MIN = ${yearMin}, YEAR_MAX = ${yearMax};

const map = L.map('map').setView([45, 25], 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors', maxZoom: 18,
}).addTo(map);

const layers = {
  origins:  L.layerGroup().addTo(map),
  mentions: L.layerGroup().addTo(map),
  arrows:   L.layerGroup().addTo(map),
};

function popupPlace(p, letters, kind) {
  const sample = letters.slice(0, 20);
  const more = letters.length > sample.length ? '<div class="meta">… ' + (letters.length - sample.length) + ' more</div>' : '';
  const kindLabel = kind === 'origin' ? 'sent from here' : 'mentioned in';
  return [
    '<h3>' + (p.rom || '?') + (p.heb ? ' · ' + p.heb : '') + '</h3>',
    '<div class="meta">Kima <a href="' + p.kima_url + '" target="_blank">#' + p.kima_id + '</a>',
    p.wikidata_id ? ' · <a href="https://www.wikidata.org/wiki/' + p.wikidata_id + '" target="_blank">' + p.wikidata_id + '</a>' : '',
    ' · ' + letters.length + ' letter(s) ' + kindLabel + '</div>',
    sample.map(l =>
      '<div class="letter">'
      + '<a href="' + l.url + '" target="_blank">' + (l.sender || '?') + ' → ' + (l.recipient || '?') + '</a>'
      + '<div class="meta">' + l.year + (l.loc_raw ? ' · from ' + l.loc_raw : '') + (l.place_name_in_text ? ' · mentions "' + l.place_name_in_text + '"' : '') + (l.title ? ' · ' + l.title : '') + '</div>'
      + '</div>'
    ).join(''),
    more
  ].join('');
}

function popupEdge(e, letters) {
  const sample = letters.slice(0, 15);
  const more = letters.length > sample.length ? '<div class="meta">… ' + (letters.length - sample.length) + ' more</div>' : '';
  const viaBadge = e.via === 'inferred'
    ? '<span style="background:#fde;color:#83a;padding:2px 6px;border-radius:3px;font-size:0.78em;margin-left:6px">inferred (flanking anchors)</span>'
    : '';
  return [
    '<h3>' + (e.from_coords.rom || '?') + ' → ' + (e.to_coords.rom || '?') + viaBadge + '</h3>',
    '<div class="meta">' + letters.length + ' letter(s)</div>',
    sample.map(l => {
      const anchorNote = l.anchor_before && l.anchor_after
        ? '<div class="meta">↳ inferred from ' + l.anchor_before.letter_id + ' (' + l.anchor_before.date + ', ' + l.anchor_before.role + ') and ' + l.anchor_after.letter_id + ' (' + l.anchor_after.date + ', ' + l.anchor_after.role + ')</div>'
        : '';
      return '<div class="letter">'
        + '<a href="' + l.url + '" target="_blank">' + (l.sender || '?') + ' → ' + (l.recipient || '?') + '</a>'
        + '<div class="meta">' + l.year + (l.title ? ' · ' + l.title : '') + '</div>'
        + anchorNote
        + '</div>';
    }).join(''),
    more
  ].join('');
}

function filterLetters(letters, yFrom, yTo, allYears) {
  return allYears ? letters : letters.filter(l => l.year >= yFrom && l.year <= yTo);
}

// Bezier curve between two points (gently arched)
function curvePoints(from, to) {
  const lat1 = from[0], lng1 = from[1], lat2 = to[0], lng2 = to[1];
  const midLat = (lat1 + lat2) / 2;
  const midLng = (lng1 + lng2) / 2;
  // Offset perpendicular to the line, ~15% of the distance
  const dx = lng2 - lng1, dy = lat2 - lat1;
  const dist = Math.hypot(dx, dy);
  const offset = dist * 0.18;
  const offLat = midLat + (-dx / dist) * offset;
  const offLng = midLng + ( dy / dist) * offset;
  // Sample 16 points along the quadratic Bezier
  const out = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const x = (1 - t) * (1 - t) * lng1 + 2 * (1 - t) * t * offLng + t * t * lng2;
    const y = (1 - t) * (1 - t) * lat1 + 2 * (1 - t) * t * offLat + t * t * lat2;
    out.push([y, x]);
  }
  return out;
}

function render(yFrom, yTo, allYearsMode, show) {
  for (const l of Object.values(layers)) l.clearLayers();

  if (show.origins) {
    for (const p of ORIGINS) {
      const ls = filterLetters(p.letters, yFrom, yTo, allYearsMode);
      if (!ls.length) continue;
      const r = 4 + Math.sqrt(ls.length) * 1.5;
      const m = L.circleMarker([p.lat, p.lon], {
        radius: r, color: '#b53', fillColor: '#e85', fillOpacity: 0.75, weight: 1
      });
      m.bindPopup(() => popupPlace(p, ls, 'origin'), { maxWidth: 380 });
      m.bindTooltip(p.rom + ' (origin: ' + ls.length + ')');
      m.addTo(layers.origins);
    }
  }

  if (show.mentions) {
    for (const p of MENTIONS) {
      const ls = filterLetters(p.letters, yFrom, yTo, allYearsMode);
      if (!ls.length) continue;
      const r = 3 + Math.sqrt(ls.length) * 1.2;
      // Tiny offset NE so mention dots aren't fully hidden under origin dots
      const m = L.circleMarker([p.lat + 0.15, p.lon + 0.15], {
        radius: r, color: '#247', fillColor: '#69c', fillOpacity: 0.55, weight: 1
      });
      m.bindPopup(() => popupPlace(p, ls, 'mention'), { maxWidth: 380 });
      m.bindTooltip(p.rom + ' (mentions: ' + ls.length + ')');
      m.addTo(layers.mentions);
    }
  }

  if (show.arrows) {
    for (const e of EDGES) {
      const ls = filterLetters(e.letters, yFrom, yTo, allYearsMode);
      if (!ls.length) continue;
      const w = Math.min(8, 1 + Math.log(ls.length + 1) * 1.4);
      const pts = curvePoints([e.from_coords.lat, e.from_coords.lon],
                              [e.to_coords.lat,   e.to_coords.lon]);
      // Inferred edges render lighter + dashed so they read as "derived".
      const isInferred = e.via === 'inferred';
      const lineOpts = isInferred
        ? { color: '#a6c', weight: Math.max(2, w - 1), opacity: 0.45, lineCap: 'round', dashArray: '6,6' }
        : { color: '#83a', weight: w, opacity: 0.55, lineCap: 'round' };
      const line = L.polyline(pts, lineOpts);
      line.bindPopup(() => popupEdge(e, ls), { maxWidth: 400 });
      line.bindTooltip(
        e.from_coords.rom + ' → ' + e.to_coords.rom + ' (' + ls.length + ')'
        + (isInferred ? ' · inferred' : '')
      );
      line.addTo(layers.arrows);
    }
  }
}

const fromSlider = document.getElementById('yearFrom');
const toSlider   = document.getElementById('yearTo');
const fill       = document.getElementById('trackFill');
const label      = document.getElementById('yearLabel');
const allBtn     = document.getElementById('allBtn');
const playBtn    = document.getElementById('playBtn');
const cbO = document.getElementById('lO');
const cbM = document.getElementById('lM');
const cbA = document.getElementById('lA');
function showState() { return { origins: cbO.checked, mentions: cbM.checked, arrows: cbA.checked }; }
let allYearsMode = true;
function paintFill() {
  const lo = +fromSlider.value, hi = +toSlider.value;
  const a = (lo - YEAR_MIN) / (YEAR_MAX - YEAR_MIN);
  const b = (hi - YEAR_MIN) / (YEAR_MAX - YEAR_MIN);
  fill.style.left  = (a * 100) + '%';
  fill.style.right = ((1 - b) * 100) + '%';
}
function clampHandles(which) {
  // Don't let the handles cross. If 'from' bumps past 'to', drag 'to' along.
  let lo = +fromSlider.value, hi = +toSlider.value;
  if (lo > hi) {
    if (which === 'from') toSlider.value   = lo;
    else                  fromSlider.value = hi;
  }
}
function refresh() {
  const show = showState();
  paintFill();
  if (allYearsMode) {
    label.textContent = 'All years';
    render(YEAR_MIN, YEAR_MAX, true, show);
  } else {
    const lo = +fromSlider.value, hi = +toSlider.value;
    label.textContent = lo === hi ? String(lo) : (lo + ' – ' + hi);
    render(lo, hi, false, show);
  }
}
for (const cb of [cbO, cbM, cbA]) {
  cb.addEventListener('change', () => {
    cb.parentElement.classList.toggle('on', cb.checked);
    refresh();
  });
}
fromSlider.addEventListener('input', () => {
  clampHandles('from'); allYearsMode = false; allBtn.classList.remove('active'); refresh();
});
toSlider.addEventListener('input', () => {
  clampHandles('to');   allYearsMode = false; allBtn.classList.remove('active'); refresh();
});
allBtn.addEventListener('click', () => {
  allYearsMode = true; allBtn.classList.add('active');
  fromSlider.value = YEAR_MIN; toSlider.value = YEAR_MAX;
  refresh();
});
let playing = false, playTimer = null;
playBtn.addEventListener('click', () => {
  if (playing) { clearInterval(playTimer); playing = false; playBtn.textContent = '▶ Play decades'; return; }
  playing = true; playBtn.textContent = '⏸ Pause';
  allYearsMode = false; allBtn.classList.remove('active');
  // Play sweeps a 10-year window from the corpus start to the end.
  fromSlider.value = YEAR_MIN;
  toSlider.value   = Math.min(YEAR_MAX, YEAR_MIN + 10);
  refresh();
  playTimer = setInterval(() => {
    const lo = +fromSlider.value + 10;
    const hi = +toSlider.value   + 10;
    if (lo > YEAR_MAX) {
      clearInterval(playTimer); playing = false; playBtn.textContent = '▶ Play decades';
      fromSlider.value = YEAR_MAX - 10; toSlider.value = YEAR_MAX; refresh(); return;
    }
    fromSlider.value = lo; toSlider.value = Math.min(YEAR_MAX, hi);
    refresh();
  }, 1200);
});

refresh();
</script>
</body>
</html>`;

fs.writeFileSync(OUT, html);
const sizeKB = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`Wrote ${OUT.replace(REPO + '/', '')} (${sizeKB} KB)`);
console.log(`  origins  : ${used_origin} events across ${originsArr.length} places`);
console.log(`  mentions : ${used_mention} events across ${mentionsArr.length} places`);
console.log(`  arrows   : ${used_edge} events across ${edgesArr.length} edges`);
console.log(`  year range: ${yearMin}-${yearMax}`);
console.log(`  dropped (counts apply to origins pass):`, dropped);
