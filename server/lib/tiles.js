// Map styles (Street / Satellite / Hybrid), the tile sources behind them, and a polite tile cache on the server.
//
// Sources and their terms (checked November 2026 - read the provider's own page before relying on this):
//   osm       OpenStreetMap standard tiles. Free, no key, attribution "(c) OpenStreetMap contributors" required. The
//             tile usage policy asks for a real User-Agent, honouring cache headers (a local cache is welcome), at most
//             2 connections and no bulk downloading. https://operations.osmfoundation.org/policies/tiles/
//   eox       EOxCloudless 2024 by EOX IT Services GmbH (Sentinel-2, worldwide, about 10 m per pixel: streets, fields
//             and parks, not single houses). No key. CC BY-NC-SA 4.0: free for personal / non-commercial use with the
//             attribution shown on the map; commercial use needs a licence from EOX. https://cloudless.eox.at
//   eoxLabels EOX "Overlay bright": place names and roads on a transparent layer, data (c) OpenStreetMap contributors,
//             rendering (c) EOX and MapServer. No key, attribution required. https://maps.eox.at
//   usgs      USGS The National Map orthoimagery (USDA NAIP): about 1 m per pixel, the 48 US states only. Public domain
//             (US government work), no key; credit "USGS The National Map". https://basemap.nationalmap.gov
//   esri      Esri World Imagery through ArcGIS Location Platform's static basemap tiles: sharp worldwide imagery. Needs
//             a free ArcGIS Location Platform account and an API key (free tier: 2 million basemap tiles a month,
//             pay-as-you-go stays off unless you turn it on). Esri's terms don't allow caching, so these tiles go
//             straight from the browser to Esri and are never stored here.
//   maptiler  MapTiler Satellite / Hybrid. Needs a free MapTiler Cloud account and key (the free plan is for
//             non-commercial use, with a monthly request limit). Not cached here either.
//
// Keys are entered on the Admin page (write-only) and are never in this repository. A key goes to the browsers of
// signed-in viewers inside the tile address, which is how these services work - restrict it to your Places address in
// the provider's dashboard.
import fs from 'node:fs';
import path from 'node:path';

const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const PROVIDERS = {
  osm: { name: 'OpenStreetMap', kind: 'street', url: OSM_URL, maxNative: 19, cache: true, attribution: '© OpenStreetMap contributors', attributionUrl: 'https://www.openstreetmap.org/copyright' },
  eox: {
    name: 'EOxCloudless 2024 (worldwide, about 10 m, no key)', kind: 'satellite', cache: true, maxNative: 14, labels: 'eoxLabels',
    url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg',
    attribution: 'EOxCloudless 2024 by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024)', attributionUrl: 'https://cloudless.eox.at',
  },
  eoxLabels: {
    name: 'EOX overlay (labels)', kind: 'labels', cache: true, maxNative: 14,
    url: 'https://tiles.maps.eox.at/wmts/1.0.0/overlay_bright_3857/default/g/{z}/{y}/{x}.png',
    attribution: 'Labels: data © OpenStreetMap contributors, rendering © EOX and MapServer', attributionUrl: 'https://maps.eox.at',
  },
  usgs: {
    name: 'USGS imagery (United States only, about 1 m, no key)', kind: 'satellite', cache: true, maxNative: 16, labels: 'eoxLabels',
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    attribution: 'USGS The National Map: orthoimagery (public domain)', attributionUrl: 'https://www.usgs.gov/programs/national-geospatial-program/national-map',
  },
  esri: {
    name: 'Esri World Imagery (free ArcGIS key)', kind: 'satellite', cache: false, key: 'esriKey', tileSize: 512, maxNative: 19, labels: 'esriLabels',
    url: 'https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/arcgis/imagery/static/tile/{z}/{y}/{x}?token={key}',
    attribution: 'Powered by Esri | Esri, Maxar, Earthstar Geographics, and the GIS User Community', attributionUrl: 'https://www.esri.com/en-us/legal/terms/data-attributions',
  },
  esriLabels: {
    name: 'Esri imagery labels', kind: 'labels', cache: false, key: 'esriKey', tileSize: 512, maxNative: 19,
    url: 'https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/arcgis/imagery/labels/static/tile/{z}/{y}/{x}?token={key}',
    attribution: 'Labels: Esri', attributionUrl: 'https://www.esri.com/en-us/legal/terms/data-attributions',
  },
  maptiler: {
    name: 'MapTiler Satellite (free MapTiler key)', kind: 'satellite', cache: false, key: 'maptilerKey', maxNative: 20, hybrid: 'maptilerHybrid',
    url: 'https://api.maptiler.com/maps/satellite/256/{z}/{x}/{y}.jpg?key={key}',
    attribution: '© MapTiler © OpenStreetMap contributors', attributionUrl: 'https://www.maptiler.com/copyright/',
  },
  maptilerHybrid: {
    name: 'MapTiler Hybrid', kind: 'hybrid', cache: false, key: 'maptilerKey', maxNative: 20,
    url: 'https://api.maptiler.com/maps/hybrid/256/{z}/{x}/{y}.jpg?key={key}',
    attribution: '© MapTiler © OpenStreetMap contributors', attributionUrl: 'https://www.maptiler.com/copyright/',
  },
};
export const SATELLITES = ['eox', 'usgs', 'esri', 'maptiler'];
export const STYLES = ['street', 'satellite', 'hybrid'];
// how to get a key, shown on the Admin page
export const KEY_HELP = {
  esri: ['Go to location.arcgis.com and sign up for a free ArcGIS Location Platform account.',
    'In the portal, open Content > New item > Developer credentials > API key credentials.',
    'Give it the privilege "Basemaps > Static basemap tiles" (premium:user:staticbasemaptiles) and nothing else.',
    'Under Referrers add your Places address (e.g. https://places.example.com), set an expiry, create it and copy the key.',
    'Paste it here. Leave pay-as-you-go off: when the free tier runs out, Esri stops serving tiles instead of billing you.'],
  maptiler: ['Go to cloud.maptiler.com and create a free account.',
    'Open API keys (Account > Keys) and create a key, or copy the default one.',
    'Under "Allowed HTTP origins" add your Places address (e.g. places.example.com).',
    'Paste it here. The free plan is for non-commercial use and has a monthly request limit.'],
};

const isOsmDefault = s => !s.tileUrl || s.tileUrl === OSM_URL;

// the layers each style uses for these settings. proxy: true = cacheable sources go through /tiles/<source>/...
export function resolveStyles(s, { cache = s.tileCache !== false } = {}) {
  const layer = id => {
    const p = PROVIDERS[id];
    const direct = p.url.replace('{key}', encodeURIComponent(p.key ? s[p.key] || '' : ''));
    return { id, url: p.cache && cache ? `/tiles/${id}/{z}/{x}/{y}` : direct, tileSize: p.tileSize || 256, maxNative: p.maxNative, attribution: p.attribution, attributionUrl: p.attributionUrl, labels: p.kind === 'labels' };
  };
  const street = isOsmDefault(s) ? [layer('osm')]
    : [{ id: 'custom', url: s.tileUrl, tileSize: 256, maxNative: s.maxZoom || 19, attribution: s.tileAttribution || '', attributionUrl: s.tileAttributionUrl || '' }];
  let sat = SATELLITES.includes(s.satellite) ? s.satellite : 'eox', note = '';
  if (PROVIDERS[sat].key && !s[PROVIDERS[sat].key]) { note = `${PROVIDERS[sat].name} needs a key - showing EOxCloudless instead`; sat = 'eox'; }
  const p = PROVIDERS[sat];
  const satellite = [layer(sat)];
  const hybrid = p.hybrid ? [layer(p.hybrid)] : [layer(sat), layer(p.labels)];
  const style = STYLES.includes(s.mapStyle) ? s.mapStyle : 'street';
  return {
    default: style, satellite: sat, note,
    styles: { street: { layers: street, maxZoom: s.maxZoom || 19 }, satellite: { layers: satellite, maxZoom: 19 }, hybrid: { layers: hybrid, maxZoom: 19 } },
  };
}

// origins the browser loads tiles from directly (for the Content-Security-Policy img-src)
export function directOrigins(resolved) {
  const out = new Set();
  for (const st of Object.values(resolved.styles)) for (const l of st.layers) {
    if (l.url.startsWith('/')) continue;
    try {
      const u = new URL(l.url.replace(/\{s\}/g, 'hallowsubdomain').replace(/\{[a-z]+\}/g, '0'));
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
      out.add(`${u.protocol}//${u.host.includes('hallowsubdomain') ? '*.' + u.host.split('.').slice(1).join('.') : u.host}`);
    } catch { }
  }
  return [...out];
}

// ---- the cache: GET /tiles/<source>/<z>/<x>/<y> for signed-in viewers only (never an open proxy)
//   - fetched once, stored in <data>/tiles/<source>/<z>/<x>/<y>, kept as long as the provider's Cache-Control / Expires
//     says (7 days when it says nothing), then revalidated with If-None-Match / If-Modified-Since
//   - at most 2 requests at a time per source, the same tile never fetched twice at once, no prefetching
//   - a User-Agent that names the app; when a provider fails, a stale copy is served instead of hammering it
//   - the folder is trimmed to tileCacheMB (oldest first) in the hourly sweep
export const USER_AGENT = 'HallowPlaces/1.1 (self-hosted family map; +https://github.com/Dom428/hallow-places)';
export function createTileCache({ dir, providers = PROVIDERS, fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => {}, maxPerSource = 2, timeoutMs = 10000 }) {
  const root = path.join(dir, 'tiles');
  const inflight = new Map(), active = new Map(), queues = new Map();
  const stats = { hits: 0, misses: 0, revalidated: 0, upstream: 0, errors: 0 };

  async function slot(src) {
    if ((active.get(src) || 0) < maxPerSource) { active.set(src, (active.get(src) || 0) + 1); return; }
    const q = queues.get(src) || []; queues.set(src, q);
    if (q.length > 200) throw Object.assign(new Error('busy'), { code: 503 });
    await new Promise(r => q.push(r));   // the slot is handed over by release()
  }
  function release(src) {
    const q = queues.get(src);
    if (q && q.length) q.shift()(); else active.set(src, (active.get(src) || 1) - 1);
  }
  const ttlFrom = h => {
    const m = /max-age=(\d+)/.exec(h.get('cache-control') || '');
    if (m) return Number(m[1]) * 1000;
    const e = Date.parse(h.get('expires') || ''); if (Number.isFinite(e)) return Math.max(0, e - now());
    return 7 * 86400000;
  };

  async function upstream(src, z, x, y, meta) {
    const p = providers[src];
    const url = p.url.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'abc'[(x + y) % 3]);
    const headers = { 'User-Agent': USER_AGENT, 'Accept': 'image/*' };
    if (meta?.etag) headers['If-None-Match'] = meta.etag;
    if (meta?.lastModified) headers['If-Modified-Since'] = meta.lastModified;
    await slot(src);
    try {
      stats.upstream++;
      const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      if (r.status === 304 && meta) { stats.revalidated++; return { status: 304, ttl: ttlFrom(r.headers) }; }
      if (!r.ok) return { status: r.status };
      const type = (r.headers.get('content-type') || '').split(';')[0].trim();
      if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) return { status: 502 };
      const body = Buffer.from(await r.arrayBuffer());
      if (body.length > 2 * 1024 * 1024) return { status: 502 };
      return { status: 200, body, type, ttl: ttlFrom(r.headers), etag: r.headers.get('etag') || '', lastModified: r.headers.get('last-modified') || '' };
    } finally { release(src); }
  }

  // returns { status, body?, type? }
  async function get(src, z, x, y) {
    const p = providers[src];
    if (!p || !p.cache) return { status: 404 };
    if (!(Number.isInteger(z) && z >= 0 && z <= p.maxNative && Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z)) return { status: 404 };
    const key = `${src}/${z}/${x}/${y}`;
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      const file = path.join(root, src, String(z), String(x), String(y));
      let meta = null, body = null;
      try { meta = JSON.parse(await fs.promises.readFile(file + '.json', 'utf8')); body = await fs.promises.readFile(file); } catch { meta = null; body = null; }
      if (meta && body && meta.expires > now()) {
        stats.hits++;
        fs.promises.utimes(file, new Date(), new Date()).catch(() => {});   // recently used: trimmed last
        return { status: 200, body, type: meta.type };
      }
      stats.misses++;
      let r;
      try { r = await upstream(src, z, x, y, body ? meta : null); } catch (e) { stats.errors++; r = { status: e.code || 504 }; }
      if (r.status === 304) {
        meta.expires = now() + r.ttl;
        await fs.promises.writeFile(file + '.json', JSON.stringify(meta)).catch(() => {});
        return { status: 200, body, type: meta.type };
      }
      if (r.status === 200) {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, r.body);
        await fs.promises.writeFile(file + '.json', JSON.stringify({ type: r.type, expires: now() + r.ttl, etag: r.etag, lastModified: r.lastModified }));
        return { status: 200, body: r.body, type: r.type };
      }
      stats.errors++;
      if (body && meta) return { status: 200, body, type: meta.type, stale: true };   // better an old tile than none
      if (r.status !== 404) log(`tiles: ${src} answered ${r.status}`);
      return { status: r.status === 404 ? 404 : 502 };
    })();
    inflight.set(key, job);
    try { return await job; } finally { inflight.delete(key); }
  }

  // keep the folder under maxMB: delete the least recently used tiles first
  function trim(maxMB) {
    const files = [];
    const walk = d => { let list = []; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of list) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (!e.name.endsWith('.json')) { try { const st = fs.statSync(f); files.push({ f, size: st.size, t: st.mtimeMs }); } catch { } } } };
    walk(root);
    let total = files.reduce((a, b) => a + b.size, 0);
    const limit = maxMB * 1024 * 1024;
    let removed = 0;
    if (total > limit) {
      files.sort((a, b) => a.t - b.t);
      for (const x of files) { if (total <= limit * 0.9) break; fs.rmSync(x.f, { force: true }); fs.rmSync(x.f + '.json', { force: true }); total -= x.size; removed++; }
    }
    return { files: files.length - removed, bytes: total, removed };
  }

  return { get, trim, stats };
}
