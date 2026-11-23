// Map styles and tiles: the Street / Satellite / Hybrid layers for each source, attribution, keys never leaked, the
// Content-Security-Policy, and the server's polite tile cache (TTL from the provider, revalidation, at most two
// requests at a time, no duplicate fetches, zoom limits, trimming) - against a fake provider, nothing leaves the PC.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDERS, SATELLITES, resolveStyles, directOrigins, createTileCache, USER_AGENT, KEY_HELP } from '../lib/tiles.js';
import { SETTINGS_DEFAULTS } from '../lib/store.js';
import { tileSrc } from '../public/map.js';

const S = (o = {}) => ({ ...SETTINGS_DEFAULTS, ...o });

test('defaults: Street first, OpenStreetMap and EOxCloudless through the cache, no key needed', () => {
  const r = resolveStyles(S());
  assert.equal(r.default, 'street'); assert.equal(r.satellite, 'eox'); assert.equal(r.note, '');
  assert.deepEqual(r.styles.street.layers.map(l => l.url), ['/tiles/osm/{z}/{x}/{y}']);
  assert.deepEqual(r.styles.satellite.layers.map(l => l.url), ['/tiles/eox/{z}/{x}/{y}']);
  assert.deepEqual(r.styles.hybrid.layers.map(l => l.url), ['/tiles/eox/{z}/{x}/{y}', '/tiles/eoxLabels/{z}/{x}/{y}']);
  assert.equal(r.styles.hybrid.layers[1].labels, true);
  assert.deepEqual(directOrigins(r), [], 'everything is same-origin');
  // without the cache the browser goes to the providers directly, and the CSP must allow exactly those hosts
  const d = resolveStyles(S({ tileCache: false }));
  assert.deepEqual(directOrigins(d).sort(), ['https://tile.openstreetmap.org', 'https://tiles.maps.eox.at']);
});

test('attribution: every layer carries the credit its provider requires', () => {
  const r = resolveStyles(S());
  assert.match(r.styles.street.layers[0].attribution, /OpenStreetMap contributors/);
  assert.match(r.styles.satellite.layers[0].attribution, /^EOxCloudless 2024 by EOX IT Services GmbH \(Contains modified Copernicus Sentinel data 2024\)$/);
  assert.equal(r.styles.satellite.layers[0].attributionUrl, 'https://cloudless.eox.at');
  assert.match(r.styles.hybrid.layers[1].attribution, /OpenStreetMap contributors.*EOX/);
  assert.match(resolveStyles(S({ satellite: 'usgs' })).styles.satellite.layers[0].attribution, /USGS The National Map/);
  const esri = resolveStyles(S({ satellite: 'esri', esriKey: 'AAPK-fake' }));
  assert.match(esri.styles.satellite.layers[0].attribution, /^Powered by Esri/);
  for (const id of Object.keys(PROVIDERS)) { assert.ok(PROVIDERS[id].attribution, id); assert.match(PROVIDERS[id].attributionUrl, /^https:\/\//, id); }
});

test('keyed sources: need their key, fall back to EOxCloudless without it, go direct (never cached)', () => {
  const none = resolveStyles(S({ satellite: 'esri' }));
  assert.equal(none.satellite, 'eox'); assert.match(none.note, /needs a key/);
  const esri = resolveStyles(S({ satellite: 'esri', esriKey: 'AAPK-fake_key.1' }));
  assert.equal(esri.satellite, 'esri');
  assert.match(esri.styles.satellite.layers[0].url, /^https:\/\/static-map-tiles-api\.arcgis\.com\/.*\/arcgis\/imagery\/static\/tile\/\{z\}\/\{y\}\/\{x\}\?token=AAPK-fake_key\.1$/);
  assert.equal(esri.styles.satellite.layers[0].tileSize, 512);
  assert.match(esri.styles.hybrid.layers[1].url, /imagery\/labels\/static/);
  assert.deepEqual(directOrigins(esri), ['https://static-map-tiles-api.arcgis.com']);
  const mt = resolveStyles(S({ satellite: 'maptiler', maptilerKey: 'mtkey123' }));
  assert.deepEqual(mt.styles.hybrid.layers.map(l => l.url), ['https://api.maptiler.com/maps/hybrid/256/{z}/{x}/{y}.jpg?key=mtkey123']);
  // no key anywhere in the shipped sources, and sign-up steps for each keyed source
  for (const id of SATELLITES) if (PROVIDERS[id].key) { assert.ok(PROVIDERS[id].url.includes('{key}')); assert.ok(KEY_HELP[id].length >= 3); }
  const src = fs.readFileSync(new URL('../lib/tiles.js', import.meta.url), 'utf8');
  assert.ok(!/AAPK[A-Za-z0-9_-]{20,}|key=[A-Za-z0-9]{16,}/.test(src), 'no real-looking key in lib/tiles.js');
});

test('custom street tiles stay as set (direct), the map style setting picks what viewers see first', () => {
  const r = resolveStyles(S({ tileUrl: 'https://{s}.tiles.example.com/{z}/{x}/{y}.png', tileAttribution: 'Example', mapStyle: 'hybrid' }));
  assert.equal(r.default, 'hybrid');
  assert.deepEqual(r.styles.street.layers.map(l => [l.url, l.attribution]), [['https://{s}.tiles.example.com/{z}/{x}/{y}.png', 'Example']]);
  assert.deepEqual(directOrigins(r), ['https://*.tiles.example.com']);
  assert.equal(resolveStyles(S({ mapStyle: 'moon' })).default, 'street');
});

test('tile URLs: z / x / y in the order each provider wants', () => {
  assert.equal(tileSrc(PROVIDERS.eox.url, 5, 10, 12), 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/5/12/10.jpg', 'WMTS: row (y) before column (x)');
  assert.equal(tileSrc(PROVIDERS.usgs.url, 16, 15000, 24000), 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/16/24000/15000');
  assert.equal(tileSrc(PROVIDERS.osm.url, 3, 1, 2), 'https://tile.openstreetmap.org/3/1/2.png');
});

// ---- the cache, against a fake provider
function fakeProvider({ maxAge = 3600, etag = '"v1"', delay = 20 } = {}) {
  const calls = [];
  let inFlight = 0, maxInFlight = 0;
  const impl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, delay));
    inFlight--;
    if (url.includes('/404/')) return new Response('no', { status: 404 });
    if (init.headers['If-None-Match'] === etag) return new Response(null, { status: 304, headers: { 'cache-control': `max-age=${maxAge}` } });
    return new Response(Buffer.from('PNGDATA:' + url), { status: 200, headers: { 'content-type': 'image/png', 'cache-control': `max-age=${maxAge}`, etag } });
  };
  return { impl, calls, get maxInFlight() { return maxInFlight; } };
}
const testProviders = { osm: { ...PROVIDERS.osm, url: 'https://fake.example/{z}/{x}/{y}.png' }, eox: { ...PROVIDERS.eox, url: 'https://fake.example/eox/{z}/{y}/{x}.jpg' }, esri: PROVIDERS.esri };

test('cache: fetched once with an honest User-Agent, kept for the max-age, then revalidated (304)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-tiles-'));
  let now = 1_000_000;
  const fp = fakeProvider({ maxAge: 3600 });
  const c = createTileCache({ dir, providers: testProviders, fetchImpl: fp.impl, now: () => now });
  try {
    const a = await c.get('osm', 3, 1, 2);
    assert.equal(a.status, 200); assert.equal(a.type, 'image/png'); assert.equal(a.body.toString(), 'PNGDATA:https://fake.example/3/1/2.png');
    assert.equal(fp.calls[0].headers['User-Agent'], USER_AGENT); assert.match(USER_AGENT, /^HallowPlaces\/1\.1 \(.*github\.com\/Dom428\/hallow-places/);
    for (let i = 0; i < 5; i++) assert.equal((await c.get('osm', 3, 1, 2)).status, 200);
    assert.equal(fp.calls.length, 1, 'served from disk within the max-age');
    now += 3601 * 1000;
    const b = await c.get('osm', 3, 1, 2);
    assert.equal(b.body.toString(), 'PNGDATA:https://fake.example/3/1/2.png');
    assert.equal(fp.calls.length, 2); assert.equal(fp.calls[1].headers['If-None-Match'], '"v1"', 'revalidated, not downloaded again');
    assert.equal(c.stats.revalidated, 1);
    assert.equal((await c.get('osm', 3, 1, 2)).status, 200); assert.equal(fp.calls.length, 2, 'fresh again after the 304');
    // the WMTS source gets row before column
    await c.get('eox', 5, 10, 12); assert.equal(fp.calls.at(-1).url, 'https://fake.example/eox/5/12/10.jpg');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cache: at most 2 requests at a time per source, never the same tile twice at once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-tiles-'));
  const fp = fakeProvider({ delay: 30 });
  const c = createTileCache({ dir, providers: testProviders, fetchImpl: fp.impl });
  try {
    const jobs = [];
    for (let x = 0; x < 8; x++) for (let k = 0; k < 3; k++) jobs.push(c.get('osm', 4, x, 3));   // 8 tiles, each asked 3 times
    const res = await Promise.all(jobs);
    assert.ok(res.every(r => r.status === 200));
    assert.equal(fp.calls.length, 8, 'each tile fetched once');
    assert.equal(fp.maxInFlight, 2, 'never more than 2 connections (OpenStreetMap policy)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cache: refuses what it must not fetch; serves a stale copy when the provider fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-tiles-'));
  let now = 5_000_000, down = false;
  const fp = fakeProvider({ maxAge: 60 });
  const c = createTileCache({ dir, providers: testProviders, fetchImpl: (u, i) => down ? Promise.reject(new Error('offline')) : fp.impl(u, i), now: () => now });
  try {
    assert.equal((await c.get('esri', 3, 1, 1)).status, 404, 'keyed sources are never cached or proxied');
    assert.equal((await c.get('nope', 3, 1, 1)).status, 404);
    assert.equal((await c.get('eox', 15, 1, 1)).status, 404, 'past the source\'s native zoom (14): the browser scales instead');
    assert.equal((await c.get('osm', 3, 8, 1)).status, 404, 'x out of range');
    assert.equal((await c.get('osm', 3, -1, 1)).status, 404);
    assert.equal(fp.calls.length, 0, 'none of those reached the provider');
    assert.equal((await c.get('osm', 2, 1, 1)).status, 200);
    now += 120000; down = true;
    const stale = await c.get('osm', 2, 1, 1);
    assert.equal(stale.status, 200); assert.equal(stale.stale, true);
    assert.equal((await c.get('osm', 2, 2, 1)).status, 502, 'nothing to fall back on');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cache: trimmed to the size limit, least recently used first', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-tiles-'));
  const big = async () => new Response(Buffer.alloc(300 * 1024, 1), { status: 200, headers: { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' } });
  const c = createTileCache({ dir, providers: testProviders, fetchImpl: big });
  try {
    for (let x = 0; x < 6; x++) await c.get('osm', 3, x, 0);   // 6 x 300 KB
    const old = path.join(dir, 'tiles', 'osm', '3', '0', '0');
    fs.utimesSync(old, new Date(2000, 0, 1), new Date(2000, 0, 1));
    const r = c.trim(1);   // 1 MB
    assert.ok(r.bytes <= 1024 * 1024 && r.removed >= 3, JSON.stringify(r));
    assert.ok(!fs.existsSync(old), 'the oldest went first');
    assert.ok(!fs.existsSync(old + '.json'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
