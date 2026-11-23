// A small slippy map (no Leaflet, no downloads): Web Mercator tiles as <img> elements, an SVG layer for accuracy
// circles, Places and tracks, and HTML markers. Drag / pinch / wheel / double-click / buttons. Fractional zoom: tiles
// of the nearest level are scaled. Only the tiles in view are loaded - no prefetching (OpenStreetMap's tile policy).
// Several tile layers can be stacked (satellite + labels = Hybrid); each has its own tile size (256 or 512 px) and its
// highest native level - past it the last level is scaled up instead of asking the provider for more.
const TILE = 256;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const MAX_LAT = 85.05112878;

export function project(lat, lon, z) {
  const s = TILE * 2 ** z, la = clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI / 180;
  return { x: (lon + 180) / 360 * s, y: (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * s };
}
export function unproject(x, y, z) {
  const s = TILE * 2 ** z;
  return { lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / s))) * 180 / Math.PI, lon: x / s * 360 - 180 };
}
const metersPerPixel = (lat, z) => 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** z;
const NS = 'http://www.w3.org/2000/svg';

export class TileMap {
  constructor(el, opts = {}) {
    this.el = el; this.opts = { maxZoom: 19, minZoom: 2, tileUrl: '', attribution: '', attributionUrl: '', ...opts };
    this.layers = []; this.panes = [];   // layers: [{ url, tileSize, maxNative, attribution, attributionUrl, labels }]
    this.center = { lat: 0, lon: 0 }; this.zoom = 3;
    this.circles = []; this.lines = []; this.markers = [];
    this.tiles = new Map(); this.onclick = null; this.onmove = null;
    el.classList.add('tmap');
    el.innerHTML = '';
    this.tilePane = div('tmap-tiles'); this.svg = document.createElementNS(NS, 'svg'); this.svg.setAttribute('class', 'tmap-svg');
    this.markerPane = div('tmap-markers'); this.labelPane = div('tmap-labels');
    const zoom = div('tmap-zoom');
    zoom.append(btn('+', 'Zoom in', () => this.zoomBy(1)), btn('−', 'Zoom out', () => this.zoomBy(-1)));
    this.attr = div('tmap-attr');
    el.append(this.tilePane, this.svg, this.labelPane, this.markerPane, zoom, this.attr);
    this.setAttribution();
    this.bind();
    new ResizeObserver(() => this.draw()).observe(el);
  }

  // one layer from the old single-URL options (for callers that only have a tile URL)
  setOptions(o) {
    Object.assign(this.opts, o);
    if (o.tileUrl !== undefined) this.setLayers(o.tileUrl ? [{ url: o.tileUrl, tileSize: 256, maxNative: this.opts.maxZoom, attribution: this.opts.attribution, attributionUrl: this.opts.attributionUrl }] : [], { maxZoom: this.opts.maxZoom });
    else { this.setAttribution(); this.draw(); }
  }
  // a whole style; the tiles are replaced only when the layers really changed. kind: street | satellite | hybrid
  setLayers(layers, { maxZoom, kind = 'street' } = {}) {
    const sig = JSON.stringify(layers.map(l => [l.url, l.tileSize, l.maxNative]));
    if (maxZoom) this.opts.maxZoom = maxZoom;
    this.el.classList.toggle('imagery', kind !== 'street');
    this.el.dataset.style = kind;
    if (sig !== this.layerSig) {
      this.layerSig = sig;
      this.layers = layers.map((l, i) => ({ tileSize: 256, maxNative: this.opts.maxZoom, ...l, i }));
      this.tilePane.innerHTML = ''; this.tiles.clear();
      this.panes = this.layers.map(l => { const d = div('tmap-layer' + (l.labels ? ' labels' : '')); this.tilePane.append(d); return d; });
    }
    if (this.zoom > this.opts.maxZoom) this.zoom = this.opts.maxZoom;
    this.setAttribution(); this.draw();
  }
  // every layer's credit, as each provider asks: linked text, separated by |
  setAttribution() {
    this.attr.innerHTML = '';
    const seen = new Set();
    for (const l of this.layers) {
      if (!l.attribution || seen.has(l.attribution)) continue;
      seen.add(l.attribution);
      if (this.attr.childNodes.length) this.attr.append(' | ');
      if (l.attributionUrl) { const a = document.createElement('a'); a.href = l.attributionUrl; a.target = '_blank'; a.rel = 'noopener'; a.textContent = l.attribution; this.attr.append(a); }
      else this.attr.append(l.attribution);
    }
    this.attr.classList.toggle('hidden', !this.attr.childNodes.length);
  }
  setView(lat, lon, zoom = this.zoom) { this.center = { lat, lon }; this.zoom = clamp(zoom, this.opts.minZoom, this.opts.maxZoom); this.draw(); }
  zoomBy(d, px) {
    const z = clamp(Math.round((this.zoom + d) * 2) / 2, this.opts.minZoom, this.opts.maxZoom);
    this.zoomTo(z, px);
  }
  // zoom keeping the point under px (screen) where it is
  zoomTo(z, px) {
    z = clamp(z, this.opts.minZoom, this.opts.maxZoom);
    const { width: w, height: h } = this.size();
    px ||= { x: w / 2, y: h / 2 };
    const before = this.toLatLon(px.x, px.y);
    this.zoom = z;
    const c = project(this.center.lat, this.center.lon, z), p = project(before.lat, before.lon, z);
    const nc = unproject(c.x + (p.x - (c.x + px.x - w / 2)), c.y + (p.y - (c.y + px.y - h / 2)), z);
    this.center = { lat: clamp(nc.lat, -MAX_LAT, MAX_LAT), lon: wrapLon(nc.lon) };
    this.draw();
  }
  fit(points, pad = 60, maxZoom = 16) {
    if (!points.length) return;
    const { width: w, height: h } = this.size();
    if (points.length === 1) return this.setView(points[0][0], points[0][1], Math.min(maxZoom, this.opts.maxZoom));
    let z = Math.min(maxZoom, this.opts.maxZoom);
    for (; z > this.opts.minZoom; z -= 0.5) {
      const ps = points.map(p => project(p[0], p[1], z));
      const xs = ps.map(p => p.x), ys = ps.map(p => p.y);
      if (Math.max(...xs) - Math.min(...xs) <= w - pad * 2 && Math.max(...ys) - Math.min(...ys) <= h - pad * 2) break;
    }
    const ps = points.map(p => project(p[0], p[1], z));
    const cx = (Math.max(...ps.map(p => p.x)) + Math.min(...ps.map(p => p.x))) / 2, cy = (Math.max(...ps.map(p => p.y)) + Math.min(...ps.map(p => p.y))) / 2;
    const c = unproject(cx, cy, z);
    this.setView(c.lat, c.lon, z);
  }
  size() { const r = this.el.getBoundingClientRect(); return { width: r.width || 1, height: r.height || 1 }; }
  toScreen(lat, lon) {
    const { width: w, height: h } = this.size(), c = project(this.center.lat, this.center.lon, this.zoom), p = project(lat, lon, this.zoom);
    let dx = p.x - c.x; const world = TILE * 2 ** this.zoom;
    if (dx > world / 2) dx -= world; else if (dx < -world / 2) dx += world;
    return { x: w / 2 + dx, y: h / 2 + p.y - c.y };
  }
  toLatLon(x, y) {
    const { width: w, height: h } = this.size(), c = project(this.center.lat, this.center.lon, this.zoom);
    const ll = unproject(c.x + x - w / 2, c.y + y - h / 2, this.zoom);
    return { lat: ll.lat, lon: wrapLon(ll.lon) };
  }

  // overlays: replaced as a whole by the app on each refresh
  setOverlays({ circles = [], lines = [], markers = [] }) { this.circles = circles; this.lines = lines; this.markers = markers; this.draw(); }

  draw() { if (this.raf) return; this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); }); }
  render() {
    const { width: w, height: h } = this.size();
    this.svg.setAttribute('width', w); this.svg.setAttribute('height', h);
    // tiles, layer by layer. A 512 px tile at level L covers what 256 px tiles cover at zoom L + 1.
    const want = new Set();
    for (const l of this.layers) {
      const ts = l.tileSize || TILE, off = Math.round(Math.log2(ts / TILE));
      const lvl = clamp(Math.round(this.zoom) - off, 0, Math.max(0, (l.maxNative ?? this.opts.maxZoom) - off));
      const zl = lvl + off, scale = 2 ** (this.zoom - zl), n = 2 ** lvl;
      const c = project(this.center.lat, this.center.lon, zl);
      const left = c.x - w / 2 / scale, top = c.y - h / 2 / scale;
      for (let ty = Math.floor(top / ts); ty <= Math.floor((top + h / scale) / ts); ty++) {
        if (ty < 0 || ty >= n) continue;
        for (let tx = Math.floor(left / ts); tx <= Math.floor((left + w / scale) / ts); tx++) {
          const key = `${l.i}/${lvl}/${tx}/${ty}`; want.add(key);
          let img = this.tiles.get(key);
          if (!img) {
            img = document.createElement('img');
            img.alt = ''; img.draggable = false; img.decoding = 'async'; img.referrerPolicy = 'strict-origin-when-cross-origin';
            img.onerror = () => { img.classList.add('bad'); };
            img.onload = () => { img.classList.add('ok'); };
            img.src = tileSrc(l.url, lvl, ((tx % n) + n) % n, ty);
            this.tiles.set(key, img); this.panes[l.i].append(img);
          }
          img.style.left = (tx * ts - left) * scale + 'px'; img.style.top = (ty * ts - top) * scale + 'px';
          img.style.width = img.style.height = ts * scale + 0.5 + 'px';
        }
      }
    }
    for (const [k, img] of this.tiles) if (!want.has(k)) { img.remove(); this.tiles.delete(k); }
    // svg: circles (meters) and lines
    const parts = [];
    for (const ci of this.circles) {
      const p = this.toScreen(ci.lat, ci.lon), r = ci.radius / metersPerPixel(ci.lat, this.zoom);
      if (p.x + r < 0 || p.y + r < 0 || p.x - r > w || p.y - r > h) continue;
      const el = document.createElementNS(NS, 'circle');
      el.setAttribute('cx', p.x.toFixed(1)); el.setAttribute('cy', p.y.toFixed(1)); el.setAttribute('r', Math.max(ci.minPx || 0, r).toFixed(1));
      el.setAttribute('class', ci.cls || ''); if (ci.color) { el.setAttribute('fill', ci.color); el.setAttribute('stroke', ci.color); }
      parts.push(el);
    }
    for (const li of this.lines) {
      if (li.points.length < 2) continue;
      const el = document.createElementNS(NS, 'polyline');
      el.setAttribute('points', li.points.map(p => { const s = this.toScreen(p[0], p[1]); return s.x.toFixed(1) + ',' + s.y.toFixed(1); }).join(' '));
      el.setAttribute('class', li.cls || 'tmap-line'); if (li.color) el.setAttribute('stroke', li.color);
      parts.push(el);
    }
    this.svg.replaceChildren(...parts);
    // labels and markers (HTML)
    const labels = [], marks = [];
    for (const m of this.markers) {
      const p = this.toScreen(m.lat, m.lon);
      if (p.x < -60 || p.y < -60 || p.x > w + 60 || p.y > h + 60) continue;
      const el = m.el; el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      (m.label ? labels : marks).push(el);
    }
    this.labelPane.replaceChildren(...labels); this.markerPane.replaceChildren(...marks);
    if (this.onmove) this.onmove();
  }

  bind() {
    const el = this.el, pts = new Map();
    let last = null, moved = 0, pinch = null;
    const local = e => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    el.addEventListener('pointerdown', e => {
      if (e.target.closest('.tmap-zoom, .tmap-attr, .pin')) return;
      el.setPointerCapture(e.pointerId); pts.set(e.pointerId, local(e));
      if (pts.size === 1) { last = local(e); moved = 0; }
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: this.zoom }; }
    });
    el.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return;
      const p = local(e); pts.set(e.pointerId, p);
      if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
        this.zoomTo(pinch.z + Math.log2(d / pinch.d), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }); moved = 99; return;
      }
      if (pts.size !== 1 || !last) return;
      const dx = p.x - last.x, dy = p.y - last.y; moved += Math.abs(dx) + Math.abs(dy); last = p;
      const c = project(this.center.lat, this.center.lon, this.zoom), nc = unproject(c.x - dx, c.y - dy, this.zoom);
      this.center = { lat: clamp(nc.lat, -MAX_LAT, MAX_LAT), lon: wrapLon(nc.lon) }; this.draw();
    });
    const up = e => {
      if (!pts.has(e.pointerId)) return;
      const p = local(e); pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 1) last = [...pts.values()][0];
      if (pts.size === 0) { if (moved < 6 && e.type === 'pointerup' && this.onclick) { const ll = this.toLatLon(p.x, p.y); this.onclick(ll.lat, ll.lon); } last = null; }
    };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', e => { e.preventDefault(); this.zoomTo(this.zoom - Math.sign(e.deltaY) * (Math.abs(e.deltaY) > 40 ? 0.5 : 0.25), local(e)); }, { passive: false });
    el.addEventListener('dblclick', e => { if (!e.target.closest('.tmap-zoom')) this.zoomBy(1, local(e)); });
  }
}

export function tileSrc(t, z, x, y) {
  return t.replace('{s}', 'abc'[(x + y) % 3]).replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{r}', '');
}
const wrapLon = l => ((l + 540) % 360) - 180;
function div(cls) { const d = document.createElement('div'); d.className = cls; return d; }
function btn(text, title, fn) { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.title = title; b.setAttribute('aria-label', title); b.addEventListener('click', e => { e.stopPropagation(); fn(); }); return b; }
