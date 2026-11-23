// Geofences with hysteresis: decides when someone really arrived at or left a Place, so GPS jitter at the edge of a
// circle doesn't send "arrived / left / arrived / left". Pure functions over a small state object per person and Place.
//
//   inside      distance <= radius
//   band        radius < distance <= exit radius (max(radius * exitFactor, radius + exitExtra); 1.5 and 50 m by
//               default, the hysteresis radius) - counts as neither
//   outside     distance > exit radius, and the fix's accuracy circle doesn't touch the Place
//
// - Fixes with accuracy worse than maxAccuracy are ignored, and so are fixes older than the last one used.
// - Arrive: 2 fixes in a row inside, or 1 "stable" fix (twice its accuracy circle inside the radius), or the phone's
//   own region "enter" when its fix agrees (within radius + accuracy) - AND the dwell time (arriveMinutes) has passed
//   since the first of those fixes with nothing outside in between. A dwell still running is confirmed by the next fix
//   or by geoTick, so a single drive-by of a Place never counts as "arrived".
// - Leave: only after fixes outside the exit radius - at least 2 of them over leaveMinutes with no fix inside or in
//   the band between (any such fix cancels), or one fix whose whole accuracy circle is leaveMeters beyond the exit
//   radius (clearly gone), or the phone's region "leave" when its fix is outside the exit radius (or in the band and
//   nothing contradicts it for leaveMinutes).
// - The first fixes after a start only settle the state; they never fire anything.

export const GEO_DEFAULTS = { maxAccuracy: 100, leaveMinutes: 3, leaveMeters: 300, arriveMinutes: 0, exitFactor: 1.5, exitExtra: 50 };

export function distance(lat1, lon1, lat2, lon2) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export const exitRadius = (place, o = GEO_DEFAULTS) => Math.max(place.radius * (o.exitFactor ?? 1.5), place.radius + (o.exitExtra ?? 50));

export const newGeoState = () => ({ status: 'unknown', inCount: 0, inSince: null, arriveReady: null, outSince: null, outCount: 0, phoneLeft: false, lastTs: 0 });

// fix: { tst (s), lat, lon, acc (m), transition: 'enter' | 'leave' | undefined }
// returns { state, event: 'arrive' | 'leave' | null, reason }
export function geoStep(prev, fix, place, opts = {}) {
  const o = { ...GEO_DEFAULTS, ...opts };
  const s = { ...(prev || newGeoState()) };
  if (!(fix.tst >= s.lastTs)) return { state: s, event: null, reason: 'old' };
  const acc = Number.isFinite(fix.acc) ? fix.acc : 0;
  if (acc > o.maxAccuracy) return { state: s, event: null, reason: 'inaccurate' };
  s.lastTs = fix.tst;
  const d = distance(fix.lat, fix.lon, place.lat, place.lon);
  const r = place.radius, exitR = exitRadius(place, o);
  // outside only when past the exit radius AND the whole accuracy circle is off the Place
  const zone = d <= r ? 'inside' : d > exitR && d - acc > r ? 'outside' : 'band';

  if (s.status !== 'inside') {
    const phoneEnter = fix.transition === 'enter';
    if (phoneEnter && d > r + acc) return { state: s, event: null, reason: 'transition-disagrees' };
    if (zone === 'inside' || phoneEnter) {
      s.inCount++;
      if (s.inSince == null) s.inSince = fix.tst;
      const stable = d + 2 * acc <= r;   // even twice its accuracy stays inside
      const why = phoneEnter ? 'phone-enter' : stable ? 'stable-fix' : s.inCount >= 2 ? 'two-fixes' : s.arriveReady;
      if (why) {
        s.arriveReady = why;
        if (fix.tst - s.inSince >= (o.arriveMinutes || 0) * 60) return arrive(s, why);
        return { state: s, event: null, reason: 'dwell' };
      }
      return { state: s, event: null, reason: 'arriving' };
    }
    s.inCount = 0; s.inSince = null; s.arriveReady = null;
    if (zone === 'outside' && s.status === 'unknown') { s.status = 'outside'; return { state: s, event: null, reason: 'initial' }; }
    return { state: s, event: null, reason: zone };
  }

  // status inside: watch for a real departure
  if (fix.transition === 'leave') {
    if (zone === 'inside') return { state: s, event: null, reason: 'transition-disagrees' };
    if (zone === 'outside') return leave(s, 'phone-leave');
    s.phoneLeft = true;
    if (!s.outSince) s.outSince = fix.tst;
    return { state: s, event: null, reason: 'leaving' };
  }
  if (zone !== 'outside') {
    if (zone === 'inside' || !s.phoneLeft) { s.outSince = null; s.outCount = 0; s.phoneLeft = false; }
    return { state: s, event: null, reason: zone };
  }
  if (!s.outSince) s.outSince = fix.tst;
  s.outCount++;
  if (s.phoneLeft) return leave(s, 'phone-leave');
  if (d - acc > exitR + o.leaveMeters) return leave(s, 'far');
  if (s.outCount >= 2 && fix.tst - s.outSince >= o.leaveMinutes * 60) return leave(s, 'time');
  return { state: s, event: null, reason: 'leaving' };
}

// Called every minute without a new fix: a departure seen by 2+ fixes (or the phone) is confirmed once leaveMinutes have
// passed. A single stray fix outside followed by silence (a phone resting at home) never confirms.
export function geoTick(prev, now, opts = {}) {
  const o = { ...GEO_DEFAULTS, ...opts };
  const s = { ...(prev || newGeoState()) };
  if (s.status === 'inside' && s.outSince && (s.outCount >= 2 || s.phoneLeft) && now - s.outSince >= o.leaveMinutes * 60) return leave(s, 'time');
  // a dwell that started with enough evidence and saw nothing outside since: confirmed once the dwell time is over
  if (s.status !== 'inside' && s.arriveReady && s.inSince != null && now - s.inSince >= (o.arriveMinutes || 0) * 60) return arrive(s, s.arriveReady);
  return { state: s, event: null, reason: 'none' };
}

function arrive(s, why) {
  const was = s.status;
  Object.assign(s, { status: 'inside', inCount: 0, inSince: null, arriveReady: null, outSince: null, outCount: 0, phoneLeft: false });
  return { state: s, event: was === 'outside' ? 'arrive' : null, reason: was === 'outside' ? why : 'initial' };
}

function leave(s, reason) {
  Object.assign(s, { status: 'outside', inCount: 0, inSince: null, arriveReady: null, outSince: null, outCount: 0, phoneLeft: false });
  return { state: s, event: 'leave', reason };
}
