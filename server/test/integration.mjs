// Integration run: the server on 127.0.0.1 with a test clock, a fake OwnTracks phone replaying a made-up day, local
// STAND-INS for Discord, ntfy and the map tiles (nothing leaves this computer), then the map page in headless Edge at
// phone and desktop sizes, light and dark. All places and positions are made up (in the open Atlantic).
//   node test/integration.mjs [output folder]
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { createServer } from '../server.js';
import { encryptOwnTracks, decryptOwnTracks } from '../lib/secretbox.js';
import { HOME, SCHOOL, PARK, offset, rng, stay, travel } from './helpers.mjs';

const OUT = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'out'));
fs.mkdirSync(OUT, { recursive: true });
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { }
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(f => fs.existsSync(f));
const results = [];
async function step(name, fn) {
  const t = Date.now();
  try { await fn(); results.push(`PASS ${name} (${Date.now() - t} ms)`); console.log('PASS', name); }
  catch (e) { results.push(`FAIL ${name}: ${e.stack || e}`); console.log('FAIL', name, '\n', e.stack || e); }
}

// ---- stand-ins
function standIn(handler) {
  const got = [];
  const s = http.createServer((req, res) => { const parts = []; req.on('data', c => parts.push(c)); req.on('end', () => { got.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(parts).toString() }); handler(req, res); }); });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r({ server: s, got, url: `http://127.0.0.1:${s.address().port}` })));
}
const discord = await standIn((req, res) => { res.writeHead(req.url === '/api/webhooks/1/standin-secret-token' ? 204 : 404); res.end(); });
const ntfy = await standIn((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"x"}'); });

// made-up map tiles drawn here: streets, main roads, parks and a lake, in OpenStreetMap-like colours
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const crc = buf => { let c, crcv = 0xffffffff; for (const b of buf) { c = (crcv ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcv = (crcv >>> 8) ^ c; } return (crcv ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const hash = (a, b) => { let x = Math.imul(a, 374761393) ^ Math.imul(b, 668265263); x = Math.imul(x ^ (x >>> 13), 1274126177); return (x ^ (x >>> 16)) >>> 0; };
function tile(z, tx, ty) {
  const rgb = Buffer.alloc(256 * 256 * 3), s = 2 ** (17 - z);
  const lake = { x: (PARK.lon + 180) / 360 * 2 ** 17 * 256 + 500, y: 0 };
  { const la = PARK.lat * Math.PI / 180; lake.y = (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * 2 ** 17 * 256 + 380; }
  for (let py = 0; py < 256; py++) for (let px = 0; px < 256; px++) {
    const X = (tx * 256 + px) * s, Y = (ty * 256 + py) * s;   // zoom-17 world pixels (about 1.2 m)
    let c = [237, 234, 226];
    const bx = Math.floor(X / 130), by = Math.floor(Y / 110);
    const hb = hash(bx, by);
    if (hb % 9 === 0) c = [205, 230, 192]; else if (hb % 13 === 1) c = [226, 220, 210];
    const lx = (X - lake.x) / 260, ly = (Y - lake.y) / 170;
    if (lx * lx + ly * ly < 1 + 0.15 * Math.sin(X / 90)) c = [170, 211, 223];
    else {
      const mx = X % 130, my = Y % 110, w = Math.max(3, 1.6 * s);
      if (z >= 13 && (mx < w || my < w)) c = [255, 255, 255];
      const MX = X % 1040, MY = (Y + 300) % 880, W = Math.max(7, 2.4 * s);
      if (MX < W || MY < W) c = [248, 214, 140];
    }
    rgb[(py * 256 + px) * 3] = c[0]; rgb[(py * 256 + px) * 3 + 1] = c[1]; rgb[(py * 256 + px) * 3 + 2] = c[2];
  }
  return png(256, 256, rgb);
}
const tileCache = new Map();
const tiles = await standIn((req, res) => {
  const m = /^\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(req.url);
  if (!m) { res.writeHead(404); return res.end(); }
  let b = tileCache.get(req.url); if (!b) { b = tile(+m[1], +m[2], +m[3]); tileCache.set(req.url, b); }
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' }); res.end(b);
});

// ---- the server, with a test clock and its log captured (to prove secrets never show up in it)
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-integ-'));
const DAY0 = Date.UTC(2026, 10, 16) / 1000;   // Monday
let now = (DAY0 + 6 * 3600) * 1000;
const logLines = [];
const realLog = console.log;
console.log = (...a) => { const s = a.join(' '); if (/^\d{4}-\d{2}-\d{2}T/.test(s)) logLines.push(s); else realLog(...a); };
const app = createServer({ dataDir: DATA, adminPassword: 'integration-admin-pw', now: () => now, tickMs: 3600000, log: true });
const BASE = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
console.log = (...a) => { const s = a.join(' '); if (/^\d{4}-\d{2}-\d{2}T/.test(s)) logLines.push(s); else realLog(...a); };

async function call(method, p, { body, cookie, auth, raw } = {}) {
  const h = {};
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  if (method === 'POST' && p.startsWith('/api/')) h['X-Hallow'] = '1';
  if (cookie) h.Cookie = cookie;
  if (auth) h.Authorization = 'Basic ' + Buffer.from(auth).toString('base64');
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { }
  const set = r.headers.get('set-cookie');
  return { status: r.status, json, text, cookie: set ? set.split(';')[0] : null };
}
const login = async (u, p) => (await call('POST', '/api/login', { body: { user: u, password: p } })).cookie;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const WEBHOOK = discord.url + '/api/webhooks/1/standin-secret-token';
let admin, phones = {}, places = {};
const WORK = { name: 'Work', lat: 12.3602, lon: -32.1182, radius: 200 };

await step('admin sets up the family, Places, rules and the stand-in alert channels', async () => {
  admin = await login('admin', 'integration-admin-pw');
  assert.ok(admin);
  for (const [name, color, extra] of [['Mia', '#F07820', { quiet: { from: '23:30', to: '06:00' } }], ['Leo', '#7A5CC0', {}], ['Ava', '#2E9E6A', {}], ['Sam', '#2F7FD8', {}]])
    assert.equal((await call('POST', '/api/admin/person', { cookie: admin, body: { name, color, password: name.toLowerCase() + '-password', ...extra } })).status, 200);
  for (const p of [HOME, SCHOOL, PARK, WORK]) places[p.name] = (await call('POST', '/api/admin/place', { cookie: admin, body: p })).json.id;
  const rules = [
    { type: 'notLeft', person: 'mia', place: places.Home, time: '07:30', days: [1, 2, 3, 4, 5] },
    { type: 'notArrived', person: 'mia', place: places.School, time: '08:30', days: [1, 2, 3, 4, 5] },
    { type: 'stationary', person: '*', hours: 3 },
  ];
  for (const r of rules) assert.equal((await call('POST', '/api/admin/rule', { cookie: admin, body: r })).status, 200);
  const s = await call('POST', '/api/admin/settings', { cookie: admin, body: { discordWebhook: WEBHOOK, ntfyServer: ntfy.url, ntfyTopic: 'hallow-family-standin', ntfyToken: 'tk_standin_secret', tileUrl: tiles.url + '/{z}/{x}/{y}.png', tileAttribution: 'Made-up test tiles', tileAttributionUrl: '', timeZone: 'UTC', publicUrl: BASE } });
  assert.equal(s.status, 200, s.text);
  const t = await call('POST', '/api/admin/test-push', { cookie: admin });
  assert.deepEqual(t.json, { discord: true, ntfy: true });
});

await step('phone setup: the QR / .otrc config is a valid OwnTracks HTTP-mode configuration', async () => {
  for (const id of ['mia', 'leo', 'ava', 'sam']) {
    const s = (await call('POST', '/api/admin/person/phone', { cookie: admin, body: { id } })).json;
    const cfg = JSON.parse(Buffer.from(decodeURIComponent(s.inline.split('inline=')[1]), 'base64').toString());
    assert.equal(cfg._type, 'configuration'); assert.equal(cfg.mode, 3); assert.equal(cfg.url, BASE + '/pub');
    assert.equal(cfg.username, id); assert.equal(cfg.password, s.token); assert.equal(typeof cfg.encryptionKey, 'string');
    const file = await call('GET', new URL(s.otrc).pathname);
    assert.deepEqual(file.json, cfg);
    assert.match(s.qr, /^<svg [\s\S]+<\/svg>$/);
    phones[id] = { token: s.token, key: cfg.encryptionKey };
  }
  fs.writeFileSync(path.join(OUT, 'setup-qr.svg'), (await call('POST', '/api/admin/person/phone', { cookie: admin, body: { id: 'sam', device: 'tablet', name: 'Tablet' } })).json.qr);
});

// the fake phone: seals each message with the person's key, like OwnTracks with an encryption key set
async function post(id, msg) {
  const r = await call('POST', '/pub', { raw: true, auth: `${id}:${phones[id].token}`, body: JSON.stringify({ _type: 'encrypted', data: encryptOwnTracks(JSON.stringify(msg), phones[id].key) }) });
  assert.equal(r.status, 200);
  return r.json.map(i => JSON.parse(decryptOwnTracks(i.data, phones[id].key)));
}
// play several people's messages in time order, ticking the server once per simulated minute
async function playDay(msgs, until) {
  msgs.sort((a, b) => a.m.tst - b.m.tst);
  let lastTick = Math.floor(now / 60000);
  for (const { id, m } of msgs) {
    while (lastTick < Math.floor(m.tst / 60)) { lastTick++; now = lastTick * 60000; app.tick(); }
    now = m.tst * 1000;
    await post(id, m);
  }
  while (lastTick < Math.floor(until / 60)) { lastTick++; now = lastTick * 60000; app.tick(); }
  await sleep(300);   // pushes are sent in the background
}

const miaDay = fs.readFileSync(new URL('./traces/day.jsonl', import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const r = rng(42), H = h => DAY0 + Math.round(h * 3600);
const leoDay = [...stay(r, H(6), H(8), 900, HOME, { sd: 12, batt: () => 88 }), ...travel(r, H(8), H(8.3), 60, HOME, WORK, { batt: () => 85 }), ...stay(r, H(8.35), H(23), 900, WORK, { sd: 20, batt: t => Math.round(84 - (t - H(8.35)) / 3600 * 3) })].map(m => ({ ...m, tid: 'LE' }));
const avaDay = [...stay(r, H(6), H(14), 1200, HOME, { sd: 12, batt: () => 40 }), ...travel(r, H(14), H(14.25), 60, HOME, PARK, { batt: () => 30 }), ...stay(r, H(14.3), H(23), 1200, offset(PARK.lat, PARK.lon, -20, 30), { sd: 10, batt: t => Math.max(9, Math.round(29 - (t - H(14.3)) / 3600 * 2.5)) })].map(m => ({ ...m, tid: 'AV' }));

await step("a day of fake OwnTracks posts: exactly the expected alerts, each once, to the stand-in Discord and ntfy", async () => {
  const before = discord.got.length;
  // Sam pauses sharing in the morning; his phone keeps sending
  const sam = await login('sam', 'sam-password');
  await call('POST', '/api/me/pause', { cookie: sam, body: { paused: true } });
  const samDay = stay(r, H(6), H(23), 1800, offset(HOME.lat, HOME.lon, 3000, 2000), { sd: 10, batt: () => 5 });
  await playDay([...miaDay.map(m => ({ id: 'mia', m })), ...leoDay.map(m => ({ id: 'leo', m })), ...avaDay.map(m => ({ id: 'ava', m })), ...samDay.map(m => ({ id: 'sam', m }))], H(23.2));
  const texts = discord.got.slice(before).map(g => JSON.parse(g.body).content);
  const mia = texts.filter(t => t.startsWith('Mia'));
  assert.deepEqual(mia, ["Mia hasn't left Home by 07:30", 'Mia left Home', 'Mia arrived at School', 'Mia left School', "Mia's phone battery is at 14%", 'Mia has been at an unknown place for 3 hours', 'Mia arrived at Home']);
  assert.ok(!texts.some(t => t.includes("hasn't arrived")), 'she reached School in time');
  assert.deepEqual(texts.filter(t => t.startsWith('Leo')), ['Leo left Home', 'Leo arrived at Work']);
  assert.deepEqual(texts.filter(t => t.startsWith('Ava')), ['Ava left Home', 'Ava arrived at Park', "Ava's phone battery is at 14%"]);
  assert.ok(!texts.some(t => t.includes('Sam')), 'nothing about a paused person');
  // ntfy got the same alerts, with a title, tags and the token
  const n = ntfy.got.slice(1).map(g => g.body);
  assert.deepEqual(n, texts);
  const g = ntfy.got.at(-1);
  assert.equal(g.url, '/hallow-family-standin'); assert.equal(g.headers.title, 'Hallow Places'); assert.equal(g.headers.authorization, 'Bearer tk_standin_secret'); assert.ok(g.headers.tags);
  for (const d of discord.got) { const j = JSON.parse(d.body); assert.equal(j.username, 'Hallow Places'); assert.deepEqual(j.allowed_mentions, { parse: [] }); }
  fs.writeFileSync(path.join(OUT, 'alerts.txt'), texts.join('\n') + '\n');
});

await step('map API: positions, Places, today\'s track and the feed; the paused person is hidden', async () => {
  const leo = await login('leo', 'leo-password');
  const m = (await call('GET', '/api/map', { cookie: leo })).json;
  const byId = Object.fromEntries(m.people.map(p => [p.id, p]));
  assert.equal(byId.mia.at, 'Home'); assert.equal(byId.leo.at, 'Work'); assert.equal(byId.ava.at, 'Park');
  assert.equal(byId.sam.paused, true); assert.equal(byId.sam.last, undefined);
  assert.equal(m.places.length, 4);
  assert.ok(m.feed.length >= 12);
  assert.ok(!m.feed.some(a => a.person === 'sam'));
  const t = (await call('GET', '/api/track?person=mia&date=2026-11-16', { cookie: leo })).json;
  assert.equal(t.points.length, miaDay.filter(x => !(x.acc > 200)).length, 'the 1.5 km cell-tower fix is left out of the drawn track');
  assert.ok(!fs.existsSync(path.join(DATA, 'history', 'sam')), 'nothing kept for a paused person');
  // the OwnTracks reply carries the family (not Sam) as friends
  const reply = await post('leo', { _type: 'location', lat: WORK.lat, lon: WORK.lon, tst: Math.floor(now / 1000), acc: 10 });
  const tids = reply.filter(i => i._type === 'location').map(i => i.tid).sort();
  assert.deepEqual(tids, ['AV', 'MI']);
});

await step('secrets never in the log, the state files or API answers', async () => {
  app.store.flush();   // state.json is normally written a second after a change
  const all = logLines.join('\n') + fs.readFileSync(path.join(DATA, 'state.json'), 'utf8');
  assert.ok(!all.includes('standin-secret-token') && !all.includes('tk_standin_secret'));
  for (const id in phones) assert.ok(!all.includes(phones[id].token) && !fs.readFileSync(path.join(DATA, 'config.json'), 'utf8').includes(phones[id].token));
  assert.ok(!/12\.3\d{3}|32\.\d{4}/.test(logLines.join('\n')), 'no coordinates in the log');
  const a = (await call('GET', '/api/admin', { cookie: admin })).text;
  assert.ok(!a.includes('standin-secret-token') && !a.includes('tk_standin_secret'));
  fs.writeFileSync(path.join(OUT, 'server-log.txt'), logLines.join('\n') + '\n');
});

// ---- headless Edge
async function cdp(port) {
  let list;
  for (let i = 0; i < 75 && !list; i++) { await sleep(200); try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { } }
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const wait = new Map(), events = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } else if (m.method) events.push(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
  return { send, evaluate, events, close: () => ws.close() };
}
async function until(fn, ms, what) { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch { } if (Date.now() > end) throw new Error('timed out: ' + what); await sleep(150); } }

if (!EDGE) results.push('SKIP headless Edge (not installed)');
else await step('the map page in headless Edge: phone and desktop, light and dark, me / admin / setup pages, no script or CSP errors', async () => {
  const prof = path.join(os.tmpdir(), 'hp-edge-' + Date.now());
  const port = 9500 + Math.floor(Math.random() * 400);
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  try { os.setPriority(edge.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { }
  const c = await cdp(port);
  try {
    await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Log.enable'); await c.send('Network.enable');
    const sess = { admin, mia: await login('mia', 'mia-password') };
    const shot = async name => { await sleep(500); const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(s.result.data, 'base64')); };
    const open = async (who, url, size, theme) => {
      await c.send('Network.clearBrowserCookies');
      await c.send('Network.setCookie', { name: 'hp_session', value: sess[who].split('=')[1], domain: '127.0.0.1', path: '/', httpOnly: true });
      await c.send('Emulation.setDeviceMetricsOverride', size === 'phone' ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } : { width: 1366, height: 860, deviceScaleFactor: 1, mobile: false });
      await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await c.send('Page.navigate', { url: BASE + url });
      await until(() => c.evaluate('!!(window.__places && window.__places.ready)'), 15000, 'app ready');
      await until(() => c.evaluate('[...document.querySelectorAll(".tmap-tiles img")].length > 0 && [...document.querySelectorAll(".tmap-tiles img")].every(i => i.complete)'), 15000, 'tiles');
    };
    for (const size of ['desktop', 'phone']) for (const theme of ['light', 'dark']) {
      await open('mia', '/', size, theme);
      assert.equal(await c.evaluate('document.documentElement.dataset.theme'), theme);
      assert.equal(await c.evaluate('document.querySelectorAll(".pin").length'), 3, 'Mia, Leo and Ava on the map (Sam paused)');
      assert.equal(await c.evaluate('document.querySelectorAll(".tmap-svg circle.place").length'), 4);
      await c.evaluate('document.querySelector(".person").click(); true');
      await until(() => c.evaluate('document.querySelectorAll(".tmap-svg polyline").length === 1'), 5000, 'track drawn');
      await until(() => c.evaluate('[...document.querySelectorAll(".tmap-tiles img")].every(i => i.complete)'), 15000, 'tiles after fit');
      await shot(`map-${size}-${theme}`);
    }
    await open('mia', '/me', 'phone', 'dark');
    await until(() => c.evaluate('!!document.querySelector("#pause")'), 5000, 'me page');
    assert.match(await c.evaluate('document.querySelector("#side").innerText'), /Who can see it[\s\S]*Leo[\s\S]*Ava/);
    await shot('me-phone-dark');
    await open('mia', '/me', 'desktop', 'light');
    await until(() => c.evaluate('!!document.querySelector("#setup")'), 5000, 'me page');
    await c.evaluate('document.querySelector("#setup").click(); true');
    await until(() => c.evaluate('!!document.querySelector(".dialog img.qr") && document.querySelector(".dialog img.qr").complete'), 5000, 'QR dialog');
    await shot('setup-qr-desktop-light');
    await open('admin', '/admin', 'desktop', 'dark');
    await until(() => c.evaluate('!!document.querySelector(".placeform")'), 5000, 'admin page');
    await shot('admin-desktop-dark');
    await open('admin', '/admin', 'phone', 'light');
    await until(() => c.evaluate('!!document.querySelector(".placeform")'), 5000, 'admin page');
    await shot('admin-phone-light');
    // sign-in page
    await c.send('Network.clearBrowserCookies');
    await c.send('Page.navigate', { url: BASE + '/' });
    await until(() => c.evaluate('!!document.querySelector("form input[name=user]")'), 5000, 'sign-in');
    await shot('signin-phone-light');
    const errors = c.events.filter(e => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && !/favicon|401/.test(e.params.entry.text + (e.params.entry.url || ''))));
    assert.deepEqual(errors.map(e => JSON.stringify(e.params).slice(0, 300)), [], 'no script errors or CSP violations');
  } finally {
    c.close();
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else edge.kill();
    await sleep(1500);
    try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* a locked temp file is left for Windows to clean */ }
  }
});

console.log = realLog;
await app.close();
for (const s of [discord, ntfy, tiles]) s.server.close();
fs.rmSync(DATA, { recursive: true, force: true });
fs.writeFileSync(path.join(OUT, 'integration.txt'), results.join('\n') + '\n');
console.log('\n' + results.join('\n'));
process.exit(results.some(x => x.startsWith('FAIL')) ? 1 : 0);
