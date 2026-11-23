// Demo mode: a MADE-UP family moving along made-up routes, with made-up Places and the alerts they cause, so the map,
// the satellite view and the alerts can be seen before any phone is set up. Everything here lives in memory, in its
// own alert engine with its own state: it is never written to the data folder, never mixed with real people, and its
// alerts are never pushed to Discord or ntfy.
//
// The Places sit inside a large public park (Central Park, New York) on purpose: nobody lives there, so no real home or
// address is shown, and both the street map and the satellite view have something to look at. The people, their names,
// their routes and their phones are invented.
import { createEngine, emptyState, localTime } from './alerts.js';
import { SETTINGS_DEFAULTS } from './store.js';

export const DEMO_PLACES = [
  { id: 'demo-home', name: 'Home', lat: 40.7813, lon: -73.9662, radius: 120, tst: 1 },
  { id: 'demo-school', name: 'School', lat: 40.7926, lon: -73.9584, radius: 150, tst: 2 },
  { id: 'demo-work', name: 'Work', lat: 40.7719, lon: -73.9749, radius: 150, tst: 3 },
  { id: 'demo-pool', name: 'Pool', lat: 40.7966, lon: -73.9518, radius: 110, tst: 4 },
];
const P = Object.fromEntries(DEMO_PLACES.map(p => [p.name, p]));
const EAST = [[40.7840, -73.9600], [40.7873, -73.9571]];   // round the reservoir on its east side
const RAMBLE = [[40.7768, -73.9716]];

// each person: a repeating day of stays and walks (seconds)
export const DEMO_PEOPLE = [
  { id: 'demo-alex', name: 'Alex', tid: 'AX', color: '#F07820', offset: 0,
    plan: [['stay', 'Home', 360], ['move', ['Home', ...EAST, 'School'], 300], ['stay', 'School', 480], ['move', ['School', ...[...EAST].reverse(), 'Home'], 300]],
    batt: () => [81, 1] },
  { id: 'demo-sam', name: 'Sam', tid: 'SM', color: '#2F7FD8', offset: 400,
    plan: [['stay', 'Work', 600], ['move', ['Work', ...RAMBLE, 'Home'], 420], ['stay', 'Home', 420], ['move', ['Home', ...RAMBLE, 'Work'], 420]],
    // drains from 24% to 10% over 24 minutes, then charges for 16: a low-battery alert every 40 minutes
    batt: t => { const ph = (t % 2400) / 2400; return ph < 0.6 ? [Math.round(24 - ph / 0.6 * 14), 1] : [Math.round(10 + (ph - 0.6) / 0.4 * 14), 2]; } },
  { id: 'demo-kit', name: 'Kit', tid: 'KT', color: '#2E9E6A', offset: 900, quiet: { from: '00:00', to: '23:59' },
    plan: [['stay', 'Home', 500], ['move', ['Home', ...EAST, [40.7930, -73.9540], 'Pool'], 600], ['stay', 'Pool', 600], ['move', ['Pool', [40.7930, -73.9540], ...[...EAST].reverse(), 'Home'], 600]],
    batt: () => [57, 1] },
  // Robin's phone went quiet five hours ago with a nearly flat battery: the "no update" alert
  { id: 'demo-robin', name: 'Robin', tid: 'RB', color: '#7A5CC0', stale: { hoursAgo: 5, at: 'Pool', batt: 6 } },
];
export const DEMO_RULES = [
  { id: 'd-arrive', type: 'arrive', person: '*', place: '*', enabled: true },
  { id: 'd-leave', type: 'leave', person: '*', place: '*', enabled: true },
  { id: 'd-school', type: 'arrive', person: 'demo-alex', place: 'demo-school', days: [1, 2, 3, 4, 5], skipHolidays: true, urgent: false, enabled: true },
  { id: 'd-batt', type: 'battery', person: '*', below: 15, critical: 5, enabled: true },
  { id: 'd-noupd', type: 'noUpdate', person: '*', hours: 3, enabled: true },
];

const pt = x => (typeof x === 'string' ? [P[x].lat, P[x].lon] : x);
const meters = (a, b) => Math.hypot((b[0] - a[0]) * 111320, (b[1] - a[1]) * 111320 * Math.cos(a[0] * Math.PI / 180));
function hash(a, b) { let x = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263); x = Math.imul(x ^ (x >>> 13), 1274126177); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; }
const gauss = (a, b) => Math.sqrt(-2 * Math.log(Math.max(1e-9, hash(a, b)))) * Math.cos(2 * Math.PI * hash(b, a + 7));

// where a demo person is at second t (no noise), and whether they are walking
export function demoPosition(person, t) {
  const cycle = person.plan.reduce((s, x) => s + x[2], 0);
  let k = ((t + person.offset) % cycle + cycle) % cycle;
  for (const [type, what, dur] of person.plan) {
    if (k >= dur) { k -= dur; continue; }
    if (type === 'stay') return { lat: P[what].lat, lon: P[what].lon, moving: false };
    const pts = what.map(pt), legs = pts.slice(1).map((b, i) => meters(pts[i], b)), total = legs.reduce((a, b) => a + b, 0);
    let d = k / dur * total;
    for (let i = 0; i < legs.length; i++) {
      if (d <= legs[i] || i === legs.length - 1) { const f = legs[i] ? Math.min(1, d / legs[i]) : 0; return { lat: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, lon: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f, moving: true, kmh: Math.round(total / dur * 3.6) }; }
      d -= legs[i];
    }
  }
  return { lat: P.Home.lat, lon: P.Home.lon, moving: false };
}

// one OwnTracks-like fix with GPS noise; about one in 20 is a bad fix (300 m accuracy, far off) that the hysteresis
// must ignore - so the demo also shows the jitter protection at work
export function demoFix(person, t, idx) {
  const p = demoPosition(person, t);
  const bad = hash(idx * 31 + 5, t) < 0.05;
  const sd = bad ? 220 : 12;
  const dn = gauss(idx, t) * sd, de = gauss(t, idx + 3) * sd;
  const [batt, bs] = person.batt(t);
  return {
    tst: t, lat: Math.round((p.lat + dn / 111320) * 1e6) / 1e6, lon: Math.round((p.lon + de / (111320 * Math.cos(p.lat * Math.PI / 180))) * 1e6) / 1e6,
    acc: bad ? 300 : Math.round(8 + hash(t, idx) * 30), vel: p.moving ? p.kmh : 0, batt, bs, conn: 'm',
  };
}

export function createDemo({ timeZone = 'UTC', now = () => Date.now(), liveMs = 10000 } = {}) {
  const people = DEMO_PEOPLE.map(({ id, name, tid, color, quiet }) => ({ id, name, tid, color, quiet: quiet || null }));
  const C = { people, places: DEMO_PLACES, rules: DEMO_RULES, settings: { ...SETTINGS_DEFAULTS, timeZone, demo: true } };
  const state = emptyState();
  let clock = now();
  const engine = createEngine({ state, cfg: () => C, now: () => clock, deliver: () => {} });   // never pushed
  const history = new Map(people.map(p => [p.id, []]));
  const lastAt = new Map();

  function record(person, fix) {
    const h = history.get(person.id);
    h.push(fix); if (h.length > 4000) h.splice(0, h.length - 4000);
    engine.onFix(person, fix);
  }
  // advance the simulation to second t: fixes every 20 s while walking, every 60 s while staying put
  let lastTick = 0;
  function stepTo(t) {
    DEMO_PEOPLE.forEach((d, i) => {
      if (d.stale) return;
      const prev = lastAt.get(d.id) ?? -Infinity;
      if (t - prev < (demoPosition(d, t).moving ? 20 : 60)) return;
      lastAt.set(d.id, t);
      record(people[i], demoFix(d, t, i + 1));
    });
    if (t - lastTick >= 60) { lastTick = t; engine.tick(); }
  }

  // warm up: Robin's last fix five hours ago, then two hours of everyone else, so the feed already has alerts
  const start = Math.floor(clock / 1000);
  DEMO_PEOPLE.forEach((d, i) => {
    if (!d.stale) return;
    const t = start - d.stale.hoursAgo * 3600, at = P[d.stale.at];
    clock = t * 1000;
    record(people[i], { tst: t, lat: at.lat + 0.0001, lon: at.lon - 0.0001, acc: 14, vel: 0, batt: d.stale.batt, bs: 1, conn: 'm' });
  });
  for (let t = start - 5 * 3600; t <= start; t += 10) { clock = t * 1000; if (t >= start - 2 * 3600) stepTo(t); else if (t - lastTick >= 60) { lastTick = t; engine.tick(); } }

  const timer = liveMs ? setInterval(() => { clock = now(); stepTo(Math.floor(clock / 1000)); }, liveMs) : null;
  timer?.unref?.();

  function publicPerson(p) {
    const last = state.last[p.id];
    const out = { id: p.id, name: p.name, tid: p.tid, color: p.color, paused: false, demo: true };
    if (last) out.last = { lat: last.lat, lon: last.lon, acc: last.acc, batt: last.batt, bs: last.bs, vel: last.vel, tst: last.tst, conn: last.conn };
    const at = state.at[p.id]; if (at) out.at = DEMO_PLACES.find(x => x.id === at)?.name;
    return out;
  }
  // nothing is ever delivered: an alert a real rule would push says 'would be sent' instead of 'sent'
  const shown = a => ({ ...a, pushed: false, wouldPush: a.pushed, demo: true });
  return {
    config: C, state, engine,
    advance(ms) { clock = ms; stepTo(Math.floor(ms / 1000)); },
    map: () => ({ people: people.map(publicPerson), places: DEMO_PLACES.map(({ id, name, lat, lon, radius }) => ({ id, name, lat, lon, radius })), feed: state.feed.slice(0, 60).map(shown) }),
    feed: (n = 300) => state.feed.slice(0, n).map(shown),
    track(id, date) {
      const h = history.get(id); if (!h) return null;
      const tz = C.settings.timeZone;
      const days = [...new Set(h.map(f => localTime(f.tst * 1000, tz).date))].sort();
      const day = date || days.at(-1) || localTime(clock, tz).date;
      return { date: day, days, points: h.filter(f => f.acc <= 200 && localTime(f.tst * 1000, tz).date === day).map(f => [f.lat, f.lon, f.tst, f.acc]) };
    },
    stop() { if (timer) clearInterval(timer); },
  };
}
