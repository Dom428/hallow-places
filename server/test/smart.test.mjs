// 1.1's smarter alerts: GPS-jitter protection (dwell time, hysteresis radius, low-accuracy fixes), battery (with a
// critical second line), "hasn't updated in N hours", quiet hours on chosen days, urgent rules and per-place schedules
// ("only on school days"). Made-up places in the open Atlantic (helpers.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { geoStep, geoTick, newGeoState, exitRadius } from '../lib/geo.js';
import { createEngine, emptyState, inQuietHours, scheduleAllows, localTime } from '../lib/alerts.js';
import { SETTINGS_DEFAULTS } from '../lib/store.js';
import { offset, rng, HOME, SCHOOL } from './helpers.mjs';

const T0 = Date.UTC(2026, 10, 16) / 1000;   // Monday 00:00 UTC
const fixAt = (t, p, acc = 10, extra = {}) => ({ tst: t, lat: p.lat, lon: p.lon, acc, ...extra });
const far = offset(HOME.lat, HOME.lon, 2500, 0);

// run a list of fixes through geoStep (+ geoTick every minute in between) and collect the events
function replay(fixes, place, opts, { tickTo, ticks = true } = {}) {
  let s = newGeoState(), events = [], last = fixes[0].tst;
  const tickUntil = t => { if (!ticks) return; for (let m = Math.floor(last / 60) + 1; m * 60 < t; m++) { const r = geoTick(s, m * 60, opts); s = r.state; if (r.event) events.push([r.event, m * 60, r.reason]); } };
  for (const f of fixes) { tickUntil(f.tst); last = f.tst; const r = geoStep(s, f, place, opts); s = r.state; if (r.event) events.push([r.event, f.tst, r.reason]); }
  if (tickTo) tickUntil(tickTo);
  return { events, state: s };
}

test('dwell: a drive-by through a Place never counts as arrived', () => {
  const opts = { arriveMinutes: 2 };
  // settled outside, then 3 fixes inside over 90 s (a car passing through), then far again
  const fixes = [fixAt(T0, far), fixAt(T0 + 60, far), fixAt(T0 + 600, HOME), fixAt(T0 + 630, HOME), fixAt(T0 + 690, HOME), fixAt(T0 + 720, far), fixAt(T0 + 900, far)];
  assert.deepEqual(replay(fixes, HOME, opts, { tickTo: T0 + 3600 }).events, []);
});

test('dwell: staying inside is confirmed by the next fix or, with a silent phone, by the minute tick', () => {
  const opts = { arriveMinutes: 2 };
  const byFix = replay([fixAt(T0, far), fixAt(T0 + 60, far), fixAt(T0 + 600, HOME), fixAt(T0 + 660, HOME), fixAt(T0 + 730, HOME)], HOME, opts, { ticks: false });
  assert.deepEqual(byFix.events.map(e => [e[0], e[1] - T0]), [['arrive', 730]], 'the fix 2 min 10 s after the first one inside');
  // one stable fix, then the phone goes quiet (OwnTracks sends little when standing still): the tick confirms it
  const byTick = replay([fixAt(T0, far), fixAt(T0 + 60, far), fixAt(T0 + 600, HOME, 8)], HOME, opts, { tickTo: T0 + 1200 });
  assert.deepEqual(byTick.events.map(e => [e[0], e[1] - T0, e[2]]), [['arrive', 720, 'stable-fix']]);
  // a shaky single fix inside is not evidence enough, even after the dwell
  const shaky = replay([fixAt(T0, far), fixAt(T0 + 60, far), fixAt(T0 + 600, offset(HOME.lat, HOME.lon, 90, 0), 40)], HOME, opts, { tickTo: T0 + 3600 });
  assert.deepEqual(shaky.events, []);
});

test('dwell: a fix outside during the dwell starts it over', () => {
  const opts = { arriveMinutes: 3 };
  const fixes = [fixAt(T0, far), fixAt(T0 + 60, far), fixAt(T0 + 600, HOME), fixAt(T0 + 660, HOME), fixAt(T0 + 720, far), fixAt(T0 + 780, HOME), fixAt(T0 + 840, HOME), fixAt(T0 + 900, HOME), fixAt(T0 + 970, HOME)];
  assert.deepEqual(replay(fixes, HOME, opts, { ticks: false }).events.map(e => e[1] - T0), [970], 'the first fix 3 min after 780, not after 600');
  assert.deepEqual(replay(fixes, HOME, opts).events.map(e => e[1] - T0), [960], 'or the minute tick at 780 + 3 min');
});

test('hysteresis radius: configurable exit circle; jitter in the band never leaves', () => {
  assert.equal(exitRadius({ radius: 100 }), 150);
  assert.equal(exitRadius({ radius: 100 }, { exitFactor: 2, exitExtra: 50 }), 200);
  assert.equal(exitRadius({ radius: 300 }, { exitFactor: 1.2, exitExtra: 100 }), 400);
  const r = rng(11);
  for (const [factor, extra] of [[1.5, 50], [2, 80], [1.2, 30]]) {
    const exitR = Math.max(HOME.radius * factor, HOME.radius + extra);
    const fixes = [fixAt(T0, HOME), fixAt(T0 + 60, HOME)];
    // 6 hours of fixes scattered between the radius and just inside the exit circle, accuracy 5-20 m
    for (let t = T0 + 120; t < T0 + 6 * 3600; t += 120) {
      const d = HOME.radius + 5 + r() * (exitR - HOME.radius - 30), a = r() * 2 * Math.PI;
      fixes.push(fixAt(t, offset(HOME.lat, HOME.lon, d * Math.cos(a), d * Math.sin(a)), 5 + Math.round(r() * 15)));
    }
    assert.deepEqual(replay(fixes, HOME, { exitFactor: factor, exitExtra: extra, arriveMinutes: 1 }).events, [], `factor ${factor}, +${extra} m`);
  }
  // a wider exit circle: a fix 200 m past the edge is still "home" with factor 3 (360 m), but "left" with the default
  const out200 = offset(HOME.lat, HOME.lon, HOME.radius + 200, 0);
  const walk = [fixAt(T0, HOME), fixAt(T0 + 60, HOME), fixAt(T0 + 600, out200), fixAt(T0 + 700, out200), fixAt(T0 + 900, out200)];
  assert.equal(replay(walk, HOME, {}).events.length, 1);
  assert.equal(replay(walk, HOME, { exitFactor: 3 }).events.length, 0);
});

test('low-accuracy fixes are ignored, however far off they are', () => {
  const opts = { maxAccuracy: 100, arriveMinutes: 1 };
  const fixes = [fixAt(T0, HOME), fixAt(T0 + 60, HOME)];
  for (let i = 1; i <= 30; i++) fixes.push(fixAt(T0 + 60 + i * 300, offset(HOME.lat, HOME.lon, 2000 * Math.sin(i), 2000 * Math.cos(i)), 150 + i * 40));
  const { events, state } = replay(fixes, HOME, opts, { tickTo: T0 + 4 * 3600 });
  assert.deepEqual(events, []); assert.equal(state.status, 'inside');
  // the engine uses the admin's limit: with 1000 m allowed, the same far fixes do count
  const loose = replay(fixes.slice(0, 5), HOME, { maxAccuracy: 1000, arriveMinutes: 1 }, { tickTo: T0 + 3600 });
  assert.ok(loose.events.some(e => e[0] === 'leave'));
});

// ---- the engine
const DAY = Date.UTC(2026, 10, 16);   // Monday
const at = (d, h, m = 0) => DAY + ((d * 24 + h) * 60 + m) * 60000;
function setup({ rules = [], quiet = null, settings = {} } = {}) {
  let now = at(0, 6);
  const sent = [];
  const C = { people: [{ id: 'mia', name: 'Mia', quiet }, { id: 'leo', name: 'Leo' }], places: [{ id: 'home', ...HOME, tst: 1 }, { id: 'school', ...SCHOOL, tst: 2 }], rules, settings: { ...SETTINGS_DEFAULTS, timeZone: 'UTC', ...settings } };
  const e = createEngine({ state: emptyState(), cfg: () => C, now: () => now, deliver: a => sent.push(a) });
  const fix = (p, extra = {}, who = 'mia') => e.onFix(C.people.find(x => x.id === who), { tst: Math.floor(now / 1000), lat: p.lat, lon: p.lon, acc: 10, ...extra });
  const run = until => { while (now < until) { now += 60000; e.tick(); } };
  return { e, C, sent, fix, run, set: t => { now = t; }, get now() { return now; } };
}
// Mia goes from Home to School and back on day d
function schoolTrip(t, d) {
  t.set(at(d, 7)); t.fix(HOME); t.set(at(d, 7, 1)); t.fix(HOME); t.run(at(d, 7, 3));
  t.set(at(d, 7, 30)); t.fix(far); t.set(at(d, 7, 40)); t.fix(far); t.run(at(d, 7, 45));
  t.set(at(d, 8)); t.fix(SCHOOL); t.set(at(d, 8, 2)); t.fix(SCHOOL); t.run(at(d, 8, 5));
}

test('battery per person: once under the line, once more under the critical line, reset by charging', () => {
  const t = setup({ rules: [{ id: 'b', type: 'battery', person: 'mia', below: 20, critical: 8 }] });
  const seq = [[30, 1], [19, 1], [15, 1], [9, 1], [7, 1], [5, 1], [6, 2], [40, 2], [18, 1], [6, 1]];
  for (const [batt, bs] of seq) { t.set(t.now + 600000); t.fix(far, { batt, bs }); t.fix(far, { batt: 3, bs: 1 }, 'leo'); }
  assert.deepEqual(t.sent.map(a => a.text), ["Mia's phone battery is at 19%", "Mia's phone battery is critically low (7%)", "Mia's phone battery is at 18%", "Mia's phone battery is critically low (6%)"]);
  assert.ok(!t.sent.some(a => a.person === 'leo'), 'the rule is for Mia only');
  // dropping straight past both lines sends just one alert
  const t2 = setup({ rules: [{ id: 'b', type: 'battery', person: '*', below: 20, critical: 8 }] });
  t2.fix(far, { batt: 50, bs: 1 }); t2.set(t2.now + 600000); t2.fix(far, { batt: 4, bs: 1 }); t2.set(t2.now + 600000); t2.fix(far, { batt: 3, bs: 1 });
  assert.deepEqual(t2.sent.map(a => a.text), ["Mia's phone battery is at 4%"]);
});

test("hasn't updated in N hours: says why it may be, once, and the feed notes when the phone is back", () => {
  const t = setup({ rules: [{ id: 'n', type: 'noUpdate', person: '*', hours: 3 }] });
  t.fix(far, { batt: 6, bs: 1 }); t.fix(far, { batt: 70, bs: 1 }, 'leo');
  t.run(at(0, 9, 1));
  assert.deepEqual(t.sent.map(a => a.text), ['No update from Mia for 3 hours (last seen 06:00, battery was at 6% - probably flat)', 'No update from Leo for 3 hours (last seen 06:00, battery was at 70% - phone off or OwnTracks closed?)']);
  t.run(at(0, 15)); assert.equal(t.sent.length, 2, 'not repeated');
  t.fix(far, { batt: 40, bs: 2 });
  assert.equal(t.e.state.feed[0].kind, 'back'); assert.equal(t.e.state.feed[0].text, "Mia's phone is sending updates again"); assert.equal(t.e.state.feed[0].pushed, false);
  assert.equal(t.sent.length, 2, '"back" is feed-only');
  t.set(at(0, 15, 30)); t.fix(far, { batt: 41, bs: 2 });
  assert.equal(t.e.state.feed.filter(a => a.kind === 'back').length, 1, 'only after an alert went out');
});

test('quiet hours on chosen days, over midnight; urgent rules still push', () => {
  const q = { from: '22:00', to: '07:00', days: [0, 1, 2, 3, 4] };   // school nights: Sun-Thu evenings
  assert.equal(inQuietHours(q, 23 * 60, 1), true, 'Monday 23:00');
  assert.equal(inQuietHours(q, 6 * 60, 2), true, 'Tuesday 06:00 belongs to Monday night');
  assert.equal(inQuietHours(q, 23 * 60, 5), false, 'Friday night is not quiet');
  assert.equal(inQuietHours(q, 6 * 60, 6), false, 'early Saturday belongs to Friday night');
  assert.equal(inQuietHours(q, 6 * 60, 5), true, 'early Friday belongs to Thursday night');
  assert.equal(inQuietHours({ from: '13:00', to: '14:00', days: [6] }, 13 * 60 + 5, 6), true);
  assert.equal(inQuietHours({ from: '13:00', to: '14:00', days: [6] }, 13 * 60 + 5, 0), false);
  assert.equal(inQuietHours({ from: '13:00', to: '14:00' }, 13 * 60 + 5), true, 'no days = every day (1.0 behaviour)');
  const t = setup({ quiet: { from: '06:00', to: '09:00' }, rules: [{ id: 'l', type: 'leave', person: '*', place: 'home' }, { id: 'a', type: 'arrive', person: '*', place: 'school', urgent: true }] });
  schoolTrip(t, 0);
  const left = t.e.state.feed.find(a => a.kind === 'leave'), arrived = t.e.state.feed.find(a => a.kind === 'arrive' && a.place === 'school');
  assert.equal(left.quiet, true); assert.equal(left.pushed, false);
  assert.equal(arrived.pushed, true, 'urgent goes through quiet hours');
  assert.deepEqual(t.sent.map(a => a.text), ['Mia arrived at School']);
});

test('per-place schedules: "only on school days" (Mon-Fri, not on holidays) and a time window', () => {
  const lt = (d, h) => localTime(at(d, h), 'UTC');
  const school = { days: [1, 2, 3, 4, 5], skipHolidays: true };
  assert.equal(scheduleAllows(school, lt(0, 8), []), true, 'Monday');
  assert.equal(scheduleAllows(school, lt(5, 8), []), false, 'Saturday');
  assert.equal(scheduleAllows(school, lt(1, 8), ['2026-11-17']), false, 'Tuesday, a holiday');
  assert.equal(scheduleAllows({ from: '07:00', to: '09:30' }, lt(0, 8), []), true);
  assert.equal(scheduleAllows({ from: '07:00', to: '09:30' }, lt(0, 10), []), false);
  assert.equal(scheduleAllows({ from: '22:00', to: '06:00' }, lt(0, 23), []), true, 'window over midnight');
  assert.equal(scheduleAllows({ from: '22:00', to: '06:00' }, lt(0, 12), []), false);
  assert.equal(scheduleAllows({}, lt(6, 3), []), true, 'no schedule = always');

  const t = setup({ settings: { holidays: ['2026-11-18'] }, rules: [{ id: 'a', type: 'arrive', person: 'mia', place: 'school', days: [1, 2, 3, 4, 5], skipHolidays: true, from: '07:00', to: '09:30' }] });
  for (let d = 0; d < 7; d++) schoolTrip(t, d);   // Monday to Sunday, the same trip each day
  assert.deepEqual(t.sent.map(a => new Date(a.ts).toISOString().slice(0, 10)), ['2026-11-16', '2026-11-17', '2026-11-19', '2026-11-20'], 'not Wednesday (holiday), not the weekend');
  assert.equal(t.e.state.feed.filter(a => a.kind === 'arrive' && a.place === 'school').length, 7, 'the feed still shows every arrival');
  // outside the window: the same arrival at 11:00 isn't pushed
  const t2 = setup({ rules: [{ id: 'a', type: 'arrive', person: 'mia', place: 'school', from: '07:00', to: '09:30' }] });
  t2.set(at(0, 10, 50)); t2.fix(far); t2.set(at(0, 10, 55)); t2.fix(far);
  t2.set(at(0, 11)); t2.fix(SCHOOL); t2.set(at(0, 11, 2)); t2.fix(SCHOOL);
  assert.equal(t2.sent.length, 0); assert.equal(t2.e.state.feed[0].kind, 'arrive');
});

test("hasn't left / hasn't arrived by honour holidays too", () => {
  const t = setup({ settings: { holidays: ['2026-11-16'] }, rules: [{ id: 'l', type: 'notLeft', person: 'mia', place: 'home', time: '07:30', days: [1, 2, 3, 4, 5], skipHolidays: true }] });
  t.fix(HOME); t.set(at(0, 6, 1)); t.fix(HOME);
  t.run(at(0, 9)); assert.equal(t.sent.length, 0, 'Monday is a holiday');
  t.set(at(1, 6)); t.fix(HOME); t.run(at(1, 9)); assert.equal(t.sent.length, 1, 'Tuesday is not');
});

test('the engine passes the admin tuning (dwell, exit circle) to the geofence', () => {
  const t = setup({ settings: { arriveMinutes: 5 }, rules: [{ id: 'a', type: 'arrive', person: '*', place: '*' }] });
  t.fix(far); t.set(at(0, 6, 1)); t.fix(far);
  t.set(at(0, 7)); t.fix(SCHOOL); t.set(at(0, 7, 1)); t.fix(SCHOOL);
  assert.equal(t.sent.length, 0, 'two fixes, but only one minute of the five');
  t.run(at(0, 7, 4)); assert.equal(t.sent.length, 0);
  t.run(at(0, 7, 6)); assert.equal(t.sent.length, 1, 'the tick confirms after five minutes');
  assert.equal(t.e.state.at.mia, 'school');
});

test('a fix too inaccurate for the geofences does not move the pin while a good one is recent', () => {
  const t = setup();
  t.fix(HOME, { batt: 50 });
  t.set(at(0, 6, 5)); t.fix(far, { acc: 900, batt: 49 });
  let last = t.e.state.last.mia;
  assert.deepEqual([last.lat, last.lon, last.acc, last.batt, last.held], [HOME.lat, HOME.lon, 10, 49, true], 'position held, battery and time updated');
  assert.equal(last.tst, Math.floor(at(0, 6, 5) / 1000));
  t.set(at(0, 6, 12)); t.fix(far, { acc: 900, batt: 48 });
  assert.equal(t.e.state.last.mia.lat, HOME.lat, 'still held at 12 minutes');
  t.set(at(0, 6, 16)); t.fix(far, { acc: 900, batt: 47 });
  last = t.e.state.last.mia;
  assert.equal(last.lat, far.lat, '15 minutes after the last good fix the coarse one is shown, however often coarse fixes come');
  assert.equal(last.held, undefined);
});
