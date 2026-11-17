'use strict';

// ---------- Constants ----------

const STATE_KEY = 'commuteZones.state.v1';
const CACHE_KEY = 'commuteZones.cache.v1';
const COLORS = ['#e6194b', '#4363d8', '#f58231', '#911eb4', '#0f9d8a', '#f032e6', '#9a6324', '#808000'];
const LONDON_BBOX = { s: 51.28, n: 51.70, w: -0.52, e: 0.34 };
const MODE_OPTIONS = [
  ['tube', 'Tube'], ['bus', 'Bus'], ['overground', 'Overground'], ['elizabeth-line', 'Elizabeth line'],
  ['dlr', 'DLR'], ['national-rail', 'National Rail'], ['tram', 'Tram'],
];
// Crow-flies speed (km/h) that no realistic door-to-door journey beats; points farther than
// limit * speed from a workplace are skipped without asking TfL.
const MAX_CROW_SPEED_KMH = 28;
const RENT_LABELS = { room: 'Room', studio: 'Studio', 1: '1-bed', 2: '2-bed', 3: '3-bed', 4: '4+ bed' };
const KM_PER_DEG_LAT = 111.32;

const DEFAULT_STATE = {
  people: [],
  settings: {
    maxMin: 50,
    arrive: '08:45',
    spacingKm: 1.2,
    londonOnly: true,
    modes: MODE_OPTIONS.map(([id]) => id),
    rentType: '2',
    maxRent: null,
    appKey: '',
  },
};

// ---------- Persistence ----------

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

const state = loadJSON(STATE_KEY, structuredClone(DEFAULT_STATE));
state.settings = { ...DEFAULT_STATE.settings, ...state.settings };
const cache = loadJSON(CACHE_KEY, {});

const saveState = () => saveJSON(STATE_KEY, state);
let cacheSaveTimer = null;
function saveCacheSoon() {
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => saveJSON(CACHE_KEY, cache), 1000);
}

// ---------- Helpers ----------

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const limitFor = (p) => p.maxMin || state.settings.maxMin;
const located = () => state.people.filter((p) => p.lat != null);

function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// Next Tuesday–Thursday, so results reflect a typical working day.
function nextMidweekDate() {
  const d = new Date();
  do { d.setDate(d.getDate() + 1); } while (![2, 3, 4].includes(d.getDay()));
  return d;
}

function cacheKey(from, person) {
  const s = state.settings;
  return [from.lat.toFixed(4), from.lon.toFixed(4), person.lat.toFixed(4), person.lon.toFixed(4),
    s.arrive, [...s.modes].sort().join(',')].join('|');
}

function colorForRatio(t) {
  // dark green (quick for everyone) -> green -> amber (right on the limit)
  const stops = [[0.35, [11, 110, 79]], [0.75, [63, 163, 77]], [1, [227, 200, 75]]];
  t = Math.max(stops[0][0], Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i];
    const [t0, c0] = stops[i - 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return `rgb(${c0.map((v, k) => Math.round(v + (c1[k] - v) * f)).join(',')})`;
    }
  }
  return 'rgb(227,200,75)';
}

// ---------- External APIs ----------

const POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/;

async function geocode(query) {
  const pc = query.replace(/\s+/g, '').toUpperCase();
  if (POSTCODE_RE.test(pc)) {
    const res = await fetch(`https://api.postcodes.io/postcodes/${pc}`);
    if (res.ok) {
      const { result } = await res.json();
      return { lat: result.latitude, lon: result.longitude, label: result.postcode };
    }
  }
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=gb'
    + '&viewbox=-0.6,51.75,0.4,51.25&q=' + encodeURIComponent(query);
  const res = await fetch(url);
  const hits = res.ok ? await res.json() : [];
  if (!hits.length) throw new Error(`Couldn't find "${query}"`);
  return { lat: +hits[0].lat, lon: +hits[0].lon, label: hits[0].display_name.split(',').slice(0, 2).join(',') };
}

async function reverseLabel(lat, lon) {
  try {
    const res = await fetch(`https://api.postcodes.io/postcodes?lon=${lon}&lat=${lat}&limit=1&radius=1000`);
    const { result } = await res.json();
    if (result?.length) return `${result[0].postcode} (${result[0].admin_ward})`;
  } catch { /* fall through */ }
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

// Bulk reverse-geocode cells to ward, borough and postcode district (postcodes.io takes 100 per request).
// Names are cached alongside journey times since they never change.
async function nameCells(cells) {
  const placeKey = (c) => `place|${c.lat.toFixed(4)}|${c.lon.toFixed(4)}`;
  const todo = [];
  for (const c of cells) {
    const hit = cache[placeKey(c)];
    if (hit) Object.assign(c, hit);
    else if (!c.ward) todo.push(c);
  }
  for (let i = 0; i < todo.length; i += 100) {
    const batch = todo.slice(i, i + 100);
    try {
      const res = await fetch('https://api.postcodes.io/postcodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          geolocations: batch.map((c) => ({ latitude: c.lat, longitude: c.lon, radius: 2000, limit: 1 })),
        }),
      });
      const { result } = await res.json();
      result.forEach((r, k) => {
        const hit = r.result?.[0];
        const place = { ward: hit?.admin_ward || 'Unnamed area', borough: hit?.admin_district || '', outcode: hit?.outcode || '' };
        Object.assign(batch[k], place);
        cache[placeKey(batch[k])] = place;
      });
      saveCacheSoon();
    } catch {
      batch.forEach((c) => { c.ward ??= 'Unnamed area'; c.borough ??= ''; c.outcode ??= ''; });
    }
  }
}

// Median monthly rent for the chosen property type: postcode district if the ONS has it, else the borough.
function rentFor(cell) {
  const type = state.settings.rentType;
  const district = RENTS.districts[cell.outcode]?.[type];
  if (district) return { rent: district, source: cell.outcode };
  const borough = RENTS.boroughs[cell.borough]?.[type];
  if (borough) return { rent: borough, source: `${cell.borough} average` };
  return null;
}

const fmtRent = (n) => `£${n.toLocaleString('en-GB')}`;

const journeyDay = nextMidweekDate();
const journeyDate = `${journeyDay.getFullYear()}${String(journeyDay.getMonth() + 1).padStart(2, '0')}${String(journeyDay.getDate()).padStart(2, '0')}`;

// Fastest door-to-door minutes from a point to a person's workplace, or null if unreachable.
async function journeyMinutes(from, person, signal) {
  const s = state.settings;
  const modes = [...s.modes].sort().join(',');
  const key = cacheKey(from, person);
  if (key in cache) return cache[key];

  const params = new URLSearchParams({
    date: journeyDate,
    time: s.arrive.replace(':', ''),
    timeIs: 'Arriving',
    mode: `${modes},walking`,
  });
  if (s.appKey) params.set('app_key', s.appKey);
  const url = `https://api.tfl.gov.uk/Journey/JourneyResults/${from.lat.toFixed(5)},${from.lon.toFixed(5)}`
    + `/to/${person.lat.toFixed(5)},${person.lon.toFixed(5)}?${params}`;

  for (let attempt = 0; attempt < 6; attempt++) {
    let res;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      if (signal.aborted) throw err;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      throttled = true;
      await sleep(1500 * 2 ** attempt + Math.random() * 1000);
      continue;
    }
    let minutes = null;
    if (res.ok) {
      const data = await res.json();
      const durations = (data.journeys || []).map((j) => j.duration).filter(Number.isFinite);
      if (durations.length) minutes = Math.min(...durations);
    }
    cache[key] = minutes;
    saveCacheSoon();
    return minutes;
  }
  return undefined; // gave up; leave uncached so a later run retries
}

// ---------- Map ----------

const map = L.map('map', { zoomControl: true }).setView([51.507, -0.12], 11);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const cellLayer = L.layerGroup().addTo(map);
const markers = {};

const legend = L.control({ position: 'bottomright' });
legend.onAdd = () => {
  const div = L.DomUtil.create('div', 'legend');
  div.id = 'legend';
  return div;
};
legend.addTo(map);

function renderLegend() {
  const max = state.settings.maxMin;
  $('legend').innerHTML = `<strong>Longest commute in the group</strong>
    <div class="ramp" style="background:linear-gradient(to right, ${colorForRatio(0.35)}, ${colorForRatio(0.75)}, ${colorForRatio(1)})"></div>
    <div class="ends"><span>≤ ${Math.round(max * 0.35)} min</span><span>${max} min</span></div>
    <div class="key"><span class="swatch" style="background:rgba(192,57,43,.15);border-color:rgba(192,57,43,.4)"></span>Too far for someone</div>
    ${state.settings.maxRent ? '<div class="key"><span class="swatch" style="background:rgba(90,90,110,.3);border-color:rgba(90,90,110,.5)"></span>Over rent budget</div>' : ''}`;
}

function pinIcon(person, index) {
  return L.divIcon({
    className: '',
    html: `<div class="pin" style="--c:${person.color}"><span>${esc((person.name || String(index + 1))[0].toUpperCase())}</span></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
  });
}

function syncMarkers() {
  for (const id of Object.keys(markers)) {
    if (!state.people.some((p) => p.id === id && p.lat != null)) {
      markers[id].remove();
      delete markers[id];
    }
  }
  state.people.forEach((p, i) => {
    if (p.lat == null) return;
    if (!markers[p.id]) {
      markers[p.id] = L.marker([p.lat, p.lon], { draggable: true, zIndexOffset: 1000 }).addTo(map);
      markers[p.id].on('dragend', async (e) => {
        const { lat, lng } = e.target.getLatLng();
        Object.assign(p, { lat, lon: lng, label: await reverseLabel(lat, lng) });
        changed();
      });
    }
    markers[p.id].setLatLng([p.lat, p.lon]).setIcon(pinIcon(p, i)).bindTooltip(`${esc(p.name || 'Person ' + (i + 1))}'s work`);
  });
}

let pickingFor = null;
map.on('click', async (e) => {
  if (!pickingFor) return;
  const p = state.people.find((x) => x.id === pickingFor);
  pickingFor = null;
  $('map').classList.remove('map-picking');
  if (!p) return;
  const { lat, lng } = e.latlng;
  Object.assign(p, { lat, lon: lng, label: 'Locating…' });
  renderPeople();
  p.label = await reverseLabel(lat, lng);
  changed();
});

// ---------- People UI ----------

function addPerson() {
  const used = new Set(state.people.map((p) => p.color));
  state.people.push({
    id: Math.random().toString(36).slice(2, 9),
    name: '',
    color: COLORS.find((c) => !used.has(c)) || COLORS[state.people.length % COLORS.length],
    lat: null, lon: null, label: '', maxMin: null,
  });
  changed();
}

function renderPeople() {
  const box = $('people');
  box.innerHTML = '';
  if (!state.people.length) {
    box.innerHTML = '<p class="hint">Add each person and where they work.</p>';
  }
  state.people.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'person';
    el.style.setProperty('--c', p.color);
    el.innerHTML = `
      <div class="row">
        <input class="name" type="text" placeholder="Person ${i + 1}" value="${esc(p.name)}">
        <input class="max" type="number" min="10" max="120" step="5" placeholder="${state.settings.maxMin} min" value="${p.maxMin ?? ''}" title="Personal max commute (blank = group max)">
        <button class="icon del" title="Remove">✕</button>
      </div>
      <div class="row">
        <input class="q" type="text" placeholder="Work postcode or place, e.g. EC2V 7HH">
        <button class="icon find">Find</button>
        <button class="icon pick ${pickingFor === p.id ? 'active' : ''}" title="Click on the map to set">📍</button>
      </div>
      <div class="where ${p.lat == null ? 'unset' : ''}">${p.lat == null ? 'No workplace set yet' : esc(p.label)}</div>`;

    el.querySelector('.name').addEventListener('change', (e) => { p.name = e.target.value.trim(); changed(false); });
    el.querySelector('.max').addEventListener('change', (e) => { p.maxMin = +e.target.value || null; changed(); });
    el.querySelector('.del').addEventListener('click', () => {
      state.people = state.people.filter((x) => x !== p);
      changed();
    });
    const q = el.querySelector('.q');
    const find = async () => {
      if (!q.value.trim()) return;
      const where = el.querySelector('.where');
      where.textContent = 'Searching…';
      try {
        Object.assign(p, await geocode(q.value.trim()));
        changed();
        map.panTo([p.lat, p.lon]);
      } catch (err) {
        where.textContent = err.message;
        where.classList.add('unset');
      }
    };
    el.querySelector('.find').addEventListener('click', find);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') find(); });
    el.querySelector('.pick').addEventListener('click', () => {
      pickingFor = pickingFor === p.id ? null : p.id;
      $('map').classList.toggle('map-picking', !!pickingFor);
      renderPeople();
    });
    box.appendChild(el);
  });
}

// ---------- Settings UI ----------

function initSettings() {
  const s = state.settings;
  $('maxMin').value = s.maxMin;
  $('arrive').value = s.arrive;
  $('spacing').value = String(s.spacingKm);
  $('londonOnly').checked = s.londonOnly;
  $('appKey').value = s.appKey;
  $('rentType').value = s.rentType;
  $('maxRent').value = s.maxRent ?? '';

  $('modes').innerHTML = MODE_OPTIONS.map(([id, label]) =>
    `<label class="check"><input type="checkbox" value="${id}" ${s.modes.includes(id) ? 'checked' : ''}> ${label}</label>`).join('');

  $('maxMin').addEventListener('change', (e) => { s.maxMin = Math.max(10, +e.target.value || 50); renderPeople(); changed(); });
  $('arrive').addEventListener('change', (e) => { s.arrive = e.target.value || '08:45'; changed(); });
  $('spacing').addEventListener('change', (e) => { s.spacingKm = +e.target.value; changed(); });
  $('londonOnly').addEventListener('change', (e) => { s.londonOnly = e.target.checked; changed(); });
  $('appKey').addEventListener('change', (e) => { s.appKey = e.target.value.trim(); saveState(); });
  $('rentType').addEventListener('change', (e) => { s.rentType = e.target.value; changed(); });
  $('maxRent').addEventListener('change', (e) => { s.maxRent = +e.target.value || null; changed(); });
  $('zoneSort').addEventListener('change', () => { if (!running && cells.some((c) => c.status !== 'pending')) renderZones(); });
  $('modes').addEventListener('change', () => {
    s.modes = [...$('modes').querySelectorAll('input:checked')].map((i) => i.value);
    changed();
  });
  $('hideFail').addEventListener('change', () => cells.forEach(styleCell));
}

// Called after any change to people or settings.
function changed(affectsResults = true) {
  saveState();
  renderPeople();
  syncMarkers();
  renderLegend();
  renderRentHint();
  if (affectsResults && !running) previewGrid();
}

function renderRentHint() {
  const s = state.settings;
  const n = Math.max(1, state.people.length);
  const median = RENTS.london[s.rentType];
  let text = `London median for a ${RENT_LABELS[s.rentType]}: ${fmtRent(median)}/month.`;
  if (s.maxRent && n > 1 && s.rentType !== 'room') text += ` Your budget is ${fmtRent(Math.round(s.maxRent / n))} each, split ${n} ways.`;
  $('rentHint').textContent = text;
}

// ---------- Grid ----------

let cells = [];

function buildGrid() {
  const people = located();
  const s = state.settings;
  if (!people.length) return [];

  const radiusKm = (p) => (limitFor(p) / 60) * MAX_CROW_SPEED_KMH;
  const lat0 = people.reduce((a, p) => a + p.lat, 0) / people.length;
  const kmPerDegLon = KM_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);

  // Intersect every person's reachable bounding box.
  let box = { s: -90, n: 90, w: -180, e: 180 };
  for (const p of people) {
    const r = radiusKm(p);
    box = {
      s: Math.max(box.s, p.lat - r / KM_PER_DEG_LAT),
      n: Math.min(box.n, p.lat + r / KM_PER_DEG_LAT),
      w: Math.max(box.w, p.lon - r / kmPerDegLon),
      e: Math.min(box.e, p.lon + r / kmPerDegLon),
    };
  }
  if (s.londonOnly) {
    box = { s: Math.max(box.s, LONDON_BBOX.s), n: Math.min(box.n, LONDON_BBOX.n), w: Math.max(box.w, LONDON_BBOX.w), e: Math.min(box.e, LONDON_BBOX.e) };
  }
  if (box.s >= box.n || box.w >= box.e) return [];

  // Pointy-top hexagons: centre spacing `w` across, 1.5 * hexRadius between rows.
  const w = s.spacingKm;
  const hexR = w / Math.sqrt(3);
  const dLat = (1.5 * hexR) / KM_PER_DEG_LAT;
  const dLon = w / kmPerDegLon;
  const out = [];
  for (let row = 0, lat = box.s; lat <= box.n; row++, lat += dLat) {
    for (let lon = box.w + (row % 2 ? dLon / 2 : 0); lon <= box.e; lon += dLon) {
      const pt = { lat, lon };
      const ratios = people.map((p) => haversineKm(pt, p) / radiusKm(p));
      if (ratios.some((r) => r > 1)) continue;
      const poly = [];
      for (let k = 0; k < 6; k++) {
        const a = ((30 + 60 * k) * Math.PI) / 180;
        poly.push([lat + (hexR * Math.sin(a)) / KM_PER_DEG_LAT, lon + (hexR * Math.cos(a)) / kmPerDegLon]);
      }
      out.push({ lat, lon, poly, priority: Math.max(...ratios), times: {}, status: 'pending' });
    }
  }
  // Most promising (closest to everyone) first, so good areas show up early.
  return out.sort((a, b) => a.priority - b.priority);
}

function previewGrid() {
  cellLayer.clearLayers();
  cells = buildGrid();
  cells.forEach(addCellToMap);
  const people = located();
  if (!people.length) {
    $('estimate').textContent = 'Add at least one person with a workplace to begin.';
  } else if (!cells.length) {
    $('estimate').textContent = 'No area is close enough to everyone. Try a higher max commute.';
  } else {
    const cached = cells.filter((c) => people.every((p) => cacheHit(c, p))).length;
    $('estimate').textContent = `${cells.length} areas to check, up to ${cells.length * people.length} journey lookups`
      + (cached ? ` (${cached} areas already cached)` : '') + '.';
  }
  $('zones').innerHTML = '<p class="hint">Run a search to see the neighbourhoods that work for everyone.</p>';
  $('status').textContent = '';
}

function cacheHit(cell, p) {
  return cacheKey(cell, p) in cache;
}

function addCellToMap(cell) {
  cell.layer = L.polygon(cell.poly, { weight: 0.6 }).addTo(cellLayer);
  cell.layer.bindPopup(() => cellPopup(cell));
  styleCell(cell);
}

function styleCell(cell) {
  const hide = $('hideFail').checked;
  let style;
  if (cell.status === 'ok') {
    const worst = Math.max(...located().map((p) => cell.times[p.id] / limitFor(p)));
    const fill = colorForRatio(worst);
    style = { color: fill, fillColor: fill, fillOpacity: 0.62, opacity: 0.9 };
  } else if (cell.status === 'fail') {
    style = { color: '#c0392b', fillColor: '#c0392b', fillOpacity: hide ? 0 : 0.07, opacity: hide ? 0 : 0.15 };
  } else if (cell.status === 'rent') {
    style = { color: '#5a5a6e', fillColor: '#5a5a6e', fillOpacity: hide ? 0 : 0.18, opacity: hide ? 0 : 0.25 };
  } else {
    style = { color: '#888', fillColor: '#888', fillOpacity: 0.05, opacity: 0.25 };
  }
  cell.layer.setStyle(style);
}

function cellPopup(cell) {
  const people = located();
  const rows = people.map((p, i) => {
    const t = cell.times[p.id];
    const name = esc(p.name || `Person ${i + 1}`);
    let val;
    if (t === undefined) val = '<span style="color:#999">not checked</span>';
    else if (t === null) val = '<span class="bad">no route</span>';
    else val = t > limitFor(p) ? `<span class="bad">${t} min</span>` : `${t} min`;
    return `<tr><td><span class="dot" style="--c:${p.color}"></span>${name}</td><td>${val}</td></tr>`;
  }).join('');
  const done = people.map((p) => cell.times[p.id]).filter(Number.isFinite);
  const summary = {
    ok: () => `Longest ${Math.max(...done)} min · average ${Math.round(done.reduce((a, b) => a + b, 0) / done.length)} min`,
    fail: () => 'Too far for at least one person',
    rent: () => 'Over your rent budget, so commutes weren\'t checked',
    pending: () => 'Not checked yet',
  }[cell.status]();
  const title = cell.ward ? `${esc(cell.ward)}${cell.borough ? ', ' + esc(cell.borough) : ''}` : 'This area';
  const r = cell.ward ? rentFor(cell) : null;
  const rent = r
    ? `<div class="summary">${RENT_LABELS[state.settings.rentType]} median rent: <strong${cell.status === 'rent' ? ' class="bad"' : ''}>${fmtRent(r.rent)}/mo</strong> (${esc(r.source)})</div>`
    : '';
  return `<div class="popup"><h4>${title}</h4><table>${rows}</table>${rent}<div class="summary">${summary}</div></div>`;
}

// ---------- Search ----------

let running = false;
let throttled = false;
let controller = null;

async function run() {
  const people = located();
  if (!people.length) return;
  if (!state.settings.modes.length) {
    $('status').textContent = 'Pick at least one transport mode.';
    return;
  }
  previewGrid();
  if (!cells.length) return;

  running = true;
  throttled = false;
  controller = new AbortController();
  const { signal } = controller;
  $('run').disabled = true;
  $('stop').hidden = false;
  $('progress').hidden = false;

  const start = Date.now();
  const updateStatus = () => {
    const done = cells.filter((c) => c.status !== 'pending').length;
    const ok = cells.filter((c) => c.status === 'ok').length;
    $('bar').style.width = `${(100 * done) / cells.length}%`;
    const rate = done / ((Date.now() - start) / 1000);
    const eta = rate > 0 ? Math.round((cells.length - done) / rate) : null;
    const overBudget = cells.filter((c) => c.status === 'rent').length;
    $('status').textContent = `Checked ${done} of ${cells.length} areas · ${ok} work for everyone`
      + (overBudget ? ` · ${overBudget} over budget` : '')
      + (eta != null && done < cells.length ? ` · ~${eta > 90 ? Math.round(eta / 60) + ' min' : eta + ' s'} left` : '')
      + (throttled && !state.settings.appKey ? ' · TfL is throttling requests, so this is slower (an API key helps)' : '');
  };

  let error = null;
  try {
    $('status').textContent = 'Looking up postcodes and rents…';
    await nameCells(cells);
    const { maxRent } = state.settings;
    for (const c of cells) {
      c.rent = rentFor(c)?.rent ?? null;
      if (maxRent && c.rent != null && c.rent > maxRent) {
        c.status = 'rent';
        styleCell(c);
      }
    }
    updateStatus();
    await checkAll(people, signal, updateStatus);
  } catch (err) {
    if (!signal.aborted) error = err;
  }

  saveJSON(CACHE_KEY, cache);
  running = false;
  $('run').disabled = false;
  $('stop').hidden = true;
  $('progress').hidden = true;
  updateStatus();
  if (signal.aborted) $('status').textContent += ' (stopped)';
  if (error) $('status').textContent = `Error: ${error.message || error}`;
  await renderZones();
}

// Settle a cell from the times known so far: 'fail' as soon as anyone is over their limit,
// 'ok' once everyone is known to be within it, otherwise still 'pending'.
function evaluateCell(cell, people) {
  const times = people.map((p) => cell.times[p.id]);
  if (people.some((p, i) => times[i] === null || times[i] > limitFor(p))) cell.status = 'fail';
  else if (times.every(Number.isFinite)) cell.status = 'ok';
  else cell.status = 'pending';
  styleCell(cell);
}

// TfL answers one journey per request, so work cell by cell and stop at the first person who's too far.
async function checkAll(people, signal, onProgress) {
  const checkCell = async (cell) => {
    // Furthest person first: they're the most likely to rule this area out, which saves lookups.
    const order = [...people].sort((a, b) => haversineKm(cell, b) / limitFor(b) - haversineKm(cell, a) / limitFor(a));
    for (const p of order) {
      const t = await journeyMinutes(cell, p, signal);
      if (t === undefined) return; // TfL kept failing; leave pending
      cell.times[p.id] = t;
      evaluateCell(cell, people);
      if (cell.status === 'fail') return;
    }
  };

  // Anonymous TfL access throttles anything beyond roughly one request at a time.
  const concurrency = state.settings.appKey ? 8 : 2;
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < cells.length && !signal.aborted) {
      const cell = cells[next++];
      if (cell.status !== 'pending') continue;
      await checkCell(cell);
      onProgress();
    }
  }));
}

// ---------- Zones list ----------

async function renderZones() {
  const people = located();
  const good = cells.filter((c) => c.status === 'ok');
  const box = $('zones');
  if (!good.length) {
    box.innerHTML = '<p class="hint">No area works for everyone yet. Try a higher max commute, more transport modes, or a later arrival time.</p>';
    return;
  }

  const groups = new Map();
  for (const c of good) {
    const key = `${c.ward}|${c.borough}`;
    if (!groups.has(key)) groups.set(key, { ward: c.ward, borough: c.borough, cells: [] });
    groups.get(key).cells.push(c);
  }
  const worstOf = (c) => Math.max(...people.map((p) => c.times[p.id]));
  const zones = [...groups.values()].map((g) => {
    const best = g.cells.reduce((a, c) => (worstOf(c) < worstOf(a) ? c : a));
    const rents = g.cells.map((c) => c.rent).filter((r) => r != null);
    return { ...g, best, worst: worstOf(best), rent: rents.length ? Math.min(...rents) : null };
  });
  const byRent = $('zoneSort').value === 'rent';
  zones.sort((a, b) => (byRent ? (a.rent ?? Infinity) - (b.rent ?? Infinity) : 0) || a.worst - b.worst);

  box.innerHTML = `<p class="hint">${zones.length} neighbourhood${zones.length === 1 ? ' works' : 's work'} for everyone. Each one shows its best spot, ${byRent ? 'with the cheapest first' : 'with the fastest options first'}.</p>`;
  for (const z of zones) {
    const el = document.createElement('div');
    el.className = 'zone';
    const times = people.map((p, i) =>
      `<span><span class="dot" style="--c:${p.color}"></span>${esc(p.name || 'Person ' + (i + 1))} ${z.best.times[p.id]}m</span>`).join('');
    el.innerHTML = `<div class="z-name">${esc(z.ward)}</div>
      <div class="z-meta">${esc(z.borough)} · longest commute ${z.worst} min${z.rent != null ? ` · ${RENT_LABELS[state.settings.rentType]} from ${fmtRent(z.rent)}/mo` : ''}</div>
      <div class="z-times">${times}</div>`;
    el.addEventListener('click', () => {
      map.fitBounds(L.latLngBounds(z.cells.flatMap((c) => c.poly)), { maxZoom: 14, padding: [40, 40] });
      z.best.layer.openPopup([z.best.lat, z.best.lon]);
    });
    box.appendChild(el);
  }
}

// ---------- Boot ----------

$('addPerson').addEventListener('click', addPerson);
$('run').addEventListener('click', run);
$('stop').addEventListener('click', () => controller?.abort());
$('clearCache').addEventListener('click', () => {
  for (const k of Object.keys(cache)) delete cache[k];
  saveJSON(CACHE_KEY, cache);
  previewGrid();
});

if (!state.people.length) { addPerson(); addPerson(); }
initSettings();
changed();
const pts = located();
if (pts.length) map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lon])).pad(1.2), { maxZoom: 12 });
