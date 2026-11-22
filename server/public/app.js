// Hallow Places web app: sign in, the family map, your own sharing page, and the admin page.
import { TileMap } from './map.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = {
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  out: '<svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
  fit: '<svg viewBox="0 0 24 24"><path d="M3 8V3h5M21 8V3h-5M3 16v5h5M21 16v5h-5"/></svg>',
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const api = {
  async req(method, path, body) {
    const r = await fetch(path, { method, headers: { 'X-Hallow': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    let data = {}; try { data = await r.json(); } catch { }
    if (r.status === 401 && path !== '/api/login' && path !== '/api/session') { location.reload(); throw new Error('Signed out'); }
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  },
  get: p => api.req('GET', p),
  post: (p, b = {}) => api.req('POST', p, b),
};

// ---- theme: follows the system unless picked here
const media = matchMedia('(prefers-color-scheme: light)');
function applyTheme() {
  const pick = localStorage.getItem('hp-theme');
  document.documentElement.dataset.theme = pick === 'light' || pick === 'dark' ? pick : media.matches ? 'light' : 'dark';
  const b = $('#theme'); if (b) { b.innerHTML = document.documentElement.dataset.theme === 'dark' ? ICON.sun : ICON.moon; b.title = 'Light or dark'; }
}
media.addEventListener('change', applyTheme);
applyTheme();

const T = { session: null, data: null, view: 'map', selected: null, track: null, trackDate: null, map: null, admin: null, timer: null, firstFit: false };
window.__places = T;   // for the page checks

function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function fmtTime(ms, opts = {}) { return new Intl.DateTimeFormat(undefined, { timeZone: T.data?.timeZone || undefined, hour: '2-digit', minute: '2-digit', ...opts }).format(new Date(ms)); }
function ago(ms) {
  const now = T.data?.now || Date.now(), s = Math.max(0, (now - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return fmtTime(ms, { weekday: 'short', day: 'numeric', month: 'short' });
}
const battHtml = (b, bs) => b == null ? '' : `<span class="batt${b < 20 && bs !== 2 ? ' low' : ''}" title="Battery ${b}%${bs === 2 ? ', charging' : ''}"><i><b data-w="${Math.max(2, Math.round(b / 100 * 16))}"></b></i>${b}%${bs === 2 ? ' +' : ''}</span>`;
function sizeBatteries(root) { root.querySelectorAll('.batt b[data-w]').forEach(b => { b.style.width = b.dataset.w + 'px'; }); }
function avatar(p, cls = '') { const a = el(`<span class="avatar ${cls}">${esc(p.tid || p.name.slice(0, 2))}</span>`); a.style.background = p.color; return a; }

function dialog(html, onMount) {
  const o = el(`<div class="overlay"><div class="dialog" role="dialog" aria-modal="true">${html}</div></div>`);
  const close = () => o.remove();
  o.addEventListener('click', e => { if (e.target === o || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', k); } });
  document.body.append(o);
  onMount?.(o, close);
  o.querySelector('button, input')?.focus();
  return close;
}
function confirmBox(text, yes = 'Yes', danger = true) {
  return new Promise(res => dialog(`<h3>${esc(text)}</h3><div class="actions"><button class="${danger ? 'danger' : 'accent'}" data-yes>${esc(yes)}</button><button data-close>Cancel</button></div>`, (o, close) => {
    o.querySelector('[data-yes]').onclick = () => { close(); res(true); };
    o.addEventListener('click', e => { if (e.target.closest('[data-close]') || e.target === o) res(false); });
  }));
}

// ---- sign in / first-run setup
function showLogin(needsSetup) {
  document.body.innerHTML = '';
  const card = el(`<div class="page"><div class="card">
    <div class="brand"><img src="icon.svg" alt=""><span><b>HALLOW</b> PLACES</span></div>
    <p class="muted small">${needsSetup ? 'First start: set the admin password. The one-time setup code is in the server log (<code>docker logs hallow-places</code>).' : 'Private family location sharing. Sign in with the name and password your family admin gave you.'}</p>
    <form autocomplete="on">
      ${needsSetup
        ? '<label>Setup code<input name="code" inputmode="numeric" autocomplete="one-time-code" required></label><label>New admin password (10+ characters)<input name="password" type="password" autocomplete="new-password" minlength="10" required></label>'
        : '<label>Name<input name="user" autocomplete="username" autocapitalize="none" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label>'}
      <button class="accent" type="submit">${needsSetup ? 'Set password' : 'Sign in'}</button>
      <div class="msg" role="status"></div>
    </form></div></div>`);
  document.body.append(card);
  const f = $('form', card);
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    try { await api.post(needsSetup ? '/api/setup' : '/api/login', d); location.reload(); }
    catch (err) { $('.msg', card).textContent = err.message; }
  });
  f.querySelector('input').focus();
}

// ---- the app
async function showApp() {
  document.body.innerHTML = '';
  const s = T.session;
  const app = el(`<div id="app">
    <header class="top">
      <div class="brand"><img src="icon.svg" alt=""><span><b>HALLOW</b> PLACES</span></div>
      <nav><button data-view="map">Map</button>${s.admin ? '' : '<button data-view="me">Me</button>'}${s.admin ? '<button data-view="admin">Admin</button>' : ''}</nav>
      <div class="spacer"></div>
      <button class="iconbtn" id="theme" aria-label="Light or dark"></button>
      <button class="iconbtn" id="signout" title="Sign out" aria-label="Sign out">${ICON.out}</button>
    </header>
    <div class="layout"><aside id="side"></aside><section id="mapwrap"><div id="map"></div></section></div>
  </div>`);
  document.body.append(app);
  applyTheme();
  $('#theme').onclick = () => { localStorage.setItem('hp-theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); applyTheme(); };
  $('#signout').onclick = async () => { await api.post('/api/logout').catch(() => {}); location.href = '/'; };
  app.querySelectorAll('nav button').forEach(b => b.onclick = () => setView(b.dataset.view));
  T.map = new TileMap($('#map'), {});
  const fitBtn = el(`<button class="iconbtn" title="Show everyone" aria-label="Show everyone">${ICON.fit}</button>`);
  fitBtn.classList.add('fitbtn');
  fitBtn.onclick = () => fitAll();
  $('#mapwrap').append(fitBtn);
  T.map.onclick = (lat, lon) => { if (T.view === 'admin' && T.pickPlace) T.pickPlace(lat, lon); };
  await refresh();
  fitAll();
  const start = location.pathname === '/admin' && s.admin ? 'admin' : location.pathname === '/me' && !s.admin ? 'me' : 'map';
  setView(start);
  T.timer = setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh().catch(() => {}); });
}

function setView(v) {
  T.view = v;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  $('.layout').classList.toggle('tall', v !== 'map');
  history.replaceState(null, '', v === 'map' ? '/' : '/' + v);
  T.pickPlace = null;
  $('.maphint')?.remove();
  if (v === 'map') renderSide(); else if (v === 'me') renderMe(); else renderAdmin();
}

async function refresh() {
  const d = await api.get('/api/map');
  const tilesChanged = !T.data || T.data.map.tileUrl !== d.map.tileUrl;
  T.data = d;
  T.map.setOptions({ tileUrl: d.map.tileUrl, attribution: d.map.attribution, attributionUrl: d.map.attributionUrl, maxZoom: d.map.maxZoom });
  if (tilesChanged) T.map.draw();
  if (T.selected && T.view === 'map') await loadTrack(T.selected, T.trackDate, true);
  drawMap();
  if (T.view === 'map') renderSide();
}

function fitAll() {
  const pts = T.data.people.filter(p => p.last).map(p => [p.last.lat, p.last.lon]);
  T.data.places.forEach(p => pts.push([p.lat, p.lon]));
  if (pts.length) T.map.fit(pts, 70, 16); else T.map.setView(20, 0, 2);
}

function drawMap() {
  const d = T.data, circles = [], markers = [], lines = [];
  for (const pl of d.places) {
    circles.push({ lat: pl.lat, lon: pl.lon, radius: pl.radius, cls: 'place' });
    const lab = el(`<div class="plabel"><span>${esc(pl.name)}</span></div>`);
    markers.push({ lat: pl.lat, lon: pl.lon, el: lab, label: true });
  }
  if (T.track && T.track.points.length > 1) {
    const p = d.people.find(x => x.id === T.track.person);
    lines.push({ points: T.track.points.map(x => [x[0], x[1]]), color: p?.color || '#F07820' });
  }
  for (const p of d.people) {
    if (!p.last) continue;
    if (p.last.acc) circles.push({ lat: p.last.lat, lon: p.last.lon, radius: p.last.acc, cls: 'acc', color: p.color });
    const stale = d.now - p.last.tst * 1000 > 3 * 3600000;
    const pin = el(`<div class="pin${stale ? ' stale' : ''}" role="button" tabindex="0" aria-label="${esc(p.name)}"></div>`);
    pin.append(avatar(p));
    if (T.selected === p.id || d.people.filter(x => x.last).length <= 4) pin.append(el(`<span class="tag">${esc(p.name)} · ${esc(ago(p.last.tst * 1000))}</span>`));
    pin.onclick = () => select(p.id);
    pin.onkeydown = e => { if (e.key === 'Enter') select(p.id); };
    markers.push({ lat: p.last.lat, lon: p.last.lon, el: pin });
  }
  T.map.setOverlays({ circles, markers, lines });
}

async function loadTrack(id, date, quiet) {
  try {
    T.track = await api.get(`/api/track?person=${encodeURIComponent(id)}${date ? '&date=' + date : ''}`);
    T.trackDate = date || null;
  } catch (e) { if (!quiet) throw e; }
}
async function select(id) {
  if (T.view !== 'map') setView('map');
  if (T.selected === id) { T.selected = null; T.track = null; drawMap(); renderSide(); return; }
  T.selected = id; T.trackDate = null;
  await loadTrack(id);
  const p = T.data.people.find(x => x.id === id);
  const pts = T.track.points.map(x => [x[0], x[1]]);
  if (p?.last) pts.push([p.last.lat, p.last.lon]);
  if (pts.length) T.map.fit(pts, 60, 16);
  drawMap(); renderSide();
}

function personLine(p) {
  if (p.paused) return 'Sharing paused';
  if (!p.last) return 'Waiting for their phone';
  const bits = [p.at ? 'At ' + p.at : 'Not at a Place'];
  if (p.last.vel >= 5) bits.push(p.last.vel + ' km/h');
  return bits.join(' · ');
}

function renderSide() {
  const d = T.data, side = $('#side');
  side.innerHTML = '';
  side.append(el('<h2>Family</h2>'));
  if (!d.people.length) side.append(el(`<div class="empty">Nobody yet.${T.session.admin ? ' Add people on the Admin page.' : ''}</div>`));
  for (const p of d.people) {
    const b = el(`<button class="person${T.selected === p.id ? ' sel' : ''}" type="button">
      <span class="who"><div class="name">${esc(p.name)}${p.id === d.me ? ' <span class="pill">you</span>' : ''}</div><div class="line">${esc(personLine(p))}</div></span>
      <span class="meta">${p.last ? `<span>${esc(ago(p.last.tst * 1000))}</span>${battHtml(p.last.batt, p.last.bs)}` : ''}</span></button>`);
    b.prepend(avatar(p, p.paused ? 'off' : ''));
    b.disabled = !p.last;
    b.onclick = () => select(p.id);
    side.append(b);
    if (T.selected === p.id && p.last) {
      const days = (T.track?.days || []).slice().reverse();
      const det = el(`<div class="detail">
        <div class="row"><b>Last update</b> ${esc(fmtTime(p.last.tst * 1000, { weekday: 'short' }))} <span class="muted">(${esc(ago(p.last.tst * 1000))})</span></div>
        <div class="row">${p.last.acc != null ? `<span class="pill">±${p.last.acc} m</span>` : ''}${p.last.vel != null ? `<span class="pill">${p.last.vel} km/h</span>` : ''}${p.last.conn ? `<span class="pill">${{ w: 'Wi-Fi', m: 'mobile data', o: 'offline' }[p.last.conn]}</span>` : ''}</div>
        <div class="row"><label class="small muted">Track <select aria-label="Day">${days.map(x => `<option value="${x}"${(T.track?.date === x) ? ' selected' : ''}>${x === days[0] ? 'Latest day (' + x + ')' : x}</option>`).join('') || '<option>Today</option>'}</select></label>
        <span class="muted small">${T.track ? T.track.points.length + ' points' : ''}</span></div></div>`);
      $('select', det).onchange = async e => { await loadTrack(p.id, e.target.value); drawMap(); renderSide(); if (T.track.points.length) T.map.fit(T.track.points.map(x => [x[0], x[1]]), 60, 16); };
      side.append(det);
    }
  }
  sizeBatteries(side);
  side.append(el('<h2>Alerts</h2>'));
  if (!d.feed.length) side.append(el('<div class="empty">No alerts yet. Arrivals, departures and rule alerts show here.</div>'));
  else {
    const ul = el('<ul class="feed"></ul>');
    for (const a of d.feed.slice(0, 40)) ul.append(el(`<li><span class="dot ${esc(a.kind)}"></span><div><div>${esc(a.text)}</div><div class="when">${esc(ago(a.ts))}${a.pushed ? ' · sent' : ''}${a.quiet ? ' · quiet hours, not sent' : ''}</div></div></li>`));
    side.append(ul);
  }
}

// ---- my own sharing
async function renderMe() {
  const side = $('#side');
  const m = await api.get('/api/me');
  side.innerHTML = '';
  side.append(el('<h2>Your sharing</h2>'));
  const top = el(`<div class="box"><div class="big"><span class="state ${m.paused ? 'off' : 'on'}">${m.paused ? 'Sharing is paused' : 'Sharing is on'}</span><span class="spacer"></span><button class="${m.paused ? 'accent' : ''}" id="pause">${m.paused ? 'Resume sharing' : 'Pause sharing'}</button></div>
    <p class="small muted">${m.paused ? 'Nobody - not even the admin - sees where you are while sharing is paused, and nothing your phone sends is kept. Only you can resume.' : 'You can pause any time: nobody, not even the admin, will see your position until you resume. You can also pause in the OwnTracks app.'}</p></div>`);
  $('#pause', top).onclick = async () => { await api.post('/api/me/pause', { paused: !m.paused }); await refresh(); renderMe(); };
  side.append(top);
  side.append(el(`<div class="box"><b>What is shared</b><ul>${m.shared.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    <p class="small muted">Nothing else: no contacts, messages, photos or app use. History older than ${m.retentionDays} days is deleted automatically.</p>
    <b>Who can see it</b><ul>${m.viewers.map(x => `<li>${esc(x)}</li>`).join('')}<li>The family admin</li></ul>
    ${m.pushes.length ? `<b>Where alerts about you go</b><ul>${m.pushes.map(x => `<li>${esc(x)}</li>`).join('')}<li>The alerts list on this page</li></ul>` : ''}
    <p class="small muted">${m.encrypted ? 'Your phone seals its messages with a key only your phone and this server know (OwnTracks payload encryption), on top of HTTPS.' : 'Your phone sends over HTTPS.'}</p></div>`));
  // phones
  const ph = el(`<div class="box"><b>Your phone</b><div id="devs"></div><div class="actions"><button class="accent" id="setup">Set up my phone</button></div>
    <p class="small muted">Shows a QR code for the OwnTracks app. Making a new one signs out the phone that used the old one.</p></div>`);
  const devs = $('#devs', ph);
  if (!m.devices.length) devs.append(el('<div class="empty">No phone set up yet.</div>'));
  for (const d of m.devices) devs.append(el(`<div class="item"><div class="grow">${esc(d.name)} <span class="sub">(${esc(d.id)})</span><div class="sub">${d.lastSeen ? 'Last message ' + esc(ago(d.lastSeen)) : 'Nothing received yet'}</div></div>${d.plaintextRefused ? '<span class="pill warn">sends unencrypted - scan a new QR</span>' : ''}</div>`));
  $('#setup', ph).onclick = async () => showSetup(await api.post('/api/me/phone', {}), m.name);
  side.append(ph);
  // quiet hours
  const q = el(`<div class="box"><b>Quiet hours</b><p class="small muted">Alerts about you still show here, but aren't sent to Discord or ntfy in these hours.</p>
    <div class="rowf"><label class="field">From<input type="time" id="qf" value="${esc(m.quiet?.from || '')}"></label><label class="field">To<input type="time" id="qt" value="${esc(m.quiet?.to || '')}"></label><button id="qs">Save</button></div><div class="msg" id="qm"></div></div>`);
  $('#qs', q).onclick = async () => { try { const f = $('#qf', q).value, t = $('#qt', q).value; await api.post('/api/me/quiet', { quiet: f || t ? { from: f, to: t } : null }); $('#qm', q).className = 'msg ok'; $('#qm', q).textContent = 'Saved'; } catch (e) { $('#qm', q).className = 'msg'; $('#qm', q).textContent = e.message; } };
  side.append(q);
  // history and password
  const h = el(`<div class="box"><b>Your history</b><p class="small muted">${m.days} day${m.days === 1 ? '' : 's'} kept. Deleting removes every saved position and every alert about you, at once.</p>
    <div class="actions"><button class="danger" id="del">Delete my history</button></div></div>`);
  $('#del', h).onclick = async () => { if (await confirmBox('Delete all your saved positions and alerts? This cannot be undone.', 'Delete my history')) { await api.post('/api/me/delete-history'); T.track = null; await refresh(); renderMe(); } };
  side.append(h);
  const pw = el(`<div class="box"><b>Your password</b><form class="rowf"><label class="field">Current<input type="password" name="old" autocomplete="current-password" required></label><label class="field">New (8+)<input type="password" name="password" autocomplete="new-password" minlength="8" required></label><button>Change</button></form><div class="msg"></div></div>`);
  $('form', pw).onsubmit = async e => { e.preventDefault(); try { await api.post('/api/me/password', Object.fromEntries(new FormData(e.target))); $('.msg', pw).className = 'msg ok'; $('.msg', pw).textContent = 'Changed'; e.target.reset(); } catch (err) { $('.msg', pw).className = 'msg'; $('.msg', pw).textContent = err.message; } };
  side.append(pw);
}

function showSetup(s, name) {
  const qr = 'data:image/svg+xml;base64,' + btoa(s.qr);
  dialog(`<h3>Set up ${esc(name)}'s phone</h3>
    <ol class="small"><li>Install <b>OwnTracks</b> (free, App Store / Google Play).</li><li>Scan this code with the phone's camera and open it in OwnTracks - or, on the phone itself, tap <b>Open in OwnTracks</b>.</li><li>Allow location "Always" so Places and alerts work.</li></ol>
    <img class="qr" src="${qr}" alt="QR code with the OwnTracks setup">
    <div class="actions"><a href="${esc(s.inline)}"><button type="button" class="accent">Open in OwnTracks</button></a><a href="${esc(s.otrc)}" download><button type="button">Download .otrc file</button></a></div>
    <p class="small muted">Shown once. The download link works once, for 30 minutes. Making a new setup signs out the phone that used the old one.</p>
    <details class="small"><summary>Type it in by hand</summary><div class="kv">
      <span>Mode</span><span>HTTP</span><span>URL</span><span class="secret">${esc(s.url)}</span><span>User name</span><span class="secret">${esc(s.user)}</span>
      <span>Password</span><span class="secret">${esc(s.token)}</span><span>Device ID</span><span class="secret">${esc(s.device)}</span>
      ${s.encrypted ? '<span>Encryption key</span><span class="small">in the QR / file (Settings &gt; Encryption key)</span>' : ''}</div></details>
    <div class="actions"><button data-close>Done</button></div>`);
}

// ---- admin
async function renderAdmin() {
  const side = $('#side');
  const A = T.admin = await api.get('/api/admin');
  side.innerHTML = '';
  const nameOf = id => id === '*' ? 'anyone' : A.people.find(p => p.id === id)?.name || '?';
  const placeOf = id => id === '*' ? 'any Place' : A.places.find(p => p.id === id)?.name || '?';

  // people
  side.append(el('<h2>People</h2>'));
  const pb = el('<div class="box"></div>');
  for (const p of A.people) {
    const it = el(`<div class="item"><div class="grow"><b>${esc(p.name)}</b> <span class="sub">${esc(p.user)}</span>
      <div class="sub">${p.paused ? '<span class="pill warn">paused</span> ' : ''}${p.hasPassword ? 'can sign in' : 'no sign-in'} · ${p.devices.length ? p.devices.map(d => esc(d.name) + (d.lastSeen ? ' ' + esc(ago(d.lastSeen)) : ' (nothing yet)')).join(', ') : 'no phone'} · ${p.days} day${p.days === 1 ? '' : 's'}${p.quiet ? ` · quiet ${esc(p.quiet.from)}-${esc(p.quiet.to)}` : ''}${p.encrypt ? '' : ' · unencrypted'}</div>
      ${p.devices.some(d => d.plaintextRefused) ? '<div><span class="pill warn">phone sends unencrypted - make a new setup</span></div>' : ''}</div>
      <button data-a="phone">Phone setup</button><button class="link" data-a="edit">Edit</button></div>`);
    it.prepend(avatar(p, p.paused ? 'off' : ''));
    it.querySelector('[data-a=phone]').onclick = async () => showSetup(await api.post('/api/admin/person/phone', { id: p.id }), p.name);
    it.querySelector('[data-a=edit]').onclick = () => personDialog(p);
    pb.append(it);
  }
  const add = el('<div class="actions"><button class="accent">Add a person</button></div>');
  add.querySelector('button').onclick = () => personDialog(null);
  pb.append(add);
  side.append(pb);

  // places
  side.append(el('<h2>Places</h2>'));
  const plb = el('<div class="box"></div>');
  for (const pl of A.places) {
    const it = el(`<div class="item"><div class="grow"><b>${esc(pl.name)}</b><div class="sub">${pl.radius} m around ${pl.lat.toFixed(5)}, ${pl.lon.toFixed(5)}</div></div><button class="link" data-a="show">Show</button><button class="link" data-a="edit">Edit</button></div>`);
    it.querySelector('[data-a=show]').onclick = () => T.map.setView(pl.lat, pl.lon, 16);
    it.querySelector('[data-a=edit]').onclick = () => placeForm(pl);
    plb.append(it);
  }
  const pform = el(`<form class="placeform"><div class="rowf"><label class="field">Name<input name="name" required maxlength="40" placeholder="Home, School..."></label><label class="field">Radius (m)<input name="radius" type="number" min="25" max="5000" value="120" required></label></div>
    <div class="rowf"><label class="field">Latitude<input name="lat" type="number" step="any" required></label><label class="field">Longitude<input name="lon" type="number" step="any" required></label><button type="button" data-a="centre">Map centre</button></div>
    <input type="hidden" name="id"><div class="actions"><button class="accent">Save Place</button><button type="button" class="danger hidden" data-a="del">Delete</button><button type="button" class="hidden" data-a="new">New</button></div><div class="msg"></div>
    <p class="small muted">Tip: click the map to put the Place there. 100-200 m suits a home; bigger for a school or campus.</p></form>`);
  function placeForm(pl) {
    pform.reset(); pform.name.value = pl?.name || ''; pform.radius.value = pl?.radius || 120; pform.lat.value = pl?.lat ?? ''; pform.lon.value = pl?.lon ?? ''; pform.id.value = pl?.id || '';
    pform.querySelector('[data-a=del]').classList.toggle('hidden', !pl); pform.querySelector('[data-a=new]').classList.toggle('hidden', !pl);
    if (pl) { T.map.setView(pl.lat, pl.lon, Math.max(T.map.zoom, 15)); pform.name.focus(); }
  }
  pform.querySelector('[data-a=centre]').onclick = () => { pform.lat.value = T.map.center.lat.toFixed(6); pform.lon.value = T.map.center.lon.toFixed(6); };
  pform.querySelector('[data-a=new]').onclick = () => placeForm(null);
  pform.querySelector('[data-a=del]').onclick = async () => { if (await confirmBox(`Delete the Place "${pform.name.value}" and its rules?`, 'Delete')) { await api.post('/api/admin/place/delete', { id: pform.id.value }); await refresh(); renderAdmin(); } };
  pform.onsubmit = async e => { e.preventDefault(); try { const d = Object.fromEntries(new FormData(pform)); if (!d.id) delete d.id; await api.post('/api/admin/place', d); await refresh(); renderAdmin(); } catch (err) { $('.msg', pform).textContent = err.message; } };
  T.pickPlace = (lat, lon) => { pform.lat.value = lat.toFixed(6); pform.lon.value = lon.toFixed(6); };
  plb.append(pform);
  side.append(plb);
  $('#mapwrap').append(el('<div class="maphint">Click the map to set a Place</div>'));

  // rules
  side.append(el('<h2>Alert rules</h2>'));
  const rb = el('<div class="box"></div>');
  const ruleText = r => ({
    arrive: `When ${nameOf(r.person)} arrives at ${placeOf(r.place)}`,
    leave: `When ${nameOf(r.person)} leaves ${placeOf(r.place)}`,
    notLeft: `If ${nameOf(r.person)} hasn't left ${placeOf(r.place)} by ${r.time}`,
    notArrived: `If ${nameOf(r.person)} hasn't arrived at ${placeOf(r.place)} by ${r.time}${r.after ? ' (since ' + r.after + ')' : ''}`,
    battery: `When ${nameOf(r.person)}'s battery drops under ${r.below}%`,
    noUpdate: `When there's no update from ${nameOf(r.person)} for ${r.hours} h`,
    stationary: `When ${nameOf(r.person)} stays at an unknown place for ${r.hours} h`,
  }[r.type] + (r.days && r.days.length && r.days.length < 7 ? ' on ' + r.days.map(d => DAYS[d]).join(', ') : ''));
  for (const r of A.rules) {
    const it = el(`<div class="item"><input type="checkbox" aria-label="On" ${r.enabled !== false ? 'checked' : ''}><div class="grow">${esc(ruleText(r))}</div><button class="link" data-a="del">Delete</button></div>`);
    it.querySelector('input').onchange = async e => { await api.post('/api/admin/rule', { ...r, enabled: e.target.checked }); };
    it.querySelector('[data-a=del]').onclick = async () => { await api.post('/api/admin/rule/delete', { id: r.id }); renderAdmin(); };
    rb.append(it);
  }
  const opts = (list, any) => (any ? `<option value="*">${any}</option>` : '') + list.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  const rf = el(`<form><div class="rowf"><label class="field">Alert<select name="type">
      <option value="arrive">arrives at</option><option value="leave">leaves</option><option value="notLeft">hasn't left ... by</option><option value="notArrived">hasn't arrived at ... by</option>
      <option value="battery">battery under</option><option value="noUpdate">no update for</option><option value="stationary">stays at an unknown place for</option></select></label>
    <label class="field">Who<select name="person">${opts(A.people, 'Anyone')}</select></label></div>
    <div class="rowf"><label class="field" data-f="place">Place<select name="place">${opts(A.places, 'Any Place')}</select></label>
    <label class="field" data-f="time">By<input type="time" name="time" value="08:30"></label><label class="field" data-f="after">Since (optional)<input type="time" name="after"></label>
    <label class="field" data-f="below">Under (%)<input type="number" name="below" min="1" max="99" value="15"></label><label class="field" data-f="hours">Hours<input type="number" name="hours" min="0.25" max="168" step="0.25" value="3"></label></div>
    <div class="days" data-f="days">${DAYS.map((d, i) => `<label><input type="checkbox" name="d${i}" ${i > 0 && i < 6 ? 'checked' : ''}>${d}</label>`).join('')}</div>
    <div class="actions"><button class="accent">Add rule</button></div><div class="msg"></div></form>`);
  const showFields = () => {
    const t = rf.type.value, need = { arrive: ['place'], leave: ['place'], notLeft: ['place', 'time', 'days'], notArrived: ['place', 'time', 'after', 'days'], battery: ['below'], noUpdate: ['hours'], stationary: ['hours'] }[t];
    rf.querySelectorAll('[data-f]').forEach(x => x.classList.toggle('hidden', !need.includes(x.dataset.f)));
    if (t === 'noUpdate' && rf.hours.value === '3') rf.hours.value = '6';
  };
  rf.type.onchange = showFields; showFields();
  rf.onsubmit = async e => {
    e.preventDefault();
    const d = { type: rf.type.value, person: rf.person.value, place: rf.place.value, time: rf.time.value, after: rf.after.value || undefined, below: rf.below.value, hours: rf.hours.value, days: DAYS.map((_, i) => rf['d' + i].checked ? i : -1).filter(i => i >= 0) };
    try { await api.post('/api/admin/rule', d); renderAdmin(); } catch (err) { $('.msg', rf).textContent = err.message; }
  };
  rb.append(rf);
  side.append(rb);

  // delivery
  const st = A.settings;
  side.append(el('<h2>Where alerts go</h2>'));
  const db = el(`<form class="box"><p class="small muted">Every alert shows in the Alerts list. Rule alerts are also pushed here. The webhook and token are kept on the server only and never shown again.</p>
    <label class="field">Discord webhook URL ${st.discordWebhookSet ? '<span class="pill ok">set</span>' : ''}<input name="discordWebhook" type="password" autocomplete="off" placeholder="${st.discordWebhookSet ? 'leave empty to keep' : 'https://discord.com/api/webhooks/...'}"></label>
    ${st.discordWebhookSet ? '<label class="check"><input type="checkbox" name="clearDiscord"> Remove the Discord webhook</label>' : ''}
    <div class="rowf"><label class="field">ntfy server<input name="ntfyServer" value="${esc(st.ntfyServer)}"></label><label class="field">ntfy topic<input name="ntfyTopic" value="${esc(st.ntfyTopic)}" placeholder="a long, hard-to-guess name"></label></div>
    <label class="field">ntfy access token (optional) ${st.ntfyTokenSet ? '<span class="pill ok">set</span>' : ''}<input name="ntfyToken" type="password" autocomplete="off" placeholder="${st.ntfyTokenSet ? 'leave empty to keep' : 'tk_...'}"></label>
    <div class="actions"><button class="accent">Save</button><button type="button" data-a="test">Send a test</button></div><div class="msg"></div></form>`);
  db.onsubmit = async e => {
    e.preventDefault();
    const d = { ntfyServer: db.ntfyServer.value, ntfyTopic: db.ntfyTopic.value };
    if (db.discordWebhook.value) d.discordWebhook = db.discordWebhook.value; else if (db.clearDiscord?.checked) d.discordWebhook = '';
    if (db.ntfyToken.value) d.ntfyToken = db.ntfyToken.value;
    try { await api.post('/api/admin/settings', d); renderAdmin(); } catch (err) { $('.msg', db).textContent = err.message; }
  };
  db.querySelector('[data-a=test]').onclick = async () => {
    const m = $('.msg', db); m.className = 'msg'; m.textContent = 'Sending...';
    try { const r = await api.post('/api/admin/test-push'); const f = (n, v) => v === null ? `${n}: not set up` : `${n}: ${v ? 'sent' : 'failed'}`; m.textContent = f('Discord', r.discord) + ' · ' + f('ntfy', r.ntfy); m.className = 'msg' + (r.discord !== false && r.ntfy !== false ? ' ok' : ''); } catch (err) { m.textContent = err.message; }
  };
  side.append(db);

  // settings
  side.append(el('<h2>Settings</h2>'));
  const sb = el(`<form class="box">
    <div class="rowf"><label class="field">Keep history (days)<input name="retentionDays" type="number" min="1" max="3650" value="${st.retentionDays}"></label><label class="field">Time zone<input name="timeZone" value="${esc(st.timeZone)}" placeholder="America/New_York"></label></div>
    <label class="field">Public address<input name="publicUrl" value="${esc(st.publicUrl)}" placeholder="https://places.example.com"></label>
    <label class="field">Map tiles URL<input name="tileUrl" value="${esc(st.tileUrl)}"></label>
    <div class="rowf"><label class="field">Tiles credit<input name="tileAttribution" value="${esc(st.tileAttribution)}"></label><label class="field">Max zoom<input name="maxZoom" type="number" min="1" max="22" value="${st.maxZoom}"></label></div>
    <label class="field">Credit link<input name="tileAttributionUrl" value="${esc(st.tileAttributionUrl)}"></label>
    <h2>Arrive / leave tuning</h2>
    <div class="rowf"><label class="field">Ignore fixes worse than (m)<input name="maxAccuracy" type="number" min="10" max="2000" value="${st.maxAccuracy}"></label><label class="field">Left after (min) outside<input name="leaveMinutes" type="number" min="1" max="60" value="${st.leaveMinutes}"></label></div>
    <div class="rowf"><label class="field">...or this far past the edge (m)<input name="leaveMeters" type="number" min="50" max="5000" value="${st.leaveMeters}"></label><label class="field">Same alert again after (min)<input name="cooldownMinutes" type="number" min="0" max="1440" value="${st.cooldownMinutes}"></label></div>
    <label class="check"><input type="checkbox" name="familyInOwnTracks" ${st.familyInOwnTracks ? 'checked' : ''}> Show the family in the OwnTracks app too</label>
    <div class="actions"><button class="accent">Save settings</button></div><div class="msg"></div></form>`);
  sb.onsubmit = async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(sb)); d.familyInOwnTracks = sb.familyInOwnTracks.checked;
    try { await api.post('/api/admin/settings', d); $('.msg', sb).className = 'msg ok'; $('.msg', sb).textContent = 'Saved'; await refresh(); } catch (err) { $('.msg', sb).className = 'msg'; $('.msg', sb).textContent = err.message; }
  };
  side.append(sb);

  const ab = el(`<form class="box"><b>Admin password</b><div class="rowf"><label class="field">Current<input type="password" name="old" autocomplete="current-password" required></label><label class="field">New (10+)<input type="password" name="password" minlength="10" autocomplete="new-password" required></label><button>Change</button></div><div class="msg"></div></form>`);
  ab.onsubmit = async e => { e.preventDefault(); try { await api.post('/api/admin/password', Object.fromEntries(new FormData(ab))); $('.msg', ab).className = 'msg ok'; $('.msg', ab).textContent = 'Changed'; ab.reset(); } catch (err) { $('.msg', ab).className = 'msg'; $('.msg', ab).textContent = err.message; } };
  side.append(ab);
  side.append(el(`<p class="small muted">Hallow Places ${esc(T.session.version)}. Paused people are hidden from everyone, including you.</p>`));
}

function personDialog(p) {
  dialog(`<h3>${p ? 'Edit ' + esc(p.name) : 'Add a person'}</h3><form>
    <div class="rowf"><label class="field">Name<input name="name" required maxlength="40" value="${esc(p?.name || '')}"></label><label class="field">Initials<input name="tid" maxlength="2" value="${esc(p?.tid || '')}"></label></div>
    ${p ? '' : '<label class="field">User name (for signing in; letters, digits, -)<input name="user" maxlength="24" autocapitalize="none" placeholder="from the name"></label>'}
    <div class="rowf"><label class="field">Colour<input name="color" type="color" value="${esc(p?.color || '#F07820')}"></label><label class="field">${p?.hasPassword ? 'New password (empty = keep)' : 'Password to sign in (optional)'}<input name="password" type="password" minlength="8" autocomplete="new-password"></label></div>
    <div class="rowf"><label class="field">Quiet hours from<input name="qf" type="time" value="${esc(p?.quiet?.from || '')}"></label><label class="field">to<input name="qt" type="time" value="${esc(p?.quiet?.to || '')}"></label></div>
    <label class="check"><input type="checkbox" name="encrypt" ${!p || p.encrypt ? 'checked' : ''}> Encrypt their phone's messages (recommended; needs a new phone setup when changed)</label>
    ${p?.hasPassword ? '<label class="check"><input type="checkbox" name="noLogin"> Remove their sign-in</label>' : ''}
    <div class="actions"><button class="accent">Save</button><button type="button" data-close>Cancel</button></div><div class="msg"></div>
    ${p ? `<h2>More</h2><div class="actions">${p.paused ? '' : '<button type="button" data-a="pause">Pause their sharing</button>'}<button type="button" class="danger" data-a="hist">Delete their history</button><button type="button" class="danger" data-a="del">Remove person</button></div>
      <p class="small muted">Only ${esc(p.name)} can resume sharing after a pause.</p>` : ''}
  </form>`, (o, close) => {
    const f = $('form', o);
    if (!p) f.color.value = ['#F07820', '#7A5CC0', '#2E9E6A', '#2F7FD8', '#D8436A', '#B8901E'][T.admin.people.length % 6];
    f.onsubmit = async e => {
      e.preventDefault();
      const d = { id: p?.id, name: f.name.value, tid: f.tid.value, color: f.color.value, encrypt: f.encrypt.checked, quiet: f.qf.value || f.qt.value ? { from: f.qf.value, to: f.qt.value } : null };
      if (!p) d.user = f.user.value;
      if (f.password.value) d.password = f.password.value;
      if (f.noLogin?.checked) d.noLogin = true;
      try { await api.post('/api/admin/person', d); close(); await refresh(); renderAdmin(); } catch (err) { $('.msg', o).textContent = err.message; }
    };
    o.querySelector('[data-a=pause]')?.addEventListener('click', async () => { await api.post('/api/admin/person/pause', { id: p.id }); close(); await refresh(); renderAdmin(); });
    o.querySelector('[data-a=hist]')?.addEventListener('click', async () => { if (await confirmBox(`Delete every saved position and alert of ${p.name}?`, 'Delete history')) { await api.post('/api/admin/person/history-delete', { id: p.id }); close(); await refresh(); renderAdmin(); } });
    o.querySelector('[data-a=del]')?.addEventListener('click', async () => { if (await confirmBox(`Remove ${p.name}, their phone access and all their history?`, 'Remove')) { await api.post('/api/admin/person/delete', { id: p.id }); close(); await refresh(); renderAdmin(); } });
  });
}

// ---- start
(async () => {
  try {
    T.session = await api.get('/api/session');
    if (!T.session.signedIn) return showLogin(T.session.needsSetup);
    await showApp();
    T.ready = true;
  } catch (e) {
    document.body.innerHTML = `<div class="page"><div class="card"><div class="brand"><img src="icon.svg" alt=""><span><b>HALLOW</b> PLACES</span></div><p>Can't reach the server: ${esc(e.message)}</p></div></div>`;
  }
})();
