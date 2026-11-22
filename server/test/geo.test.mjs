import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { geoStep, geoTick, distance, exitRadius, newGeoState } from '../lib/geo.js';
import { rng, offset, HOME, SCHOOL, stay, travel, loc } from './helpers.mjs';

const T0 = 1763280000;   // a made-up day
const OPTS = { maxAccuracy: 100, leaveMinutes: 3, leaveMeters: 300 };

// play fixes through one Place, ticking every minute in between like the server does; returns the events
function play(fixes, place, opts = OPTS, start = newGeoState()) {
  let s = start; const events = [];
  let lastTick = fixes.length ? fixes[0].tst : 0;
  for (const f of fixes) {
    for (let t = lastTick + 60; t < f.tst; t += 60) { const r = geoTick(s, t, opts); s = r.state; if (r.event) events.push({ t, event: r.event, reason: r.reason }); }
    lastTick = Math.max(lastTick, f.tst);
    const r = geoStep(s, f, place, opts); s = r.state;
    if (r.event) events.push({ t: f.tst, event: r.event, reason: r.reason });
  }
  return { events, state: s };
}

test('distance and exit radius', () => {
  const p = offset(HOME.lat, HOME.lon, 300, 400);
  assert.ok(Math.abs(distance(HOME.lat, HOME.lon, p.lat, p.lon) - 500) < 1);
  assert.equal(exitRadius({ radius: 100 }), 150);
  assert.equal(exitRadius({ radius: 60 }), 110);
  assert.equal(exitRadius({ radius: 400 }), 600);
});

test('GPS jitter at the edge of a Place never sends arrive / leave (12 h, 4 seeds)', () => {
  for (const seed of [1, 2, 3, 4]) {
    const r = rng(seed);
    // standing 100 m from the centre of a 120 m Place (exit radius 180 m), noise 35 m, accuracy 15-90 m, a fix every 2 min
    const fixes = stay(r, T0, T0 + 12 * 3600, 120, HOME, { sd: 35, de: 100, acc: [15, 90] });
    const outside = fixes.filter(f => distance(f.lat, f.lon, HOME.lat, HOME.lon) > HOME.radius).length;
    assert.ok(outside > 20, `the trace really crosses the edge (${outside} fixes outside the radius)`);
    const { events, state } = play(fixes, HOME);
    assert.deepEqual(events, [], `seed ${seed}`);
    assert.equal(state.status, 'inside');
  }
});

test('jitter while outside, near the edge, never fires "arrived" from single stray fixes', () => {
  const r = rng(9);
  // standing 230 m from the centre of a 120 m Place: now and then a single jumpy fix (poor accuracy, as GPS jumps are) lands inside
  const fixes = stay(r, T0, T0 + 6 * 3600, 600, HOME, { sd: 35, de: 230, acc: [30, 70] });
  const start = { ...newGeoState(), status: 'outside' };
  const { events } = play(fixes.map((f, i) => (i % 7 === 3 ? { ...f, ...offset(HOME.lat, HOME.lon, 0, 90), acc: 75 } : f)), HOME, OPTS, start);
  assert.deepEqual(events, []);
});

test('a real departure fires "left" exactly once, and the way back "arrived" exactly once', () => {
  const r = rng(5);
  const fixes = [
    ...stay(r, T0, T0 + 3600, 300, HOME, { sd: 15 }),
    ...travel(r, T0 + 3600, T0 + 3600 + 900, 30, HOME, SCHOOL),
    ...stay(r, T0 + 4600, T0 + 8 * 3600, 300, SCHOOL, { sd: 20 }),
    ...travel(r, T0 + 8 * 3600, T0 + 8 * 3600 + 900, 30, SCHOOL, HOME),
    ...stay(r, T0 + 8 * 3600 + 960, T0 + 12 * 3600, 300, HOME, { sd: 15 }),
  ];
  const home = play(fixes, HOME), school = play(fixes, SCHOOL);
  assert.deepEqual(home.events.map(e => e.event), ['leave', 'arrive']);
  assert.deepEqual(school.events.map(e => e.event), ['arrive', 'leave']);
  // timely: left within 4 minutes of walking out of the exit radius
  const exitT = fixes.find(f => f.tst > T0 + 3600 && distance(f.lat, f.lon, HOME.lat, HOME.lon) > exitRadius(HOME) + 20).tst;
  assert.ok(home.events[0].t - exitT <= 240, `left after ${home.events[0].t - exitT} s`);
});

test('the first fixes after a start only settle the state', () => {
  assert.deepEqual(play([loc(T0, HOME), loc(T0 + 60, HOME)], HOME).events, []);
  assert.equal(play([loc(T0, HOME), loc(T0 + 60, HOME)], HOME).state.status, 'inside');
  const far = offset(HOME.lat, HOME.lon, 2000, 0);
  assert.equal(play([loc(T0, far)], HOME).state.status, 'outside');
});

test('arrive: one stable fix, or two fixes inside; one shaky fix is not enough', () => {
  const out = { ...newGeoState(), status: 'outside' };
  const near = offset(HOME.lat, HOME.lon, 0, 60);
  assert.equal(geoStep(out, loc(T0, near, { acc: 30 }), HOME).event, 'arrive', 'stable: 60 + 2 x 30 <= 120');
  const shaky = geoStep(out, loc(T0, near, { acc: 80 }), HOME);
  assert.equal(shaky.event, null);
  assert.equal(geoStep(shaky.state, loc(T0 + 60, near, { acc: 80 }), HOME).event, 'arrive', 'second fix inside');
  const s2 = geoStep(shaky.state, loc(T0 + 60, offset(HOME.lat, HOME.lon, 0, 500), { acc: 20 }), HOME);
  assert.equal(geoStep(s2.state, loc(T0 + 120, near, { acc: 80 }), HOME).event, null, 'a fix outside in between starts over');
});

test('fixes worse than the accuracy limit and older fixes are ignored', () => {
  const inside = { ...newGeoState(), status: 'inside', lastTs: T0 };
  const far = offset(HOME.lat, HOME.lon, 3000, 0);
  assert.equal(geoStep(inside, loc(T0 + 60, far, { acc: 1500 }), HOME).reason, 'inaccurate');
  assert.equal(geoStep(inside, loc(T0 - 60, far), HOME).reason, 'old');
});

test('leave: one fix far past the exit radius is enough; one fix just outside then silence never is', () => {
  const inside = { ...newGeoState(), status: 'inside' };
  const veryFar = offset(HOME.lat, HOME.lon, 900, 0);
  const r1 = geoStep(inside, loc(T0, veryFar, { acc: 20 }), HOME);
  assert.equal(r1.event, 'leave'); assert.equal(r1.reason, 'far');
  const justOut = offset(HOME.lat, HOME.lon, 230, 0);
  let s = geoStep(inside, loc(T0, justOut, { acc: 20 }), HOME).state;
  for (let t = T0 + 60; t < T0 + 6 * 3600; t += 60) { const r = geoTick(s, t, OPTS); assert.equal(r.event, null); s = r.state; }
  // but two fixes outside, 3+ minutes apart, are confirmed by the clock
  s = geoStep(s, loc(T0 + 60, justOut, { acc: 20 }), HOME).state;
  assert.equal(s.status, 'inside');
  const confirm = geoTick(s, T0 + 181, OPTS);
  assert.equal(confirm.event, 'leave');
  // and a fix back inside cancels a departure in progress
  let c = geoStep(inside, loc(T0, justOut, { acc: 20 }), HOME).state;
  c = geoStep(c, loc(T0 + 60, justOut, { acc: 20 }), HOME).state;
  c = geoStep(c, loc(T0 + 90, HOME, { acc: 20 }), HOME).state;
  assert.equal(geoTick(c, T0 + 400, OPTS).event, null);
});

test("phone region events are used but cross-checked", () => {
  const inside = { ...newGeoState(), status: 'inside' }, outside = { ...newGeoState(), status: 'outside' };
  const out = offset(HOME.lat, HOME.lon, 250, 0), band = offset(HOME.lat, HOME.lon, 150, 0);
  assert.equal(geoStep(inside, { ...loc(T0, out), transition: 'leave' }, HOME).event, 'leave', 'phone + our fix agree');
  assert.equal(geoStep(inside, { ...loc(T0, HOME), transition: 'leave' }, HOME).reason, 'transition-disagrees');
  const pending = geoStep(inside, { ...loc(T0, band), transition: 'leave' }, HOME);
  assert.equal(pending.event, null);
  assert.equal(geoTick(pending.state, T0 + 100, OPTS).event, null);
  assert.equal(geoTick(pending.state, T0 + 181, OPTS).event, 'leave', 'phone said left and nothing contradicted it');
  assert.equal(geoStep(pending.state, loc(T0 + 30, HOME), HOME).state.phoneLeft, false, 'a fix inside cancels it');
  assert.equal(geoStep(outside, { ...loc(T0, offset(HOME.lat, HOME.lon, 100, 0), { acc: 40 }), transition: 'enter' }, HOME).event, 'arrive');
  assert.equal(geoStep(outside, { ...loc(T0, offset(HOME.lat, HOME.lon, 2000, 0), { acc: 40 }), transition: 'enter' }, HOME).reason, 'transition-disagrees');
});

test('recorded-style trace (test/traces/day.jsonl): exactly the expected events', () => {
  const lines = fs.readFileSync(new URL('./traces/day.jsonl', import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const home = play(lines, HOME), school = play(lines, SCHOOL);
  assert.deepEqual(home.events.map(e => e.event), ['leave', 'arrive']);
  assert.deepEqual(school.events.map(e => e.event), ['arrive', 'leave']);
});
