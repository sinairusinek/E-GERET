#!/usr/bin/env node
/**
 * Build a self-contained Leaflet HTML map of E-GERET letter origins.
 *
 * Joins:
 *   output/e-geret-batch-export.json  (letters + dateISO + Location)
 *   output/location-links.json        (Location string → kima place + lat/lon)
 *
 * Output: output/map/index.html — open in a browser, no server needed.
 * Each dot is one Kima place, sized by letter count. Year slider (decade
 * granularity, plus an "All years" toggle) filters letters by dateISO.
 * Hover/click a dot for a list of letters and senders.
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
const BATCH = path.join(REPO, 'output', 'e-geret-batch-export.json');
const LINKS = path.join(REPO, 'output', 'location-links.json');
const OUTDIR = path.join(REPO, 'output', 'map');
const OUT = path.join(OUTDIR, 'index.html');

const batch = JSON.parse(fs.readFileSync(BATCH, 'utf8'));
const links = JSON.parse(fs.readFileSync(LINKS, 'utf8'));

// Aggregate: per Kima place, list of letters with year + sender + recipient + title + url + raw Location
const byKima = new Map();
let used = 0, dropped_no_loc = 0, dropped_unlinked = 0, dropped_no_date = 0, dropped_no_coords = 0;
for (const r of batch.results) {
  const ex = r.extracted || {};
  const loc = (ex.Location || '').trim();
  const dateISO = (ex.DateISO || '').trim();
  if (!loc) { dropped_no_loc++; continue; }
  const link = links[loc];
  if (!link || !link.kima_id) { dropped_unlinked++; continue; }
  if (link.lat == null || link.lon == null) { dropped_no_coords++; continue; }
  if (!dateISO) { dropped_no_date++; continue; }
  const year = Number(dateISO.slice(0, 4));
  // Reject obvious junk years (parsing errors, Hebrew-only date misreads).
  // E-GERET corpus is ~1700-2025; outside that range is wrong.
  if (!year || year < 1700 || year > 2030) { dropped_no_date++; continue; }
  const k = link.kima_id;
  if (!byKima.has(k)) {
    byKima.set(k, {
      kima_id:       k,
      rom:           link.kima_name_rom,
      heb:           link.kima_name_heb,
      lat:           link.lat,
      lon:           link.lon,
      kima_url:      link.kima_url,
      wikidata_id:   link.wikidata_id,
      letters:       [],
    });
  }
  byKima.get(k).letters.push({
    id:        r.id,
    year:      year,
    sender:    (ex.Sender || '').trim(),
    recipient: (ex.Recipient || '').trim(),
    title:     (r.csvMetadata?.title || '').trim(),
    url:       (r.csvMetadata?.url || '').trim(),
    loc_raw:   loc,
  });
  used++;
}

const places = Array.from(byKima.values()).sort((a, b) => b.letters.length - a.letters.length);
const years = places.flatMap(p => p.letters.map(l => l.year));
const yearMin = Math.min(...years);
const yearMax = Math.max(...years);

fs.mkdirSync(OUTDIR, { recursive: true });

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>E-GERET — Letter Origins Map</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  html, body { margin: 0; padding: 0; height: 100%; font-family: system-ui, sans-serif; }
  #app { display: grid; grid-template-rows: auto 1fr auto; height: 100%; }
  header { padding: 10px 16px; background: #1a1a1a; color: #fff; }
  header h1 { margin: 0; font-size: 1.1em; }
  header .meta { font-size: 0.8em; opacity: 0.7; margin-top: 2px; }
  #map { width: 100%; height: 100%; }
  #controls { padding: 12px 16px; background: #f5f5f5; border-top: 1px solid #ddd; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  #yearLabel { font-weight: 600; min-width: 110px; }
  #yearRange { flex: 1; min-width: 200px; }
  button { padding: 4px 10px; font-size: 0.9em; cursor: pointer; }
  button.active { background: #1a1a1a; color: #fff; }
  .leaflet-popup-content { max-height: 260px; overflow-y: auto; max-width: 340px; }
  .leaflet-popup-content h3 { margin: 0 0 6px; font-size: 1em; }
  .leaflet-popup-content .letter { padding: 4px 0; border-top: 1px solid #eee; font-size: 0.85em; }
  .leaflet-popup-content .letter:first-of-type { border-top: 0; }
  .leaflet-popup-content .meta { color: #666; }
</style>
</head>
<body>
<div id="app">
  <header>
    <h1>E-GERET — Where Letters Were Written From</h1>
    <div class="meta">${used} letters · ${places.length} places · ${yearMin}–${yearMax}</div>
  </header>
  <div id="map"></div>
  <div id="controls">
    <button id="allBtn" class="active">All years</button>
    <span id="yearLabel">All years</span>
    <input type="range" id="yearRange" min="${yearMin}" max="${yearMax}" value="${yearMax}" step="1">
    <button id="playBtn">▶ Play decades</button>
  </div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const PLACES = ${JSON.stringify(places)};
const YEAR_MIN = ${yearMin}, YEAR_MAX = ${yearMax};

const map = L.map('map').setView([45, 25], 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors',
  maxZoom: 18,
}).addTo(map);

const layer = L.layerGroup().addTo(map);

function popupHtml(p, letters) {
  const sample = letters.slice(0, 20);
  const more = letters.length > sample.length ? '<div class="meta">… ' + (letters.length - sample.length) + ' more</div>' : '';
  return [
    '<h3>' + p.rom + (p.heb ? ' · ' + p.heb : '') + '</h3>',
    '<div class="meta">Kima <a href="' + p.kima_url + '" target="_blank">#' + p.kima_id + '</a>',
    p.wikidata_id ? ' · <a href="https://www.wikidata.org/wiki/' + p.wikidata_id + '" target="_blank">' + p.wikidata_id + '</a>' : '',
    ' · ' + letters.length + ' letter(s)</div>',
    sample.map(l =>
      '<div class="letter">'
      + '<a href="' + l.url + '" target="_blank">' + (l.sender || '?') + ' → ' + (l.recipient || '?') + '</a>'
      + '<div class="meta">' + l.year + ' · ' + l.loc_raw + (l.title ? ' · ' + l.title : '') + '</div>'
      + '</div>'
    ).join(''),
    more
  ].join('');
}

function render(yearMaxFilter, allYears) {
  layer.clearLayers();
  for (const p of PLACES) {
    const letters = allYears ? p.letters : p.letters.filter(l => l.year <= yearMaxFilter);
    if (!letters.length) continue;
    const radius = 4 + Math.sqrt(letters.length) * 1.5;
    const marker = L.circleMarker([p.lat, p.lon], {
      radius, color: '#b53', fillColor: '#e85', fillOpacity: 0.7, weight: 1
    });
    marker.bindPopup(() => popupHtml(p, letters), { maxWidth: 360 });
    marker.bindTooltip(p.rom + ' (' + letters.length + ')');
    marker.addTo(layer);
  }
}

const range = document.getElementById('yearRange');
const label = document.getElementById('yearLabel');
const allBtn = document.getElementById('allBtn');
const playBtn = document.getElementById('playBtn');
let allYears = true;
function refresh() {
  if (allYears) {
    label.textContent = 'All years';
    render(0, true);
  } else {
    const y = +range.value;
    label.textContent = 'Up to ' + y;
    render(y, false);
  }
}
range.addEventListener('input', () => { allYears = false; allBtn.classList.remove('active'); refresh(); });
allBtn.addEventListener('click', () => { allYears = true; allBtn.classList.add('active'); refresh(); });
let playing = false, playTimer = null;
playBtn.addEventListener('click', () => {
  if (playing) {
    clearInterval(playTimer); playing = false; playBtn.textContent = '▶ Play decades'; return;
  }
  playing = true; playBtn.textContent = '⏸ Pause';
  allYears = false; allBtn.classList.remove('active');
  range.value = YEAR_MIN;
  playTimer = setInterval(() => {
    const y = +range.value + 10;
    if (y > YEAR_MAX) { clearInterval(playTimer); playing = false; playBtn.textContent = '▶ Play decades'; range.value = YEAR_MAX; refresh(); return; }
    range.value = y;
    refresh();
  }, 1200);
});

refresh();
</script>
</body>
</html>`;

fs.writeFileSync(OUT, html);
const size = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`Wrote ${used} letters / ${places.length} places → ${path.relative(REPO, OUT)} (${size} KB)`);
console.log(`  date range: ${yearMin}-${yearMax}`);
console.log(`  dropped: no Location ${dropped_no_loc} · unlinked ${dropped_unlinked} · no coords ${dropped_no_coords} · no DateISO ${dropped_no_date}`);
