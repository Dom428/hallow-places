// Test helpers: a seeded random generator and MADE-UP places and GPS traces. The coordinates are in the middle of the
// Atlantic Ocean on purpose (around 12.35 N, 32.1 W): no real address is used anywhere in the tests or screenshots.
export function rng(seed = 1) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  next.gauss = () => { let u = 0, v = 0; while (!u) u = next(); while (!v) v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  return next;
}

// move a point dn metres north and de metres east
export function offset(lat, lon, dn, de) {
  return { lat: lat + dn / 111320, lon: lon + de / (111320 * Math.cos(lat * Math.PI / 180)) };
}

export const HOME = { name: 'Home', lat: 12.3456, lon: -32.1, radius: 120 };
export const SCHOOL = { name: 'School', lat: 12.3561, lon: -32.0851, radius: 150 };
export const PARK = { name: 'Park', lat: 12.3392, lon: -32.0906, radius: 100 };
export const FRIEND = { lat: 12.3318, lon: -32.1123 };   // not a Place: "an unknown place"

export const loc = (tst, p, extra = {}) => ({ _type: 'location', tst, lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), acc: 15, tid: 'MI', ...extra });

// a person standing still with GPS noise (sd metres) around a spot dn/de metres from a centre
export function stay(r, from, to, every, centre, { sd = 15, dn = 0, de = 0, acc = [8, 40], batt } = {}) {
  const out = [];
  for (let t = from; t < to; t += every * (0.7 + r() * 0.6)) {
    const p = offset(centre.lat, centre.lon, dn + r.gauss() * sd, de + r.gauss() * sd);
    out.push(loc(Math.round(t), p, { acc: Math.round(acc[0] + r() * (acc[1] - acc[0])), vel: 0, ...(batt ? { batt: batt(t) } : {}) }));
  }
  return out;
}
// travelling in a straight line with a little noise
export function travel(r, from, to, every, a, b, { batt } = {}) {
  const out = [];
  const dist = Math.hypot((b.lat - a.lat) * 111320, (b.lon - a.lon) * 111320 * Math.cos(a.lat * Math.PI / 180));
  const kmh = Math.round(dist / ((to - from) / 3600) / 1000);
  for (let t = from; t <= to; t += every * (0.8 + r() * 0.4)) {
    const f = (t - from) / (to - from);
    const p = offset(a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f, r.gauss() * 8, r.gauss() * 8);
    out.push(loc(Math.round(t), p, { acc: Math.round(6 + r() * 20), vel: kmh, ...(batt ? { batt: batt(t) } : {}) }));
  }
  return out;
}

// A made-up school day for "Mia" (UTC): home until 07:40 with jitter near the edge of Home, to School, School until
// 15:00, then 3 h 20 min at a friend's (not a Place), home at 18:55. Battery runs down under 15 % at about 18:00 and is
// charged from 19:30. A cell-tower fix (1.5 km accuracy) at 10:00 must be ignored.
export function schoolDay(day0, seed = 7) {
  const r = rng(seed), H = h => day0 + Math.round(h * 3600);
  const batt = t => { const h = (t - day0) / 3600; return h < 19.5 ? Math.max(8, Math.round(96 - (h - 6.5) * 7.2)) : Math.min(100, Math.round(10 + (h - 19.5) * 40)); };
  const bs = t => ((t - day0) / 3600 >= 19.5 ? 2 : 1);
  const add = list => list.map(m => ({ ...m, bs: bs(m.tst) }));
  const homeEdge = offset(HOME.lat, HOME.lon, 0, 70);   // the bedroom at the far end: 70 m from the Place's centre
  return [
    ...add(stay(r, H(6.5), H(7 + 40 / 60), 300, homeEdge, { sd: 22, acc: [10, 70], batt })),
    ...add(travel(r, H(7 + 40 / 60), H(7 + 55 / 60), 45, homeEdge, SCHOOL, { batt })),
    ...add(stay(r, H(7 + 56 / 60), H(10), 600, SCHOOL, { sd: 25, acc: [10, 50], batt })),
    { ...loc(H(10), offset(SCHOOL.lat, SCHOOL.lon, 2600, -1800), { acc: 1500, batt: batt(H(10)) }), bs: 1 },
    ...add(stay(r, H(10) + 60, H(15), 600, SCHOOL, { sd: 25, acc: [10, 50], batt })),
    ...add(travel(r, H(15), H(15 + 20 / 60), 45, SCHOOL, FRIEND, { batt })),
    ...add(stay(r, H(15 + 21 / 60), H(18 + 40 / 60), 600, FRIEND, { sd: 12, acc: [10, 35], batt })),
    ...add(travel(r, H(18 + 40 / 60), H(18 + 55 / 60), 45, FRIEND, homeEdge, { batt })),
    ...add(stay(r, H(18 + 56 / 60), H(23), 600, homeEdge, { sd: 22, acc: [10, 70], batt })),
  ];
}
