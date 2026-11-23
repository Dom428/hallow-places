// Over HTTP: the /tiles route (signed-in only, from a local stand-in provider - nothing leaves the PC), the map styles
// in the map API, satellite keys (write-only), the CSP, and validation of the new settings, schedules and rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PROVIDERS, USER_AGENT } from '../lib/tiles.js';
import { createServer } from '../server.js';

test('server: /tiles only for signed-in viewers; keys write-only; CSP follows the source; new settings validated', async () => {
  const got = [];
  const stand = http.createServer((req, res) => { got.push({ url: req.url, ua: req.headers['user-agent'] }); res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=600' }); res.end('TILE' + req.url); });
  await new Promise(r => stand.listen(0, '127.0.0.1', r));
  const up = `http://127.0.0.1:${stand.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-tiles-srv-'));
  const app = createServer({ dataDir: dir, adminPassword: 'admin-password-123', log: false, tickMs: 3600000, providers: { osm: { ...PROVIDERS.osm, url: up + '/osm/{z}/{x}/{y}.png' }, eox: { ...PROVIDERS.eox, url: up + '/eox/{z}/{y}/{x}.jpg' }, eoxLabels: { ...PROVIDERS.eoxLabels, url: up + '/lab/{z}/{y}/{x}.png' } } });
  const base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
  const call = async (method, p, { body, cookie } = {}) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Hallow': '1', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await r.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString()); } catch { }
    return { status: r.status, json, text: buf.toString(), headers: r.headers, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  try {
    assert.equal((await call('GET', '/tiles/osm/3/1/2')).status, 401, 'not an open proxy');
    assert.equal(got.length, 0);
    const admin = (await call('POST', '/api/login', { body: { user: 'admin', password: 'admin-password-123' } })).cookie;
    const t = await call('GET', '/tiles/osm/3/1/2', { cookie: admin });
    assert.equal(t.status, 200); assert.equal(t.text, 'TILE/osm/3/1/2.png'); assert.equal(t.headers.get('content-type'), 'image/png');
    assert.match(t.headers.get('cache-control'), /^private, max-age=\d+$/);
    assert.equal(got[0].ua, USER_AGENT);
    await call('GET', '/tiles/osm/3/1/2', { cookie: admin }); assert.equal(got.length, 1, 'second time from the cache');
    assert.equal((await call('GET', '/tiles/eox/16/1/1', { cookie: admin })).status, 404, 'past native zoom');
    assert.equal((await call('GET', '/tiles/eox/4/3/5', { cookie: admin })).text, 'TILE/eox/4/5/3.jpg');
    assert.equal((await call('GET', '/tiles/..%2Fconfig.json/1/1/1', { cookie: admin })).status, 404);
    // the map API hands the browser the three styles with their credits
    const m = (await call('GET', '/api/map', { cookie: admin })).json.map;
    assert.equal(m.defaultStyle, 'street');
    assert.deepEqual(Object.keys(m.styles), ['street', 'satellite', 'hybrid']);
    assert.match(m.styles.satellite.layers[0].attribution, /EOxCloudless/);
    // a keyed source: refused without its key; the key is write-only and shows up only in the tile address
    assert.equal((await call('POST', '/api/admin/settings', { cookie: admin, body: { satellite: 'maptiler' } })).status, 400);
    assert.equal((await call('POST', '/api/admin/settings', { cookie: admin, body: { maptilerKey: 'FAKEKEY0123456789abc', satellite: 'maptiler', mapStyle: 'hybrid' } })).status, 200);
    const a = (await call('GET', '/api/admin', { cookie: admin })).json;
    assert.equal(a.settings.maptilerKeySet, true); assert.ok(!JSON.stringify(a).includes('FAKEKEY0123456789abc'), 'never sent back to the admin page');
    assert.ok(a.satellites.find(x => x.id === 'maptiler').help.length >= 3);
    const m2 = (await call('GET', '/api/map', { cookie: admin })).json.map;
    assert.equal(m2.defaultStyle, 'hybrid'); assert.match(m2.styles.hybrid.layers[0].url, /key=FAKEKEY0123456789abc$/);
    assert.match((await call('GET', '/')).headers.get('content-security-policy'), /img-src 'self' data: https:\/\/api\.maptiler\.com;/);
    assert.ok(fs.readFileSync(path.join(dir, 'config.json'), 'utf8').includes('FAKEKEY0123456789abc'), 'kept in config.json on the server, like the webhook');
    for (const bad of [{ satellite: 'google' }, { mapStyle: '3d' }, { holidays: '2026-13-45' }, { holidays: 'tomorrow' }, { exitFactor: 0.5 }, { arriveMinutes: 99 }, { tileCacheMB: 1 }])
      assert.equal((await call('POST', '/api/admin/settings', { cookie: admin, body: bad })).status, 400, JSON.stringify(bad));
    assert.equal((await call('POST', '/api/admin/settings', { cookie: admin, body: { holidays: '2026-12-25, 2026-12-24 2026-12-25', arriveMinutes: 2, exitFactor: 2, exitExtra: 80 } })).status, 200);
    const st = (await call('GET', '/api/admin', { cookie: admin })).json.settings;
    assert.deepEqual(st.holidays, ['2026-12-24', '2026-12-25']); assert.equal(st.arriveMinutes, 2); assert.equal(st.exitFactor, 2);
    // quiet-hour days, rule schedules, urgent and the critical battery line are validated and kept
    await call('POST', '/api/admin/person', { cookie: admin, body: { name: 'Mia', quiet: { from: '22:00', to: '07:00', days: [0, 1, 2, 3, 4, 9] } } });
    assert.deepEqual((await call('GET', '/api/admin', { cookie: admin })).json.people[0].quiet, { from: '22:00', to: '07:00', days: [0, 1, 2, 3, 4] });
    const pl = (await call('POST', '/api/admin/place', { cookie: admin, body: { name: 'School', lat: 12.3561, lon: -32.0851, radius: 150 } })).json.id;
    assert.equal((await call('POST', '/api/admin/rule', { cookie: admin, body: { type: 'arrive', person: 'mia', place: pl, days: [1, 2, 3, 4, 5], from: '07:00', to: '09:30', skipHolidays: true, urgent: true } })).status, 200);
    assert.equal((await call('POST', '/api/admin/rule', { cookie: admin, body: { type: 'battery', person: 'mia', below: 20, critical: 5 } })).status, 200);
    for (const bad of [{ type: 'arrive', person: 'mia', place: pl, from: '7am' }, { type: 'battery', person: 'mia', below: 20, critical: 30 }])
      assert.equal((await call('POST', '/api/admin/rule', { cookie: admin, body: bad })).status, 400, JSON.stringify(bad));
    const rules = (await call('GET', '/api/admin', { cookie: admin })).json.rules;
    const r = rules.find(x => x.type === 'arrive' && x.person === 'mia');
    assert.deepEqual([r.days, r.from, r.to, r.skipHolidays, r.urgent], [[1, 2, 3, 4, 5], '07:00', '09:30', true, true]);
    assert.equal(rules.find(x => x.type === 'battery' && x.person === 'mia').critical, 5);
  } finally { await app.close(); stand.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
