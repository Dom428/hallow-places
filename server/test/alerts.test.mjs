import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, emptyState, inQuietHours, localTime } from '../lib/alerts.js';
import { SETTINGS_DEFAULTS } from '../lib/store.js';
import { offset, HOME, SCHOOL } from './helpers.mjs';

const DAY = Date.UTC(2026, 10, 16);   // Monday, 00:00 UTC
const at = (h, m = 0) => DAY + (h * 60 + m) * 60000;

function setup({ rules = [], quiet = null, places = [{ id: 'home', ...HOME, tst: 1 }, { id: 'school', ...SCHOOL, tst: 2 }], settings = {} } = {}) {
  let now = at(6);
  const sent = [];
  const C = { people: [{ id: 'mia', name: 'Mia', quiet }, { id: 'leo', name: 'Leo' }], places, rules, settings: { ...SETTINGS_DEFAULTS, timeZone: 'UTC', ...settings } };
  const e = createEngine({ state: emptyState(), cfg: () => C, now: () => now, deliver: a => sent.push(a) });
  const fix = (p, extra = {}, who = 'mia') => e.onFix(C.people.find(x => x.id === who), { tst: Math.floor(now / 1000), lat: p.lat, lon: p.lon, acc: 10, ...extra });
  const set = t => { now = t; };
  // advance minute by minute, ticking like the server
  const run = until => { while (now < until) { now += 60000; e.tick(); } };
  return { e, C, sent, fix, set, run, get now() { return now; } };
}
const far = offset(HOME.lat, HOME.lon, 2500, 0);

test('quiet hours (also over midnight) and local time in a time zone', () => {
  assert.equal(inQuietHours({ from: '22:00', to: '07:00' }, 23 * 60), true);
  assert.equal(inQuietHours({ from: '22:00', to: '07:00' }, 6 * 60 + 59), true);
  assert.equal(inQuietHours({ from: '22:00', to: '07:00' }, 7 * 60), false);
  assert.equal(inQuietHours({ from: '13:00', to: '14:00' }, 13 * 60 + 30), true);
  assert.equal(inQuietHours({ from: '13:00', to: '14:00' }, 12 * 60), false);
  assert.equal(inQuietHours(null, 0), false);
  assert.equal(inQuietHours({ from: '10:00', to: '10:00' }, 600), false);
  const lt = localTime(Date.UTC(2026, 10, 16, 3, 5), 'America/New_York');
  assert.deepEqual(lt, { date: '2026-11-15', hm: '22:05', minutes: 22 * 60 + 5, dow: 0 });
});

test('arrive / leave always reach the feed; pushes only when a rule asks', () => {
  const t = setup({ rules: [{ id: 'r1', type: 'leave', person: 'mia', place: 'home' }] });
  t.fix(HOME); t.set(at(6, 1)); t.fix(HOME);
  t.set(at(7)); t.fix(far);
  t.set(at(9)); t.fix(SCHOOL); t.set(at(9, 1)); t.fix(SCHOOL);
  const kinds = t.e.state.feed.map(a => `${a.kind}:${a.place}`).reverse();
  assert.deepEqual(kinds, ['leave:home', 'arrive:school']);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].text, 'Mia left Home');
  assert.equal(t.e.state.at.mia, 'school');
});

test('no repeats: the same alert within the cool-down is dropped', () => {
  const t = setup({ rules: [{ id: 'r1', type: 'arrive', person: '*', place: '*' }, { id: 'r2', type: 'leave', person: '*', place: '*' }], settings: { cooldownMinutes: 30 } });
  t.fix(HOME); t.set(at(6, 1)); t.fix(HOME);
  const bounce = [far, HOME, HOME, far, HOME, HOME];
  let m = 10;
  for (const p of bounce) { t.set(at(7, m)); t.fix(p); m += 2; }
  assert.deepEqual(t.sent.map(a => a.kind), ['leave', 'arrive'], 'second leave / arrive within 30 min dropped');
  t.set(at(9)); t.fix(far);
  assert.equal(t.sent.length, 3, 'after the cool-down it is sent again');
});

test('quiet hours: shown in the feed, not pushed', () => {
  const t = setup({ rules: [{ id: 'r1', type: 'leave', person: '*', place: '*' }], quiet: { from: '05:00', to: '07:30' } });
  t.fix(HOME); t.set(at(6, 1)); t.fix(HOME);
  t.set(at(6, 30)); t.fix(far);
  assert.equal(t.sent.length, 0);
  assert.equal(t.e.state.feed[0].quiet, true);
  assert.equal(t.e.state.feed[0].pushed, false);
  // Leo has no quiet hours
  t.fix(HOME, {}, 'leo'); t.set(at(6, 31)); t.fix(HOME, {}, 'leo'); t.set(at(6, 40)); t.fix(far, {}, 'leo');
  assert.equal(t.sent.length, 1); assert.equal(t.sent[0].person, 'leo');
});

test('battery: once under the line, again only after charging or 5 points above', () => {
  const t = setup({ rules: [{ id: 'b', type: 'battery', person: '*', below: 15 }] });
  const seq = [[40, 1], [16, 1], [14, 1], [12, 1], [10, 1], [16, 1], [13, 1], [13, 2], [12, 1], [21, 1], [9, 1]];
  for (const [batt, bs] of seq) { t.set(t.now + 600000); t.fix(far, { batt, bs }); }
  assert.deepEqual(t.sent.map(a => a.text), ["Mia's phone battery is at 14%", "Mia's phone battery is at 12%", "Mia's phone battery is at 9%"]);
});

test('no update for N hours: once, and again only after a new fix', () => {
  const t = setup({ rules: [{ id: 'n', type: 'noUpdate', person: 'mia', hours: 2 }] });
  t.fix(far);
  t.run(at(7, 59)); assert.equal(t.sent.length, 0);
  t.run(at(8, 1)); assert.equal(t.sent.length, 1);
  assert.match(t.sent[0].text, /No update from Mia for 2 hours \(last seen 06:00\)/);
  t.run(at(12)); assert.equal(t.sent.length, 1, 'not repeated');
  t.fix(far); t.run(at(14, 1)); assert.equal(t.sent.length, 2);
  assert.ok(!t.sent.some(a => a.person === 'leo'), 'Leo never sent anything: no alert');
});

test('stationary at an unknown place: once per stay, never at a Place', () => {
  const t = setup({ rules: [{ id: 's', type: 'stationary', person: '*', hours: 3 }] });
  const spot = offset(far.lat, far.lon, 0, 0);
  for (let m = 0; m <= 200; m += 10) { t.set(at(9, m)); t.fix(offset(spot.lat, spot.lon, (m % 30) - 15, 10), { acc: 20 }); t.e.tick(); }
  t.run(at(12, 30));
  assert.equal(t.sent.length, 1); assert.match(t.sent[0].text, /Mia has been at an unknown place for 3 hours/);
  t.run(at(15)); assert.equal(t.sent.length, 1);
  // a new stay somewhere else counts again; at Home it never does
  t.fix(offset(spot.lat, spot.lon, 1000, 0)); t.run(at(18, 5)); assert.equal(t.sent.length, 2);
  t.fix(HOME); t.set(t.now + 60000); t.fix(HOME); t.run(at(23, 30));
  assert.equal(t.sent.length, 2);
});

test("hasn't left by: fires once in the hour after the time, only if still there, only on the chosen days", () => {
  const t = setup({ rules: [{ id: 'l', type: 'notLeft', person: 'mia', place: 'home', time: '07:30', days: [1, 2, 3, 4, 5] }] });
  t.fix(HOME); t.set(at(6, 1)); t.fix(HOME);
  t.run(at(7, 29)); assert.equal(t.sent.length, 0);
  t.run(at(9)); assert.equal(t.sent.length, 1); assert.equal(t.sent[0].text, "Mia hasn't left Home by 07:30");
  // Tuesday: she left at 07:10 -> nothing
  t.set(at(24 + 7, 10)); t.fix(far); t.run(at(24 + 9)); assert.equal(t.sent.length, 1);
  // Saturday: not a chosen day
  t.set(at(5 * 24 + 6)); t.fix(HOME); t.set(t.now + 60000); t.fix(HOME); t.run(at(5 * 24 + 9)); assert.equal(t.sent.length, 1);
});

test("hasn't left by: a server started after the hour doesn't send a stale alert", () => {
  const t = setup({ rules: [{ id: 'l', type: 'notLeft', person: 'mia', place: 'home', time: '07:30', days: [] }] });
  t.set(at(9)); t.fix(HOME); t.set(at(9, 1)); t.fix(HOME); t.run(at(11));
  assert.equal(t.sent.length, 0);
});

test("hasn't arrived by: fires when not there and not arrived since, quiet when she made it", () => {
  const t = setup({ rules: [{ id: 'a', type: 'notArrived', person: 'mia', place: 'school', time: '08:30', days: [], after: '07:00' }] });
  t.fix(HOME); t.set(at(6, 1)); t.fix(HOME);
  t.run(at(8, 45)); assert.equal(t.sent.length, 1); assert.equal(t.sent[0].text, "Mia hasn't arrived at School by 08:30");
  // next day: arrives 08:10 then walks out to the shop before 08:30 -> she did arrive today: nothing
  t.set(at(24 + 7, 30)); t.fix(far);
  t.set(at(24 + 8, 10)); t.fix(SCHOOL); t.set(at(24 + 8, 11)); t.fix(SCHOOL);
  t.set(at(24 + 8, 20)); t.fix(far);
  t.run(at(24 + 9, 30)); assert.equal(t.sent.length, 1);
});

test('paused people are skipped by the time rules; forget() clears everything about a person', () => {
  const t = setup({ rules: [{ id: 'n', type: 'noUpdate', person: '*', hours: 1 }] });
  t.fix(far);
  t.C.people[0].paused = true;
  t.run(at(9)); assert.equal(t.sent.length, 0);
  t.C.people[0].paused = false;
  t.run(at(9, 2)); assert.equal(t.sent.length, 1);
  t.e.forget('mia');
  assert.equal(t.e.state.last.mia, undefined);
  assert.equal(t.e.state.feed.filter(a => a.person === 'mia').length, 0);
});
