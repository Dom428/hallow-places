// The OwnTracks side: checking what phones post in HTTP mode, the reply they get (family positions, Places as regions),
// and the configuration a phone imports by scanning a QR code. https://owntracks.org/booklet/tech/json/
import { decryptOwnTracks, encryptOwnTracks } from './secretbox.js';

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : undefined);

// body text -> { msg } | { error }; decrypts {"_type":"encrypted"} with the person's key
export function parseMessage(text, encryptionKey) {
  let m;
  try { m = JSON.parse(text); } catch { return { error: 'not JSON' }; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { error: 'not an object' };
  let encrypted = false;
  if (m._type === 'encrypted') {
    if (!encryptionKey) return { error: 'encrypted, but no key is set for this person' };
    const inner = decryptOwnTracks(m.data, encryptionKey);
    if (inner == null) return { error: 'could not decrypt (wrong key?)' };
    try { m = JSON.parse(inner); } catch { return { error: 'decrypted text is not JSON' }; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return { error: 'not an object' };
    encrypted = true;
  }
  if (typeof m._type !== 'string') return { error: 'no _type' };
  return { msg: m, encrypted };
}

// a location or transition -> a clean fix, or null when it isn't usable
export function toFix(m, nowSec = Math.floor(Date.now() / 1000)) {
  const lat = num(m.lat), lon = num(m.lon), tst = num(m.tst);
  if (lat === undefined || lon === undefined || tst === undefined) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180 || (lat === 0 && lon === 0)) return null;
  if (tst < 1e9 || tst > nowSec + 600) return null;   // nonsense or more than 10 minutes in the future
  const fix = { tst: Math.floor(tst), lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
  const acc = num(m.acc); if (acc !== undefined && acc >= 0 && acc < 1e6) fix.acc = Math.round(acc);
  const alt = num(m.alt); if (alt !== undefined && Math.abs(alt) < 1e5) fix.alt = Math.round(alt);
  const vel = num(m.vel); if (vel !== undefined && vel >= 0 && vel < 2000) fix.vel = Math.round(vel);   // km/h
  const cog = num(m.cog); if (cog !== undefined && cog >= 0 && cog <= 360) fix.cog = Math.round(cog);
  const batt = num(m.batt); if (batt !== undefined && batt >= 0 && batt <= 100) fix.batt = Math.round(batt);
  const bs = num(m.bs); if (bs !== undefined && [0, 1, 2, 3].includes(bs)) fix.bs = bs;   // 2 charging, 3 full
  if (typeof m.conn === 'string' && /^[wmo]$/.test(m.conn)) fix.conn = m.conn;
  if (typeof m.t === 'string' && /^[a-z]$/i.test(m.t)) fix.t = m.t;
  if (m._type === 'transition') {
    if (m.event !== 'enter' && m.event !== 'leave') return null;
    fix.transition = m.event;
    if (typeof m.desc === 'string') fix.desc = m.desc.slice(0, 80);
    const wtst = num(m.wtst); if (wtst !== undefined) fix.wtst = Math.floor(wtst);
  }
  return fix;
}

// which Place a phone's region event is about: our waypoint id (wtst = the Place's tst) or its name
export function placeForTransition(fix, places) {
  return places.find(p => fix.wtst && p.tst === fix.wtst) || places.find(p => fix.desc && p.name.toLowerCase() === fix.desc.toLowerCase()) || null;
}

export const waypoint = p => ({ _type: 'waypoint', desc: p.name, lat: p.lat, lon: p.lon, rad: Math.round(p.radius), tst: p.tst });

// the reply to a phone: other family members (so they show in the OwnTracks app too) and new Places as regions.
// Each item is sealed when the phone sent sealed.
export function reply(items, encryptionKey) {
  if (!encryptionKey) return items;
  return items.map(i => ({ _type: 'encrypted', data: encryptOwnTracks(JSON.stringify(i), encryptionKey) }));
}

export function friendItems(person, last) {
  const topic = `owntracks/${person.user}/hallow`;
  const loc = { _type: 'location', tid: person.tid, lat: last.lat, lon: last.lon, tst: last.tst, topic };
  for (const k of ['acc', 'alt', 'vel', 'cog', 'batt']) if (last[k] !== undefined) loc[k] = last[k];
  return [{ _type: 'card', name: person.name, tid: person.tid, topic }, loc];
}

export function setWaypointsCmd(places) {
  return { _type: 'cmd', action: 'setWaypoints', waypoints: { _type: 'waypoints', waypoints: places.map(waypoint) } };
}

// what the phone imports (QR code / .otrc file). mode 3 = HTTP. The token is the password.
export function phoneConfig({ person, device, token, url }) {
  const c = {
    _type: 'configuration',
    mode: 3,
    url,
    auth: true,
    username: person.user,
    password: token,
    deviceId: device.id,
    tid: person.tid,
    monitoring: 1,          // "significant changes": good on battery; the phone can switch to Move mode itself
    cmd: true,              // lets the server send Places as regions (setWaypoints)
    pubExtendedData: true,  // battery, speed, connection
  };
  if (person.encryptionKey) c.encryptionKey = person.encryptionKey;
  return c;
}

export const inlineLink = cfg => 'owntracks:///config?inline=' + encodeURIComponent(Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64'));
