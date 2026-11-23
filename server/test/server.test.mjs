// The server over real HTTP on 127.0.0.1 (in-process, with a test clock): phones, web sign-in, privacy, admin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';
import { encryptOwnTracks, decryptOwnTracks } from '../lib/secretbox.js';
import { HOME, offset } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let now = Date.UTC(2026, 10, 16, 8, 0);
let app, base, dir;

async function call(method, p, { body, cookie, auth, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (body !== undefined && !raw) { h['Content-Type'] = 'application/json'; }
  if (method === 'POST' && p.startsWith('/api/') && !('x-hallow' in headers)) h['X-Hallow'] = '1';
  if (cookie) h.Cookie = cookie;
  if (auth) h.Authorization = 'Basic ' + Buffer.from(auth).toString('base64');
  const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), redirect: 'manual' });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { }
  const set = r.headers.get('set-cookie');
  return { status: r.status, json, text, headers: r.headers, cookie: set ? set.split(';')[0] : null };
}
const login = async (user, password) => (await call('POST', '/api/login', { body: { user, password } })).cookie;

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-server-'));
  app = createServer({ dataDir: dir, adminPassword: 'admin-password-123', log: false, now: () => now, tickMs: 3600000 });
  base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
});
test.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let admin, mia, miaToken, leoToken;

test('health, static files and security headers', async () => {
  const h = await call('GET', '/healthz');
  assert.equal(h.json.ok, true); assert.equal(h.json.version, '1.1');
  const page = await call('GET', '/');
  assert.equal(page.status, 200); assert.match(page.text, /app\.js/);
  assert.match(page.headers.get('content-security-policy'), /img-src 'self' data:;/, 'OpenStreetMap and EOxCloudless come through the tile cache');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal((await call('GET', '/admin')).status, 200);
  assert.equal((await call('GET', '/../config.json')).status, 404);
  assert.equal((await call('GET', '/data/config.json')).status, 404);
});

test('web sign-in: wrong password refused, admin signs in, POSTs need the X-Hallow header', async () => {
  assert.equal((await call('GET', '/api/map')).status, 401);
  assert.equal((await call('POST', '/api/login', { body: { user: 'admin', password: 'nope' } })).status, 401);
  admin = await login('admin', 'admin-password-123');
  assert.match(admin, /^hp_session=/);
  const viaTunnel = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hallow': '1', 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ user: 'admin', password: 'admin-password-123' }) });
  assert.match(viaTunnel.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/, 'Secure behind the https tunnel');
  assert.doesNotMatch((await call('POST', '/api/login', { body: { user: 'admin', password: 'admin-password-123' } })).headers.get('set-cookie'), /Secure/, 'plain http on the LAN still works');
  const s = await call('GET', '/api/session', { cookie: admin });
  assert.equal(s.json.admin, true);
  assert.equal((await call('POST', '/api/admin/place', { cookie: admin, body: { name: 'Home' }, headers: { 'x-hallow': '0' } })).status, 403, 'no header = refused');
});

test('admin adds people and a Place; a person gets a sign-in', async () => {
  let r = await call('POST', '/api/admin/person', { cookie: admin, body: { name: 'Mia', password: 'mia-password', quiet: { from: '22:00', to: '07:00' } } });
  assert.equal(r.json.id, 'mia');
  r = await call('POST', '/api/admin/person', { cookie: admin, body: { name: 'Leo', user: 'leo', encrypt: false } });
  assert.equal(r.json.id, 'leo');
  assert.equal((await call('POST', '/api/admin/person', { cookie: admin, body: { name: 'Mia' } })).status, 400, 'user name taken');
  assert.equal((await call('POST', '/api/admin/person', { cookie: admin, body: { name: 'Admin' } })).status, 400, '"admin" is reserved');
  r = await call('POST', '/api/admin/place', { cookie: admin, body: { name: 'Home', lat: HOME.lat, lon: HOME.lon, radius: HOME.radius } });
  assert.equal(r.status, 200);
  assert.equal((await call('POST', '/api/admin/place', { cookie: admin, body: { name: 'X', lat: 95, lon: 0, radius: 100 } })).status, 400);
  mia = await login('mia', 'mia-password');
  assert.ok(mia);
  assert.equal((await call('GET', '/api/admin', { cookie: mia })).status, 403, 'not the admin');
  const a = await call('GET', '/api/admin', { cookie: admin });
  assert.equal(a.json.people.length, 2);
  assert.ok(!JSON.stringify(a.json).includes('passwordHash') && !JSON.stringify(a.json).includes('encryptionKey') && !JSON.stringify(a.json).includes('tokenHash'));
  assert.equal(a.json.rules.length, 4, 'default rules');
});

test('phone setup: QR, one-time .otrc link, token shown once and only its hash stored', async () => {
  const s = await call('POST', '/api/admin/person/phone', { cookie: admin, body: { id: 'mia' } });
  assert.equal(s.status, 200);
  miaToken = s.json.token;
  assert.match(s.json.qr, /^<svg /);
  assert.match(s.json.inline, /^owntracks:\/\/\/config\?inline=/);
  assert.equal(s.json.url, base + '/pub');
  assert.equal(s.json.encrypted, true);
  const otrcPath = new URL(s.json.otrc).pathname;
  const f = await call('GET', otrcPath);
  assert.equal(f.status, 200);
  assert.match(f.headers.get('content-disposition'), /attachment; filename="mia-phone\.otrc"/);
  assert.equal(f.json._type, 'configuration'); assert.equal(f.json.password, miaToken); assert.equal(f.json.mode, 3);
  assert.equal((await call('GET', otrcPath)).status, 410, 'one use only');
  const cfg = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  assert.ok(!cfg.includes(miaToken), 'the token itself is not stored');
  // Leo sets up his own phone after the admin gives him a sign-in
  await call('POST', '/api/admin/person', { cookie: admin, body: { id: 'leo', name: 'Leo', password: 'leo-password' } });
  const leo = await login('leo', 'leo-password');
  leoToken = (await call('POST', '/api/me/phone', { cookie: leo, body: {} })).json.token;
  assert.ok(leoToken && leoToken !== miaToken);
});

test('OwnTracks HTTP: wrong token 401, then rate limited; encrypted fixes are accepted, plain ones refused when encryption is on', async () => {
  const fix = { _type: 'location', lat: HOME.lat, lon: HOME.lon, tst: Math.floor(now / 1000), acc: 12, batt: 77, tid: 'MI' };
  assert.equal((await call('POST', '/pub', { raw: true, body: JSON.stringify(fix) })).status, 401);
  assert.equal((await call('POST', '/pub', { raw: true, body: JSON.stringify(fix), auth: 'mia:wrong' })).status, 401);
  assert.equal((await call('POST', '/pub', { raw: true, body: JSON.stringify(fix), auth: 'nobody:' + miaToken })).status, 401);
  assert.equal((await call('GET', '/pub', { auth: 'mia:' + miaToken })).status, 405);
  // plain while encryption is on: dropped (200, so the phone doesn't resend forever) and flagged for the admin
  let r = await call('POST', '/pub', { raw: true, body: JSON.stringify(fix), auth: 'mia:' + miaToken });
  assert.equal(r.status, 200); assert.deepEqual(r.json, []);
  let a = await call('GET', '/api/admin', { cookie: admin });
  assert.equal(a.json.people.find(p => p.id === 'mia').devices[0].plaintextRefused, true);
  assert.equal((await call('GET', '/api/map', { cookie: admin })).json.people.find(p => p.id === 'mia').last, undefined);
  // sealed with her key (from the .otrc): accepted; the reply is sealed too and carries the Places as regions
  const key = app.store.config.people.find(p => p.id === 'mia').encryptionKey;
  r = await call('POST', '/pub', { raw: true, body: JSON.stringify({ _type: 'encrypted', data: encryptOwnTracks(JSON.stringify(fix), key) }), auth: 'mia:' + miaToken });
  assert.equal(r.status, 200);
  const items = r.json.map(i => JSON.parse(decryptOwnTracks(i.data, key)));
  assert.ok(items.some(i => i._type === 'cmd' && i.action === 'setWaypoints' && i.waypoints.waypoints[0].desc === 'Home'));
  a = await call('GET', '/api/admin', { cookie: admin });
  assert.equal(a.json.people.find(p => p.id === 'mia').devices[0].plaintextRefused, false);
  const m = await call('GET', '/api/map', { cookie: admin });
  const p = m.json.people.find(x => x.id === 'mia');
  assert.equal(p.last.lat, HOME.lat); assert.equal(p.last.batt, 77);
  // Leo (no encryption): plain is fine; his reply shows Mia as an OwnTracks friend, and the Places once
  now += 60000;
  r = await call('POST', '/pub', { raw: true, body: JSON.stringify({ ...fix, ...offset(HOME.lat, HOME.lon, 900, 0), tst: Math.floor(now / 1000), tid: 'LE' }), auth: 'leo:' + leoToken });
  assert.ok(r.json.some(i => i._type === 'location' && i.tid === 'MI'));
  assert.ok(r.json.some(i => i._type === 'card' && i.name === 'Mia'));
  assert.ok(r.json.some(i => i._type === 'cmd'));
  r = await call('POST', '/pub', { raw: true, body: JSON.stringify({ ...fix, tst: Math.floor(now / 1000), tid: 'LE' }), auth: 'leo:' + leoToken });
  assert.ok(!r.json.some(i => i._type === 'cmd'), 'Places only sent again when they change');
  // garbage and other message types are accepted quietly
  for (const body of ['nope', '{"_type":"waypoints","waypoints":[]}', '{"_type":"lwt"}', '{"_type":"location","lat":999}'])
    assert.equal((await call('POST', '/pub', { raw: true, body, auth: 'leo:' + leoToken })).status, 200);
  // too many failures from one address: 429
  for (let i = 0; i < 30; i++) await call('POST', '/pub', { raw: true, body: '{}', auth: 'mia:bad' + i });
  assert.equal((await call('POST', '/pub', { raw: true, body: JSON.stringify(fix), auth: 'mia:' + miaToken })).status, 429);
  app.store.state.flags = app.store.state.flags || {};
});

test('history track and feed through the API', async () => {
  const t = await call('GET', '/api/track?person=mia', { cookie: mia });
  assert.equal(t.json.points.length, 1);
  assert.deepEqual(t.json.days, ['2026-11-16']);
  assert.ok(fs.existsSync(path.join(dir, 'history', 'mia', '2026-11-16.jsonl')));
});

test('status page: what is shared and with whom; pause hides her from everyone, even the admin; only she can resume', async () => {
  const me = await call('GET', '/api/me', { cookie: mia });
  assert.equal(me.json.paused, false);
  assert.ok(me.json.shared.length >= 5);
  assert.deepEqual(me.json.viewers, ['Leo']);
  assert.equal(me.json.encrypted, true);
  assert.deepEqual(me.json.quiet, { from: '22:00', to: '07:00' });
  assert.equal((await call('GET', '/api/me', { cookie: admin })).status, 400);
  await call('POST', '/api/me/pause', { cookie: mia, body: { paused: true } });
  for (const who of [admin, mia]) {
    const m = await call('GET', '/api/map', { cookie: who });
    const p = m.json.people.find(x => x.id === 'mia');
    assert.equal(p.paused, true); assert.equal(p.last, undefined); assert.equal(p.at, undefined);
    assert.equal((await call('GET', '/api/track?person=mia', { cookie: who })).json.points.length, 0);
  }
  // while paused, nothing the phone sends is kept
  const before = fs.readFileSync(path.join(dir, 'history', 'mia', '2026-11-16.jsonl'), 'utf8');
  // (the rate limit from the previous test is per address: start a fresh limiter window)
  now += 11 * 60000;
  const key = app.store.config.people.find(p => p.id === 'mia').encryptionKey;
  await call('POST', '/pub', { raw: true, body: JSON.stringify({ _type: 'encrypted', data: encryptOwnTracks(JSON.stringify({ _type: 'location', lat: 12.4, lon: -32.2, tst: Math.floor(now / 1000) }), key) }), auth: 'mia:' + miaToken });
  assert.equal(fs.readFileSync(path.join(dir, 'history', 'mia', '2026-11-16.jsonl'), 'utf8'), before);
  // the admin can pause but not resume
  assert.equal((await call('POST', '/api/admin/person/resume', { cookie: admin, body: { id: 'mia' } })).status, 404);
  await call('POST', '/api/me/pause', { cookie: mia, body: { paused: false } });
  assert.ok((await call('GET', '/api/map', { cookie: admin })).json.people.find(x => x.id === 'mia').last);
  await call('POST', '/api/admin/person/pause', { cookie: admin, body: { id: 'leo' } });
  assert.equal((await call('GET', '/api/map', { cookie: mia })).json.people.find(x => x.id === 'leo').paused, true);
});

test('delete my history: day files, last position and her alerts are gone', async () => {
  app.engine.emit('battery', { id: 'mia', name: 'Mia' }, { text: 'Mia test alert', push: false });
  assert.ok((await call('GET', '/api/feed', { cookie: admin })).json.feed.some(a => a.person === 'mia'));
  const r = await call('POST', '/api/me/delete-history', { cookie: mia });
  assert.equal(r.json.days, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'history', 'mia')));
  const m = await call('GET', '/api/map', { cookie: admin });
  assert.equal(m.json.people.find(x => x.id === 'mia').last, undefined);
  assert.ok(!m.json.feed.some(a => a.person === 'mia'));
  assert.ok(!fs.readFileSync(path.join(dir, 'state.json'), 'utf8').includes('"mia"'), 'state.json forgets her too');
});

test('settings: the webhook and ntfy token are write-only; bad values refused', async () => {
  let r = await call('POST', '/api/admin/settings', { cookie: admin, body: { discordWebhook: 'https://discord.com/api/webhooks/123/SECRETSECRET', ntfyTopic: 'family-alerts-x7', ntfyToken: 'tk_secret', retentionDays: 14, timeZone: 'America/New_York' } });
  assert.equal(r.status, 200);
  const a = await call('GET', '/api/admin', { cookie: admin });
  assert.ok(!JSON.stringify(a.json).includes('SECRETSECRET') && !JSON.stringify(a.json).includes('tk_secret'));
  assert.equal(a.json.settings.discordWebhookSet, true); assert.equal(a.json.settings.ntfyTokenSet, true);
  assert.equal(a.json.settings.retentionDays, 14);
  for (const bad of [{ tileUrl: 'https://x/{z}' }, { timeZone: 'Mars/Base' }, { retentionDays: 0 }, { ntfyTopic: 'a b' }, { discordWebhook: 'javascript:alert(1)' }, { publicUrl: 'ftp://x' }])
    assert.equal((await call('POST', '/api/admin/settings', { cookie: admin, body: bad })).status, 400, JSON.stringify(bad));
  r = await call('POST', '/api/admin/settings', { cookie: admin, body: { tileUrl: 'https://{s}.tiles.example.com/{z}/{x}/{y}.png' } });
  assert.equal(r.status, 200);
  assert.match((await call('GET', '/')).headers.get('content-security-policy'), /img-src 'self' data: https:\/\/\*\.tiles\.example\.com;/);
  await call('POST', '/api/admin/settings', { cookie: admin, body: { discordWebhook: '', ntfyTopic: '' } });
});

test('rules: validated; retention runs on the hourly sweep', async () => {
  const pl = (await call('GET', '/api/admin', { cookie: admin })).json.places[0].id;
  assert.equal((await call('POST', '/api/admin/rule', { cookie: admin, body: { type: 'notLeft', person: 'mia', place: pl, time: '07:30', days: [1, 2, 9] } })).status, 200);
  for (const bad of [{ type: 'teleport', person: '*' }, { type: 'battery', person: '*', below: 0 }, { type: 'notLeft', person: 'mia', place: pl, time: '7.30' }, { type: 'arrive', person: 'ghost', place: '*' }, { type: 'leave', person: '*', place: 'nowhere' }])
    assert.equal((await call('POST', '/api/admin/rule', { cookie: admin, body: bad })).status, 400, JSON.stringify(bad));
  const r = (await call('GET', '/api/admin', { cookie: admin })).json.rules.find(x => x.type === 'notLeft');
  assert.deepEqual(r.days, [1, 2]);
  app.store.appendFix('leo', '2026-10-01', { tst: 1, lat: 1, lon: 1 });
  app.store.appendFix('leo', '2026-11-10', { tst: 1, lat: 1, lon: 1 });
  app.sweep();
  assert.deepEqual(app.store.days('leo').filter(d => d < '2026-11-16'), ['2026-11-10'], '14 days kept');
});

test('sign-in rate limit, sign out, password change signs out other sessions', async () => {
  const other = await login('leo', 'leo-password');
  const r = await call('POST', '/api/me/password', { cookie: other, body: { old: 'leo-password', password: 'leo-password-2' } });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/me', { cookie: other })).status, 401, 'old session gone');
  assert.equal((await call('GET', '/api/me', { cookie: r.cookie })).status, 200, 'new one works');
  await call('POST', '/api/logout', { cookie: mia });
  assert.equal((await call('GET', '/api/map', { cookie: mia })).status, 401);
  for (let i = 0; i < 10; i++) await call('POST', '/api/login', { body: { user: 'mia', password: 'guess' + i } });
  assert.equal((await call('POST', '/api/login', { body: { user: 'mia', password: 'mia-password' } })).status, 429);
});

test('removing a person removes their phone access, history and rules', async () => {
  const r = await call('POST', '/api/admin/person/delete', { cookie: admin, body: { id: 'leo' } });
  assert.equal(r.status, 200);
  assert.ok(!fs.existsSync(path.join(dir, 'history', 'leo')));
  now += 11 * 60000;
  assert.equal((await call('POST', '/pub', { raw: true, body: '{}', auth: 'leo:' + leoToken })).status, 401);
});

test('first start without ADMIN_PASSWORD: node server.js prints a one-time setup code; the page asks for it', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-first-'));
  const port = 18500 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [path.join(HERE, '..', 'server.js')], { env: { ...process.env, DATA_DIR: d, PORT: String(port), HOST: '127.0.0.1', ADMIN_PASSWORD: '', TZ: 'Europe/Paris' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try {
    let out = '';
    child.stdout.on('data', c => { out += c; });
    for (let i = 0; i < 100 && !/ on 127\.0\.0\.1:/.test(out); i++) await new Promise(r => setTimeout(r, 100));
    const code = /setup code: (\d{8})/.exec(out)?.[1];
    assert.ok(code, 'setup code in the log');
    const u = `http://127.0.0.1:${port}`;
    const s = await (await fetch(u + '/api/session')).json();
    assert.equal(s.needsSetup, true);
    const post = body => fetch(u + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hallow': '1' }, body: JSON.stringify(body) });
    assert.equal((await post({ code: '00000000', password: 'long-enough-pw' })).status, 403);
    assert.equal((await post({ code, password: 'short' })).status, 400);
    const ok = await post({ code, password: 'long-enough-pw' });
    assert.equal(ok.status, 200); assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await post({ code, password: 'long-enough-pw' })).status, 409, 'only once');
    const cfg = JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8'));
    assert.equal(cfg.settings.timeZone, 'Europe/Paris', 'TZ from the environment on first start');
    assert.ok(!out.includes('long-enough-pw'));
  } finally { child.kill(); await new Promise(r => setTimeout(r, 300)); fs.rmSync(d, { recursive: true, force: true }); }
});
