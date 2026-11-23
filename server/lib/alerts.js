// Alerts: arrive / leave at Places (through the hysteresis in geo.js) and the rules. Every arrive / leave goes to the
// in-app feed; a push (Discord / ntfy) only goes out when a rule asks for it (and its schedule - weekdays, a time
// window, "not on holidays" - says now), outside the person's quiet hours (unless the rule is marked urgent), and not
// again for the same thing within the cool-down. Works on the plain `state` object the store saves.
import { geoStep, geoTick, distance, newGeoState } from './geo.js';

export const RULE_TYPES = ['arrive', 'leave', 'notLeft', 'notArrived', 'battery', 'noUpdate', 'stationary'];
const STAY_METERS = 150;
const FEED_MAX = 300;

// local date / time in the server's time zone
export function localTime(ms, timeZone = 'UTC') {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const hm = `${parts.hour}:${parts.minute}`;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hm, minutes: Number(parts.hour) * 60 + Number(parts.minute), dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday) };
}
const hmToMin = hm => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

// quiet: { from, to, days? }  days = the weekdays (0 = Sunday) a quiet period STARTS on; none / empty = every day.
// A period over midnight (22:00 - 07:00) that starts on Friday also covers early Saturday.
export function inQuietHours(quiet, minutes, dow) {
  if (!quiet) return false;
  const a = hmToMin(quiet.from), b = hmToMin(quiet.to);
  if (a == null || b == null || a === b) return false;
  const days = Array.isArray(quiet.days) && quiet.days.length && quiet.days.length < 7 && dow != null ? quiet.days : null;
  const on = d => !days || days.includes(((d % 7) + 7) % 7);
  if (a < b) return minutes >= a && minutes < b && on(dow);
  if (minutes >= a) return on(dow);
  if (minutes < b) return on(dow - 1);
  return false;
}

// a rule's schedule: weekdays, an optional time window (from - to, may cross midnight) and "not on holidays"
export function scheduleAllows(rule, lt, holidays = []) {
  if (Array.isArray(rule.days) && rule.days.length && rule.days.length < 7 && !rule.days.includes(lt.dow)) return false;
  if (rule.skipHolidays && holidays.includes(lt.date)) return false;
  if (rule.from || rule.to) {
    const a = hmToMin(rule.from || '00:00'), b = rule.to ? hmToMin(rule.to) : 1440;
    if (a != null && b != null && a !== b) { const m = lt.minutes; if (a < b ? !(m >= a && m < b) : !(m >= a || m < b)) return false; }
  }
  return true;
}

export function emptyState() {
  return { last: {}, geo: {}, at: {}, arrivals: {}, stay: {}, flags: {}, sent: {}, feed: [], pushedPlaces: {} };
}

// cfg(): { people, places, rules, settings }   deliver(alert): send a push   now(): ms
export function createEngine({ state, cfg, deliver = () => {}, now = () => Date.now(), onChange = () => {} }) {
  for (const [k, v] of Object.entries(emptyState())) if (state[k] === undefined) state[k] = v;
  const geoOpts = () => { const s = cfg().settings; return { maxAccuracy: s.maxAccuracy, leaveMinutes: s.leaveMinutes, leaveMeters: s.leaveMeters, arriveMinutes: s.arriveMinutes ?? 0, exitFactor: s.exitFactor ?? 1.5, exitExtra: s.exitExtra ?? 50 }; };
  const tz = () => cfg().settings.timeZone || 'UTC';
  const rulesFor = (type, person, place) => cfg().rules.filter(r => r.enabled !== false && r.type === type &&
    (r.person === '*' || r.person === person.id) && (place === undefined || r.place === '*' || r.place === place.id));
  const placeName = id => (cfg().places.find(p => p.id === id) || {}).name || 'a Place';

  const holidays = () => cfg().settings.holidays || [];
  function emit(kind, person, { place = null, text, key, push, ttlMin, urgent = false }) {
    const t = now();
    const set = cfg().settings;
    const cool = (ttlMin ?? set.cooldownMinutes ?? 15) * 60000;
    if (key && state.sent[key] && t - state.sent[key] < cool) return null;   // the same thing again too soon
    if (key) state.sent[key] = t;
    const lt = localTime(t, tz());
    const quiet = !urgent && inQuietHours(person.quiet, lt.minutes, lt.dow);
    const alert = { id: t.toString(36) + Math.random().toString(36).slice(2, 6), ts: t, person: person.id, kind, place, text, pushed: !!push && !quiet, quiet: !!push && quiet };
    state.feed.unshift(alert);
    if (state.feed.length > FEED_MAX) state.feed.length = FEED_MAX;
    if (alert.pushed) deliver(alert);
    onChange();
    return alert;
  }

  function placeEvent(person, place, event, fixTs) {
    const kind = event === 'arrive' ? 'arrive' : 'leave';
    if (kind === 'arrive') (state.arrivals[person.id] ||= {})[place.id] = fixTs * 1000;
    state.at[person.id] = currentPlace(person.id);
    const text = kind === 'arrive' ? `${person.name} arrived at ${place.name}` : `${person.name} left ${place.name}`;
    // per-place schedules: a rule only pushes on its days / in its hours (e.g. "only on school days")
    const lt = localTime(now(), tz());
    const rules = rulesFor(kind, person, place).filter(r => scheduleAllows(r, lt, holidays()));
    return emit(kind, person, { place: place.id, text, key: `${kind}:${person.id}:${place.id}`, push: rules.length > 0, urgent: rules.some(r => r.urgent) });
  }

  function currentPlace(pid) {
    const g = state.geo[pid] || {};
    const inside = cfg().places.filter(p => g[p.id]?.status === 'inside');
    return inside.length ? inside.sort((a, b) => a.radius - b.radius)[0].id : null;
  }

  // a new fix from a person's phone (already checked and not from a paused person)
  function onFix(person, fix) {
    const out = [];
    const prev = state.last[person.id];
    if (!fix.transition && (!prev || fix.tst >= prev.tst)) {
      // a fix too inaccurate for the geofences doesn't move the pin either, as long as a good one is recent (15 min):
      // the time, battery and speed are still updated
      const max = cfg().settings.maxAccuracy;
      const goodTs = prev ? prev.goodTs ?? prev.tst : 0;
      const held = fix.acc > max && prev && !(prev.acc > max) && fix.tst - goodTs < 900;
      state.last[person.id] = held ? { ...fix, lat: prev.lat, lon: prev.lon, acc: prev.acc, held: true, goodTs } : fix;
    }
    const g = (state.geo[person.id] ||= {});
    for (const place of cfg().places) {
      if (fix.transition && fix.place !== place.id) continue;   // a phone region event only speaks about its own Place
      const r = geoStep(g[place.id] || newGeoState(), fix, place, geoOpts());
      g[place.id] = r.state;
      if (r.event) { const a = placeEvent(person, place, r.event, fix.tst); if (a) out.push(a); }
    }
    state.at[person.id] = currentPlace(person.id);
    if (fix.transition) return out;
    const set = cfg().settings;
    // battery: once when it drops under the line, again only after it was 5 points above it (or charging); an optional
    // second, "critical" line sends one more alert in the same episode
    if (Number.isFinite(fix.batt)) {
      const charging = fix.bs === 2 || fix.bs === 3;
      for (const rule of rulesFor('battery', person)) {
        const k = `batt:${rule.id}:${person.id}`, kc = `battc:${rule.id}:${person.id}`;
        if (fix.batt < rule.below && !charging && !state.flags[k]) {
          state.flags[k] = true;
          if (rule.critical && fix.batt < rule.critical) state.flags[kc] = true;
          const a = emit('battery', person, { text: `${person.name}'s phone battery is at ${fix.batt}%`, key: k, push: true, ttlMin: 0, urgent: !!rule.urgent }); if (a) out.push(a);
        } else if (state.flags[k] && rule.critical && fix.batt < rule.critical && !charging && !state.flags[kc]) {
          state.flags[kc] = true;
          const a = emit('battery', person, { text: `${person.name}'s phone battery is critically low (${fix.batt}%)`, key: kc, push: true, ttlMin: 0, urgent: !!rule.urgent }); if (a) out.push(a);
        } else if (state.flags[k] && (charging || fix.batt >= rule.below + 5)) { delete state.flags[k]; delete state.flags[kc]; }
      }
    }
    // a new fix ends "no update" - and the feed says so (not pushed) when an alert about it went out
    let wasStale = false;
    for (const k of Object.keys(state.flags)) if (k.startsWith('noupd:') && k.endsWith(`:${person.id}`)) { delete state.flags[k]; wasStale = true; }
    if (wasStale) { const a = emit('back', person, { text: `${person.name}'s phone is sending updates again`, push: false }); if (a) out.push(a); }
    // stationary: an anchor that moves when they move more than 150 m (or their accuracy)
    if (!(fix.acc > set.maxAccuracy)) {
      const st = state.stay[person.id];
      if (!st || distance(st.lat, st.lon, fix.lat, fix.lon) > Math.max(STAY_METERS, fix.acc || 0)) state.stay[person.id] = { lat: fix.lat, lon: fix.lon, since: fix.tst * 1000, fired: {} };
    }
    onChange();
    return out;
  }

  // every minute: phone-less leave confirmation and the time rules
  function tick() {
    const t = now(), lt = localTime(t, tz()), out = [];
    const { people, places } = cfg();
    for (const person of people) {
      if (person.paused || !state.last[person.id]) continue;
      const g = state.geo[person.id] || {};
      for (const place of places) {
        if (!g[place.id]) continue;
        const r = geoTick(g[place.id], Math.floor(t / 1000), geoOpts());
        g[place.id] = r.state;
        if (r.event) { const a = placeEvent(person, place, r.event, Math.floor(t / 1000)); if (a) out.push(a); }
      }
      state.at[person.id] = currentPlace(person.id);   // a dwell confirmed here (even silently, at start) counts
      const last = state.last[person.id];
      for (const rule of rulesFor('noUpdate', person)) {
        const k = `noupd:${rule.id}:${person.id}`;
        if (!state.flags[k] && t - last.tst * 1000 >= rule.hours * 3600000) {
          state.flags[k] = true;
          // the last battery level hints why: a flat phone, or the phone switched off / OwnTracks closed
          const why = !Number.isFinite(last.batt) ? '' : last.batt <= 10 && last.bs !== 2 && last.bs !== 3 ? `, battery was at ${last.batt}% - probably flat` : `, battery was at ${last.batt}% - phone off or OwnTracks closed?`;
          const a = emit('noUpdate', person, { text: `No update from ${person.name} for ${rule.hours} hour${rule.hours === 1 ? '' : 's'} (last seen ${localTime(last.tst * 1000, tz()).hm}${why})`, key: k, push: true, ttlMin: 0, urgent: !!rule.urgent }); if (a) out.push(a);
        }
      }
      const st = state.stay[person.id];
      if (st && !currentPlace(person.id)) {
        for (const rule of rulesFor('stationary', person)) {
          if (!st.fired[rule.id] && t - st.since >= rule.hours * 3600000) {
            st.fired[rule.id] = true;
            const a = emit('stationary', person, { text: `${person.name} has been at an unknown place for ${rule.hours} hour${rule.hours === 1 ? '' : 's'}`, key: `stay:${rule.id}:${person.id}:${st.since}`, push: true, ttlMin: 0, urgent: !!rule.urgent }); if (a) out.push(a);
          }
        }
      }
      // "hasn't left / hasn't arrived by": checked once, in the hour after the time, on the chosen days
      for (const rule of [...rulesFor('notLeft', person), ...rulesFor('notArrived', person)]) {
        const at = hmToMin(rule.time);
        if (at == null || (rule.days && rule.days.length && !rule.days.includes(lt.dow)) || (rule.skipHolidays && holidays().includes(lt.date))) continue;
        if (lt.minutes < at || lt.minutes >= at + 60) continue;
        const k = `day:${rule.id}:${person.id}:${lt.date}`;
        if (state.flags[k]) continue;
        state.flags[k] = true;
        const placeIds = rule.place === '*' ? places.map(p => p.id) : [rule.place];
        for (const pid of placeIds) {
          if (!places.some(p => p.id === pid)) continue;
          const inside = g[pid]?.status === 'inside';
          let fire;
          if (rule.type === 'notLeft') fire = inside;
          else {
            const since = (state.arrivals[person.id] || {})[pid] || 0;
            const fromMin = hmToMin(rule.after) ?? 0;
            const arrivedToday = since && localTime(since, tz()).date === lt.date && localTime(since, tz()).minutes >= fromMin;
            fire = !inside && !arrivedToday;
          }
          if (fire) {
            const text = rule.type === 'notLeft' ? `${person.name} hasn't left ${placeName(pid)} by ${rule.time}` : `${person.name} hasn't arrived at ${placeName(pid)} by ${rule.time}`;
            const a = emit(rule.type, person, { place: pid, text, key: `${k}:${pid}`, push: true, ttlMin: 0, urgent: !!rule.urgent }); if (a) out.push(a);
          }
        }
      }
    }
    // forget old dedupe keys and daily flags
    for (const [k, v] of Object.entries(state.sent)) if (t - v > 2 * 86400000) delete state.sent[k];
    for (const k of Object.keys(state.flags)) { const m = /^day:.*:(\d{4}-\d{2}-\d{2})$/.exec(k); if (m && m[1] < localTime(t - 2 * 86400000, tz()).date) delete state.flags[k]; }
    if (out.length) onChange();
    return out;
  }

  // a person deleted their history or was removed: forget everything the engine knows about them
  function forget(pid) {
    for (const k of ['last', 'geo', 'at', 'arrivals', 'stay', 'pushedPlaces']) delete state[k][pid];
    for (const bag of [state.flags, state.sent]) for (const k of Object.keys(bag)) if (k.endsWith(':' + pid) || k.includes(':' + pid + ':')) delete bag[k];
    state.feed = state.feed.filter(a => a.person !== pid);
    onChange();
  }

  return { onFix, tick, forget, emit, currentPlace, state };
}
