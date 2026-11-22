// Geofences with hysteresis: decides when someone really arrived at or left a Place, so GPS jitter at the edge of a
// circle doesn't send "arrived / left / arrived / left". Pure functions over a small state object per person and Place.
//
//   inside      distance <= radius
//   band        radius < distance <= exit radius (max(radius * 1.5, radius + 50 m)) - counts as neither
//   outside     distance > exit radius, and the fix's accuracy circle doesn't touch the Place
//
// - Fixes with accuracy worse than maxAccuracy are ignored, and so are fixes older than the last one used.
// - Arrive: 2 fixes in a row inside, or 1 "stable" fix (twice its accuracy circle inside the radius), or the phone's
//   own region "enter" when its fix agrees (within radius + accuracy).
// - Leave: only after fixes outside the exit radius - at least 2 of them over leaveMinutes with no fix inside or in
//   the band between (any such fix cancels), or one fix whose whole accuracy circle is leaveMeters beyond the exit
//   radius (clearly gone), or the phone's region "leave" when its fix is outside the exit radius (or in the band and
//   nothing contradicts it for leaveMinutes).
// - The first fixes after a start only settle the state; they never fire anything.

export const GEO_DEFAULTS = { maxAccuracy: 100, leaveMinutes: 3, leaveMeters: 300 };

export function distance(lat1, lon1, lat2, lon2) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export const exitRadius = place => Math.max(place.radius * 1.5, place.radius + 50);

export const newGeoState = () => ({ status: 'unknown', inCount: 0, outSince: null, outCount: 0, phoneLeft: false, lastTs: 0 });

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
  const r = place.radius, exitR = exitRadius(place);
  // outside only when past the exit radius AND the whole accuracy circle is off the Place
  const zone = d <= r ? 'inside' : d > exitR && d - acc > r ? 'outside' : 'band';

  if (s.status !== 'inside') {
    const phoneEnter = fix.transition === 'enter';
    if (phoneEnter && d > r + acc) return { state: s, event: null, reason: 'transition-disagrees' };
    if (zone === 'inside' || phoneEnter) {
      s.inCount++;
      const stable = d + 2 * acc <= r;   // even twice its accuracy stays inside
      if (stable || s.inCount >= 2 || phoneEnter) {
        const was = s.status;
        Object.assign(s, { status: 'inside', inCount: 0, outSince: null, outCount: 0, phoneLeft: false });
        return { state: s, event: was === 'outside' ? 'arrive' : null, reason: was === 'outside' ? (phoneEnter ? 'phone-enter' : stable ? 'stable-fix' : 'two-fixes') : 'initial' };
      }
      return { state: s, event: null, reason: 'arriving' };
    }
    s.inCount = 0;
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
  return { state: s, event: null, reason: 'none' };
}

function leave(s, reason) {
  Object.assign(s, { status: 'outside', inCount: 0, outSince: null, outCount: 0, phoneLeft: false });
  return { state: s, event: 'leave', reason };
}
