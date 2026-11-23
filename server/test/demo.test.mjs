// Demo mode: the made-up family is generated deterministically, moves, causes the alerts it is meant to show, keeps
// the jitter protection honest, and never touches real data or pushes anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDemo, demoPosition, demoFix, DEMO_PEOPLE, DEMO_PLACES } from '../lib/demo.js';
import { distance } from '../lib/geo.js';
import { createServer } from '../server.js';

const NOW = Date.UTC(2026, 10, 16, 15, 0);   // a Monday afternoon

test('demo positions: deterministic, on the routes, walking at a walking pace', () => {
  const alex = DEMO_PEOPLE.find(p => p.name === 'Alex');
  assert.deepEqual(demoPosition(alex, 1000), demoPosition(alex, 1000));
  assert.deepEqual(demoFix(alex, 123456, 1), demoFix(alex, 123456, 1), 'the noise is seeded too');
  const home = DEMO_PLACES.find(p => p.name === 'Home'), school = DEMO_PLACES.find(p => p.name === 'School');
  const cycle = alex.plan.reduce((s, x) => s + x[2], 0);
  let atHome = 0, atSchool = 0, walking = 0, maxStep = 0, prev = null;
  for (let t = 0; t < cycle; t += 10) {
    const p = demoPosition(alex, t);
    if (distance(p.lat, p.lon, home.lat, home.lon) < 1) atHome++;
    if (distance(p.lat, p.lon, school.lat, school.lon) < 1) atSchool++;
    if (p.moving) { walking++; assert.ok(p.kmh >= 3 && p.kmh <= 25, `walking or cycling speed, got ${p.kmh} km/h`); }
    if (prev) maxStep = Math.max(maxStep, distance(prev.lat, prev.lon, p.lat, p.lon));
    prev = p;
  }
  assert.ok(atHome > 20 && atSchool > 30 && walking > 40, `${atHome} / ${atSchool} / ${walking}`);
  assert.ok(maxStep < 80, `no jumps (largest 10 s step ${Math.round(maxStep)} m)`);
});

test('demo places and people are made up and stay inside the park', () => {
  // the park: roughly 40.764-40.800 N, 73.949-73.982 W
  for (const p of DEMO_PLACES) assert.ok(p.lat > 40.765 && p.lat < 40.800 && p.lon > -73.982 && p.lon < -73.949, p.name);
  for (const d of DEMO_PEOPLE.filter(x => x.plan)) for (let t = 0; t < 3000; t += 15) {
    const p = demoPosition(d, t);
    assert.ok(p.lat > 40.765 && p.lat < 40.800 && p.lon > -73.982 && p.lon < -73.949, `${d.name} at ${t}`);
  }
  assert.ok(DEMO_PLACES.every(p => p.id.startsWith('demo-')) && DEMO_PEOPLE.every(p => p.id.startsWith('demo-')));
});

test('a fresh demo already has the alerts it is meant to show, and none of the jitter ones', () => {
  const d = createDemo({ now: () => NOW, liveMs: 0, timeZone: 'UTC' });
  const m = d.map();
  assert.deepEqual(m.people.map(p => p.name), ['Alex', 'Sam', 'Kit', 'Robin']);
  assert.ok(m.people.every(p => p.last && p.demo), 'everyone has a position');
  const kinds = new Set(d.feed().map(a => a.kind));
  for (const k of ['arrive', 'leave', 'battery', 'noUpdate']) assert.ok(kinds.has(k), `has a ${k} alert`);
  assert.ok(d.feed().some(a => a.text === 'No update from Robin for 3 hours (last seen 10:00, battery was at 6% - probably flat)'));
  assert.ok(d.feed().some(a => a.quiet && a.person === 'demo-kit'), "Kit's quiet hours show as 'not sent'");
  assert.ok(!d.feed().some(a => a.pushed), 'nothing is ever pushed in the demo');
  assert.ok(d.feed().some(a => a.wouldPush) && d.feed().every(a => a.demo), 'the feed says what a real rule would have sent');
  // ~5% of fixes are 300 m-accuracy outliers: they must not create extra arrive / leave pairs. Alex walks Home ->
  // School -> Home on a 24-minute loop (4 events): in two hours at most 5 loops, 20 events, alternating.
  const alex = d.feed().filter(a => a.person === 'demo-alex' && (a.kind === 'arrive' || a.kind === 'leave'));
  assert.ok(alex.length >= 16 && alex.length <= 20, `Alex: ${alex.length} arrive / leave`);
  for (let i = 1; i < alex.length; i++) assert.notEqual(alex[i].kind, alex[i - 1].kind, 'arrive and leave alternate');
  const chrono = [...alex].reverse();   // the feed is newest first
  for (let i = 1; i < chrono.length; i++) if (chrono[i - 1].kind === 'leave') assert.notEqual(chrono[i].place, chrono[i - 1].place, 'a "left" is never followed by "arrived" back at the same Place (jitter)');
  const tr = d.track('demo-alex');
  assert.ok(tr.points.length > 150 && tr.points.every(p => p[3] <= 200), 'track without the bad fixes');
});

test('the demo keeps moving: advancing the clock brings new fixes and alerts', () => {
  let now = NOW;
  const d = createDemo({ now: () => now, liveMs: 0, timeZone: 'UTC' });
  const before = d.map().people.find(p => p.name === 'Alex').last.tst, feedBefore = d.feed().length;
  for (let i = 0; i < 180; i++) { now += 10000; d.advance(now); }   // 30 minutes
  assert.ok(d.map().people.find(p => p.name === 'Alex').last.tst > before);
  assert.ok(d.feed().length > feedBefore);
  d.stop();
});

test('demo mode on the server: off by default, made-up data only, look-only demo sessions, real data untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-demo-'));
  let now = NOW;
  const app = createServer({ dataDir: dir, adminPassword: 'admin-password-123', log: false, now: () => now, tickMs: 3600000, demoLiveMs: 0 });
  const base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
  const call = async (method, p, { body, cookie } = {}) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Hallow': '1', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch { }
    return { status: r.status, json, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  try {
    assert.equal((await call('GET', '/api/session')).json.demo, false, 'off by default');
    assert.equal((await call('POST', '/api/demo')).status, 404);
    const admin = (await call('POST', '/api/login', { body: { user: 'admin', password: 'admin-password-123' } })).cookie;
    await call('POST', '/api/admin/person', { cookie: admin, body: { name: 'Mia', password: 'mia-password' } });
    await call('POST', '/api/admin/place', { cookie: admin, body: { name: 'Real home', lat: 12.3456, lon: -32.1, radius: 120 } });
    const configBefore = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
    assert.equal((await call('POST', '/api/admin/settings', { cookie: admin, body: { demo: true } })).status, 200);
    const s = (await call('GET', '/api/session')).json; assert.equal(s.demo, true);
    const demo = (await call('POST', '/api/demo')).cookie;
    assert.match(demo, /^hp_session=/);
    const m = (await call('GET', '/api/map', { cookie: demo })).json;
    assert.equal(m.demo, true);
    assert.deepEqual(m.people.map(p => p.name), ['Alex', 'Sam', 'Kit', 'Robin'], 'no real person');
    assert.ok(!m.places.some(p => p.name === 'Real home'));
    assert.ok(m.feed.length > 5);
    assert.ok((await call('GET', '/api/track?person=demo-sam', { cookie: demo })).json.points.length > 50);
    assert.equal((await call('GET', '/api/admin', { cookie: demo })).status, 403, 'a demo session is look-only');
    assert.equal((await call('GET', '/api/me', { cookie: demo })).status, 403);
    assert.equal((await call('GET', '/api/track?person=mia', { cookie: demo })).json.points.length, 0, 'real tracks are not reachable');
    // the real admin page still shows the real family, and nothing of the demo was written to disk
    const a = (await call('GET', '/api/admin', { cookie: admin })).json;
    assert.deepEqual(a.people.map(p => p.name), ['Mia']); assert.equal(a.demo.on, true);
    app.store.flush();
    assert.ok(!fs.readFileSync(path.join(dir, 'state.json'), 'utf8').includes('demo-'), 'state.json has no demo data');
    assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8').replace(/"demo": true/, '"demo": false'), configBefore);
    assert.ok(!fs.existsSync(path.join(dir, 'history', 'demo-alex')));
    // demo off: demo sessions end, the real map is back
    await call('POST', '/api/admin/settings', { cookie: admin, body: { demo: false } });
    assert.equal((await call('GET', '/api/map', { cookie: demo })).status, 401);
    const real = (await call('GET', '/api/map', { cookie: admin })).json;
    assert.equal(real.demo, undefined); assert.deepEqual(real.people.map(p => p.name), ['Mia']);
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('DEMO=1 in the environment turns it on (and only a real 1 / true does)', () => {
  const { config } = { config: null };
  return import('../server.js').then(({ config }) => {
    assert.equal(config({ DEMO: '1' }).demo, true);
    assert.equal(config({ DEMO: 'true' }).demo, true);
    assert.equal(config({}).demo, false);
    assert.equal(config({ DEMO: '0' }).demo, false);
  });
});
