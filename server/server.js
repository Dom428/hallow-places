// Hallow Places: private family location sharing on your own server. Phones run the free OwnTracks app in HTTP mode
// and post here; the family sees each other on a map, and smarter alerts (with hysteresis, quiet hours and no repeat
// spam) go to the in-app feed, a Discord webhook and/or ntfy. No npm packages: just Node's standard library.
// Locations, tokens, passwords, the webhook and keys are never logged.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/store.js';
import { createEngine, localTime, RULE_TYPES } from './lib/alerts.js';
import { createNotifier, validUrl } from './lib/notify.js';
import { hashPassword, verifyPassword, newToken, tokenHash, tokenMatches, parseBasic, createSessions, createLimiter } from './lib/auth.js';
import { parseMessage, toFix, placeForTransition, reply, friendItems, setWaypointsCmd, phoneConfig, inlineLink } from './lib/owntracks.js';
import { encode as qrEncode, toSvg } from './lib/qr.js';
import { PROVIDERS, SATELLITES, STYLES, KEY_HELP, resolveStyles, directOrigins, createTileCache } from './lib/tiles.js';
import { createDemo } from './lib/demo.js';

export const VERSION = '1.1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLORS = ['#F07820', '#7A5CC0', '#2E9E6A', '#2F7FD8', '#D8436A', '#B8901E', '#1E9EA8', '#8C6A4A'];
const FROM_TUNNEL = ip => /^(127\.|::1$|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
const USER_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function config(env = process.env) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    port: num(env.PORT, 8080),
    host: env.HOST || '0.0.0.0',
    dataDir: env.DATA_DIR || path.join(HERE, 'data'),
    publicUrl: String(env.PUBLIC_URL || '').replace(/\/+$/, ''),
    trustProxy: String(env.TRUST_PROXY || 'none').toLowerCase(),
    adminPassword: env.ADMIN_PASSWORD || '',
    timeZone: env.TZ || '',
    log: env.LOG !== 'off',
    demo: /^(1|true|on|yes)$/i.test(String(env.DEMO || '')),   // made-up family on the map (lib/demo.js); off by default
  };
}

export function createServer(opts = {}) {
  const cfg = { ...config({}), ...opts };
  const now = opts.now || (() => Date.now());
  const log = (...a) => { if (cfg.log) console.log(new Date(now()).toISOString(), ...a); };
  const store = createStore(cfg.dataDir);
  const C = store.config;
  const S = () => C.settings;

  // ---- first start
  if (C.rules === null) {
    C.rules = [
      { id: 'r-arrive', type: 'arrive', person: '*', place: '*', enabled: true },
      { id: 'r-leave', type: 'leave', person: '*', place: '*', enabled: true },
      { id: 'r-battery', type: 'battery', person: '*', below: 15, enabled: true },
      { id: 'r-noupdate', type: 'noUpdate', person: '*', hours: 12, enabled: true },
    ];
  }
  if (!C.settings.publicUrl && cfg.publicUrl) C.settings.publicUrl = cfg.publicUrl;
  if (!C.settingsInit) { C.settingsInit = true; if (cfg.timeZone && validTz(cfg.timeZone)) C.settings.timeZone = cfg.timeZone; }
  if (!C.admin.hash && cfg.adminPassword) C.admin.hash = hashPassword(cfg.adminPassword);
  store.saveConfig();
  // without an admin password the first visitor needs this code from the container log
  const setupCode = C.admin.hash ? null : String(crypto.randomInt(10000000, 100000000));
  if (setupCode) console.log(`Hallow Places: open the web page and set the admin password with this one-time setup code: ${setupCode}`);

  const notifier = createNotifier({ settings: S, log: m => log('push:', m) });
  const engine = createEngine({ state: store.state, cfg: () => C, now, onChange: store.saveState, deliver: a => notifier.send(a).catch(() => {}) });
  const tileCache = createTileCache({ dir: cfg.dataDir, providers: { ...PROVIDERS, ...(opts.providers || {}) }, fetchImpl: opts.tileFetch || globalThis.fetch, now, log: m => log(m) });

  // ---- demo mode: a made-up family in its own engine (lib/demo.js); never mixed with real data, never pushed
  let demo = null;
  const demoOn = () => !!(cfg.demo || S().demo);
  function demoWorld() {
    if (demoOn()) { if (!demo) { demo = createDemo({ timeZone: S().timeZone || 'UTC', now, liveMs: opts.demoLiveMs ?? 10000 }); log('demo mode on: the map shows a made-up family'); } return demo; }
    if (demo) { demo.stop(); demo = null; log('demo mode off'); }
    return null;
  }
  const sessions = createSessions({ now });
  const loginFails = createLimiter({ max: 10, now });
  const pubFails = createLimiter({ max: 30, now });
  const downloads = new Map();   // one-time .otrc links: id -> { text, name, expires }

  const tz = () => S().timeZone || 'UTC';
  const person = id => C.people.find(p => p.id === id);
  const place = id => C.places.find(p => p.id === id);

  // ---- requests
  const clientIp = req => {
    const sock = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (cfg.trustProxy === 'cloudflare' && FROM_TUNNEL(sock) && req.headers['cf-connecting-ip']) return String(req.headers['cf-connecting-ip']).trim().slice(0, 64);
    return sock;
  };
  // https as the browser sees it: TLS ends at the tunnel / proxy, which says so in X-Forwarded-Proto (trusted only from there)
  const isHttps = req => !!req.socket.encrypted || (FROM_TUNNEL(String(req.socket.remoteAddress || '').replace(/^::ffff:/, '')) && req.headers['x-forwarded-proto'] === 'https');
  const baseUrl = req => S().publicUrl || `${isHttps(req) ? 'https' : 'http'}://${String(req.headers.host || 'localhost').replace(/[^a-zA-Z0-9.:\-\[\]]/g, '')}`;

  // tiles the browser loads straight from a provider (custom street tiles, keyed satellite sources); the built-in
  // no-key sources come through this server's cache (/tiles/...), which is 'self'
  const tileOrigin = () => directOrigins(resolveStyles(S())).join(' ');
  function headers(type, extra = {}) {
    return {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',   // the tile server gets our origin, as OSM's policy asks
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self'; img-src ${['\'self\'', 'data:', tileOrigin()].filter(Boolean).join(' ')}; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
      ...extra,
    };
  }
  const json = (res, code, obj, extra) => { res.writeHead(code, headers('application/json; charset=utf-8', extra)); res.end(JSON.stringify(obj)); };
  const fail = (res, code, error) => json(res, code, { error });

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const parts = []; let n = 0;
      req.on('data', c => { n += c.length; if (n > limit) { reject(Object.assign(new Error('too big'), { code: 413 })); req.destroy(); } else parts.push(c); });
      req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      req.on('error', reject);
    });
  }
  const cookie = (req, name) => { const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(String(req.headers.cookie || '')); return m ? m[1] : null; };
  const sessionCookie = (req, id, maxAge) => `hp_session=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

  // ---- what a viewer may see: nobody's position while they've paused sharing (not even the admin's)
  const visible = p => !p.paused;
  function publicPerson(p) {
    const out = { id: p.id, name: p.name, tid: p.tid, color: p.color, paused: !!p.paused };
    if (!visible(p)) return out;
    const last = store.state.last[p.id];
    if (last) out.last = { lat: last.lat, lon: last.lon, acc: last.acc, batt: last.batt, bs: last.bs, vel: last.vel, tst: last.tst, conn: last.conn };
    const at = store.state.at[p.id];
    if (at && place(at)) out.at = place(at).name;
    return out;
  }
  const visibleFeed = (n = 60) => store.state.feed.filter(a => { const p = person(a.person); return p && visible(p); }).slice(0, n);
  const publicPlace = p => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, radius: p.radius });

  function viewersOf() {
    return C.people.filter(p => p.passwordHash).map(p => p.name);
  }
  function sharingFor(p) {
    const s = S();
    return {
      paused: !!p.paused,
      shared: ['Your position and how accurate it is', 'Battery level and whether it is charging', 'Speed', 'When your phone last sent an update', "Today's track (and earlier days kept for " + s.retentionDays + ' days)', 'Arrivals at and departures from Places'],
      viewers: viewersOf().filter(n => n !== p.name),
      admin: true,
      pushes: [validUrl(s.discordWebhook) ? 'a Discord channel (webhook)' : null, s.ntfyTopic ? 'an ntfy topic' : null].filter(Boolean),
      retentionDays: s.retentionDays,
      encrypted: !!p.encrypt,
      devices: (p.devices || []).map(d => ({ id: d.id, name: d.name, lastSeen: d.lastSeen || null, plaintextRefused: !!d.plaintextRefused })),
      quiet: p.quiet || null,
      days: store.days(p.id).length,
    };
  }

  // a new phone token -> everything the phone needs, shown once
  function phoneSetup(req, p, deviceId, deviceName) {
    p.devices ||= [];
    let d = p.devices.find(x => x.id === deviceId);
    if (!d) { d = { id: deviceId, name: deviceName || 'Phone', created: now() }; p.devices.push(d); }
    const token = newToken(32);
    d.tokenHash = tokenHash(token); d.plaintextRefused = false;
    if (p.encrypt && !p.encryptionKey) p.encryptionKey = newToken(24);
    store.saveConfig();
    const conf = phoneConfig({ person: p, device: d, token, url: baseUrl(req) + '/pub' });
    const text = JSON.stringify(conf, null, 2);
    const id = newToken(18);
    downloads.set(id, { text, name: `${p.user}-${d.id}.otrc`, expires: now() + 30 * 60000 });
    const link = inlineLink(conf);
    log(`phone set up for ${p.user} (${d.id})`);
    return { user: p.user, device: d.id, url: conf.url, token, encrypted: !!conf.encryptionKey, inline: link, otrc: `${baseUrl(req)}/otrc/${id}`, qr: toSvg(qrEncode(link)) };
  }

  // ---- OwnTracks HTTP mode
  async function handlePub(req, res) {
    const ip = clientIp(req);
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
    if (pubFails.blocked(ip)) return fail(res, 429, 'too many failed sign-ins');
    const cred = parseBasic(req.headers.authorization);
    const p = cred && C.people.find(x => x.user === String(cred.user).toLowerCase());
    const dev = p && (p.devices || []).find(d => tokenMatches(cred.pass, d.tokenHash));
    if (!dev) { pubFails.fail(ip); log('OwnTracks sign-in refused'); res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Hallow Places"' }); return res.end(); }
    let text;
    try { text = await readBody(req, 64 * 1024); } catch (e) { return fail(res, e.code || 400, 'body'); }
    const r = parseMessage(text, p.encryptionKey);
    if (r.error) { log(`message from ${p.user} ignored: ${r.error}`); return json(res, 200, []); }   // a 4xx makes the phone resend forever
    dev.lastSeen = now();
    if (p.encrypt && !r.encrypted) {
      // this person's phone should be sealing its messages: drop it, and tell the admin page to show a new QR
      if (!dev.plaintextRefused) { dev.plaintextRefused = true; store.saveConfig(); log(`unencrypted message from ${p.user} dropped (encryption is on)`); }
      return json(res, 200, []);
    }
    if (dev.plaintextRefused) { dev.plaintextRefused = false; store.saveConfig(); }
    const m = r.msg;
    if ((m._type === 'location' || m._type === 'transition') && !p.paused) {
      const fix = toFix(m, Math.floor(now() / 1000));
      if (fix) {
        if (fix.transition) { const pl = placeForTransition(fix, C.places); if (pl) fix.place = pl.id; }
        store.appendFix(p.id, localTime(fix.tst * 1000, tz()).date, fix);
        const prev = store.state.last[p.id];
        if (!prev || fix.tst >= prev.tst - 1 || fix.transition) {
          if (!fix.transition || fix.place) engine.onFix(p, fix);
        }
      }
    }
    // reply: the rest of the family (not paused) and the Places as regions when they changed
    const items = [];
    if (S().familyInOwnTracks) for (const o of C.people) { const last = store.state.last[o.id]; if (o.id !== p.id && visible(o) && last) items.push(...friendItems(o, last)); }
    if (C.places.length) {
      const ver = crypto.createHash('sha256').update(JSON.stringify(C.places.map(x => [x.tst, x.name, x.lat, x.lon, x.radius]))).digest('hex').slice(0, 16);
      const pushed = (store.state.pushedPlaces[p.id] ||= {});
      if (pushed[dev.id] !== ver) { items.push(setWaypointsCmd(C.places)); pushed[dev.id] = ver; store.saveState(); }
    }
    return json(res, 200, reply(items, r.encrypted ? p.encryptionKey : null));
  }

  // ---- validation helpers for the admin
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const fin = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
  const daysFrom = d => Array.isArray(d) ? [...new Set(d.map(Number).filter(x => Number.isInteger(x) && x >= 0 && x <= 6))].sort() : [];
  function quietFrom(q) {
    if (!q || (!q.from && !q.to)) return null;
    if (!HM_RE.test(q.from) || !HM_RE.test(q.to)) throw new Error('quiet hours look like 22:00 - 07:00');
    const out = { from: q.from, to: q.to };
    const days = daysFrom(q.days); if (days.length && days.length < 7) out.days = days;
    return out;
  }
  function cleanRule(b) {
    if (!RULE_TYPES.includes(b.type)) throw new Error('unknown rule type');
    const r = { id: b.id && C.rules.some(x => x.id === b.id) ? b.id : 'r-' + newToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x'), type: b.type, enabled: b.enabled !== false };
    r.person = b.person === '*' || person(b.person) ? b.person : (() => { throw new Error('pick a person'); })();
    if (['arrive', 'leave', 'notLeft', 'notArrived'].includes(b.type)) r.place = b.place === '*' || place(b.place) ? b.place : (() => { throw new Error('pick a Place'); })();
    if (b.type === 'notLeft' || b.type === 'notArrived') {
      if (!HM_RE.test(b.time)) throw new Error('time looks like 08:15');
      r.time = b.time;
      r.days = daysFrom(b.days);
      if (b.type === 'notArrived' && b.after) { if (!HM_RE.test(b.after)) throw new Error('"since" looks like 07:00'); r.after = b.after; }
    }
    // per-place schedules for arrive / leave: weekdays and an optional time window ("only on school days, 07:00-09:00")
    if (b.type === 'arrive' || b.type === 'leave') {
      const days = daysFrom(b.days); if (days.length && days.length < 7) r.days = days;
      if (b.from || b.to) {
        if ((b.from && !HM_RE.test(b.from)) || (b.to && !HM_RE.test(b.to))) throw new Error('times look like 07:00');
        if (b.from) r.from = b.from; if (b.to) r.to = b.to;
      }
    }
    if (['arrive', 'leave', 'notLeft', 'notArrived'].includes(b.type) && b.skipHolidays) r.skipHolidays = true;
    if (b.urgent) r.urgent = true;   // pushed even in the person's quiet hours
    if (b.type === 'battery') {
      r.below = fin(b.below, 1, 99); if (r.below == null) throw new Error('battery: 1-99%');
      if (b.critical !== undefined && b.critical !== '' && b.critical !== null) { r.critical = fin(b.critical, 1, 98); if (r.critical == null || r.critical >= r.below) throw new Error('critical battery: under the first line'); }
    }
    if (b.type === 'noUpdate' || b.type === 'stationary') { r.hours = fin(b.hours, 0.25, 168); if (r.hours == null) throw new Error('hours: 0.25-168'); }
    return r;
  }

  // ---- web API
  async function handleApi(req, res, u) {
    const ip = clientIp(req);
    const sid = cookie(req, 'hp_session');
    const sess = sessions.get(sid);
    let who = sess ? sess.who : null;
    if (who === 'demo' && !demoOn()) { sessions.drop(sid); who = null; }   // a demo look ends with demo mode
    const me = who && who !== 'admin' && who !== 'demo' ? person(who) : null;
    if (who && who !== 'admin' && who !== 'demo' && !me) { sessions.drop(sid); }
    const signedIn = who === 'admin' || who === 'demo' || !!me;
    let body = {};
    if (req.method === 'POST') {
      if (req.headers['x-hallow'] !== '1') return fail(res, 403, 'missing header');   // no cross-site form posts
      try { const t = await readBody(req, 256 * 1024); body = t ? JSON.parse(t) : {}; } catch (e) { return fail(res, e.code === 413 ? 413 : 400, 'bad request'); }
      if (!body || typeof body !== 'object') body = {};
    } else if (req.method !== 'GET') return fail(res, 405, 'method');
    const route = req.method + ' ' + u.pathname;

    if (route === 'GET /api/session') return json(res, 200, { signedIn, admin: who === 'admin', demoViewer: who === 'demo', demo: demoOn(), id: me?.id || null, name: who === 'admin' ? 'Admin' : who === 'demo' ? 'Demo' : me?.name || null, needsSetup: !C.admin.hash, version: VERSION });
    // demo mode: anyone may look at the MADE-UP family without a password (real data is never shown to a demo session)
    if (route === 'POST /api/demo') {
      if (!demoOn()) return fail(res, 404, 'demo mode is off');
      return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, sessions.create('demo'), 86400) });
    }
    if (route === 'POST /api/setup') {
      if (C.admin.hash) return fail(res, 409, 'already set up');
      if (loginFails.blocked(ip)) return fail(res, 429, 'Too many tries - wait 10 minutes');
      if (!setupCode || str(body.code, 20) !== setupCode) { loginFails.fail(ip); return fail(res, 403, 'Wrong setup code (it is in the container log)'); }
      if (String(body.password || '').length < 10) return fail(res, 400, 'Use at least 10 characters');
      C.admin.hash = hashPassword(body.password); store.saveConfig();
      log('admin password set');
      return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, sessions.create('admin'), 30 * 86400) });
    }
    if (route === 'POST /api/login') {
      if (loginFails.blocked(ip)) return fail(res, 429, 'Too many tries - wait 10 minutes');
      const user = str(body.user, 40).toLowerCase(), pw = String(body.password || '');
      let id = null;
      if (user === 'admin') { if (verifyPassword(pw, C.admin.hash)) id = 'admin'; }
      else { const p = C.people.find(x => x.user === user); if (verifyPassword(pw, p?.passwordHash)) id = p.id; }
      if (!id) { loginFails.fail(ip); log('web sign-in refused'); return fail(res, 401, 'Wrong name or password'); }
      loginFails.clear(ip);
      return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, sessions.create(id), 30 * 86400) });
    }
    if (route === 'POST /api/logout') { sessions.drop(sid); return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, 'x', 0) }); }
    if (!signedIn) return fail(res, 401, 'sign in');

    const s = S();
    const dw = demoWorld();
    if (who === 'demo' && !['GET /api/map', 'GET /api/track', 'GET /api/feed'].includes(route)) return fail(res, 403, 'demo: look only');
    if (route === 'GET /api/map') {
      const st = resolveStyles(s);
      const map = { styles: st.styles, defaultStyle: st.default, satellite: st.satellite, satelliteNote: st.note, maxZoom: s.maxZoom };
      if (dw) return json(res, 200, { me: who === 'admin' ? 'admin' : who === 'demo' ? 'demo' : me.id, demo: true, map, timeZone: tz(), retentionDays: s.retentionDays, ...dw.map(), now: now() });
      return json(res, 200, {
        me: who === 'admin' ? 'admin' : me.id,
        map, timeZone: tz(), retentionDays: s.retentionDays,
        people: C.people.map(publicPerson), places: C.places.map(publicPlace), feed: visibleFeed(), now: now(),
      });
    }
    if (dw && route === 'GET /api/track') {
      const t = dw.track(u.searchParams.get('person'), u.searchParams.get('date'));
      return json(res, 200, t ? { person: u.searchParams.get('person'), ...t } : { points: [] });
    }
    if (dw && route === 'GET /api/feed') return json(res, 200, { feed: dw.feed(300), demo: true });
    if (route === 'GET /api/track') {
      const p = person(u.searchParams.get('person'));
      if (!p || !visible(p)) return json(res, 200, { points: [] });
      const date = u.searchParams.get('date') || localTime(now(), tz()).date;
      const pts = store.readDay(p.id, date).filter(f => !(f.acc > s.maxAccuracy * 2)).map(f => [f.lat, f.lon, f.tst, f.acc ?? null]);
      return json(res, 200, { person: p.id, date, points: pts, days: store.days(p.id) });
    }
    if (route === 'GET /api/feed') return json(res, 200, { feed: visibleFeed(300) });

    // ---- the signed-in person's own page
    if (u.pathname.startsWith('/api/me')) {
      if (!me) return fail(res, 400, 'the admin has no sharing of their own');
      if (route === 'GET /api/me') return json(res, 200, { id: me.id, name: me.name, user: me.user, ...sharingFor(me) });
      if (route === 'POST /api/me/pause') {
        me.paused = !!body.paused; me.pausedAt = me.paused ? now() : null; store.saveConfig();
        log(`${me.user} ${me.paused ? 'paused' : 'resumed'} sharing`);
        return json(res, 200, { ok: true, paused: me.paused });
      }
      if (route === 'POST /api/me/delete-history') { const n = store.deleteHistory(me.id); engine.forget(me.id); store.flush(); log(`${me.user} deleted their history`); return json(res, 200, { ok: true, days: n }); }
      if (route === 'POST /api/me/quiet') { try { me.quiet = quietFrom(body.quiet); } catch (e) { return fail(res, 400, e.message); } store.saveConfig(); return json(res, 200, { ok: true, quiet: me.quiet }); }
      if (route === 'POST /api/me/password') {
        if (!verifyPassword(String(body.old || ''), me.passwordHash)) return fail(res, 403, 'Your current password is wrong');
        if (String(body.password || '').length < 8) return fail(res, 400, 'Use at least 8 characters');
        me.passwordHash = hashPassword(body.password); store.saveConfig(); sessions.dropWho(me.id);
        return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, sessions.create(me.id), 30 * 86400) });
      }
      if (route === 'POST /api/me/phone') return json(res, 200, phoneSetup(req, me, str(body.device, 20).toLowerCase().replace(/[^a-z0-9-]/g, '') || 'phone', str(body.name, 40)));
      return fail(res, 404, 'not found');
    }

    // ---- admin
    if (!u.pathname.startsWith('/api/admin')) return fail(res, 404, 'not found');
    if (who !== 'admin') return fail(res, 403, 'admin only');
    try {
      if (route === 'GET /api/admin') {
        return json(res, 200, {
          people: C.people.map(p => ({ id: p.id, user: p.user, name: p.name, tid: p.tid, color: p.color, hasPassword: !!p.passwordHash, encrypt: !!p.encrypt, paused: !!p.paused, quiet: p.quiet || null, days: store.days(p.id).length, devices: (p.devices || []).map(d => ({ id: d.id, name: d.name, lastSeen: d.lastSeen || null, plaintextRefused: !!d.plaintextRefused })) })),
          places: C.places.map(publicPlace), rules: C.rules, ruleTypes: RULE_TYPES,
          settings: { ...s, discordWebhook: undefined, ntfyToken: undefined, esriKey: undefined, maptilerKey: undefined, discordWebhookSet: validUrl(s.discordWebhook), ntfyTokenSet: !!s.ntfyToken, esriKeySet: !!s.esriKey, maptilerKeySet: !!s.maptilerKey },
          satellites: SATELLITES.map(id => ({ id, name: PROVIDERS[id].name, key: PROVIDERS[id].key || null, help: KEY_HELP[id] || null, attribution: PROVIDERS[id].attribution })),
          demo: { on: demoOn(), fromEnv: !!cfg.demo },
          tiles: { ...tileCache.stats },
        });
      }
      if (route === 'POST /api/admin/person') {
        const name = str(body.name, 40); if (!name) throw new Error('a name, please');
        let p = body.id ? person(body.id) : null;
        if (body.id && !p) throw new Error('no such person');
        if (!p) {
          const user = (str(body.user, 24) || name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'person';
          if (!USER_RE.test(user) || user === 'admin') throw new Error('user name: letters, digits and -');
          if (C.people.some(x => x.user === user)) throw new Error('that user name is taken');
          p = { id: user, user, created: now(), devices: [], encrypt: true, encryptionKey: newToken(24), paused: false };
          p.color = COLORS[C.people.length % COLORS.length];
          C.people.push(p);
        }
        p.name = name;
        p.tid = (str(body.tid, 2) || name.slice(0, 2)).toUpperCase();
        if (/^#[0-9a-fA-F]{6}$/.test(body.color || '')) p.color = body.color;
        if (body.encrypt !== undefined) { p.encrypt = !!body.encrypt; if (p.encrypt && !p.encryptionKey) p.encryptionKey = newToken(24); }
        if (body.quiet !== undefined) p.quiet = quietFrom(body.quiet);
        if (body.password) { if (String(body.password).length < 8) throw new Error('password: at least 8 characters'); p.passwordHash = hashPassword(body.password); sessions.dropWho(p.id); }
        if (body.noLogin) { p.passwordHash = null; sessions.dropWho(p.id); }
        store.saveConfig();
        return json(res, 200, { ok: true, id: p.id });
      }
      if (route === 'POST /api/admin/person/delete') {
        const p = person(body.id); if (!p) throw new Error('no such person');
        store.deleteHistory(p.id); engine.forget(p.id); sessions.dropWho(p.id);
        C.people = C.people.filter(x => x !== p);
        C.rules = C.rules.filter(r => r.person !== p.id);
        store.saveConfig(); store.flush();
        return json(res, 200, { ok: true });
      }
      if (route === 'POST /api/admin/person/phone') {
        const p = person(body.id); if (!p) throw new Error('no such person');
        return json(res, 200, phoneSetup(req, p, str(body.device, 20).toLowerCase().replace(/[^a-z0-9-]/g, '') || 'phone', str(body.name, 40)));
      }
      if (route === 'POST /api/admin/person/device-delete') {
        const p = person(body.id); if (!p) throw new Error('no such person');
        p.devices = (p.devices || []).filter(d => d.id !== body.device); store.saveConfig();
        return json(res, 200, { ok: true });
      }
      if (route === 'POST /api/admin/person/history-delete') {
        const p = person(body.id); if (!p) throw new Error('no such person');
        const n = store.deleteHistory(p.id); engine.forget(p.id); store.flush();
        return json(res, 200, { ok: true, days: n });
      }
      if (route === 'POST /api/admin/person/pause') {
        // the admin may pause someone (more privacy), but only the person can resume their own sharing
        const p = person(body.id); if (!p) throw new Error('no such person');
        p.paused = true; p.pausedAt = now(); store.saveConfig();
        return json(res, 200, { ok: true });
      }
      if (route === 'POST /api/admin/place') {
        const name = str(body.name, 40); if (!name) throw new Error('a name, please');
        const lat = fin(body.lat, -90, 90), lon = fin(body.lon, -180, 180), radius = fin(body.radius, 25, 5000);
        if (lat == null || lon == null) throw new Error('latitude / longitude');
        if (radius == null) throw new Error('radius: 25-5000 m');
        let pl = body.id ? place(body.id) : null;
        if (body.id && !pl) throw new Error('no such Place');
        if (!pl) {
          let tst = Math.floor(now() / 1000); while (C.places.some(x => x.tst === tst)) tst++;
          pl = { id: 'pl-' + newToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x'), tst };
          C.places.push(pl);
        }
        const moved = pl.lat !== lat || pl.lon !== lon || pl.radius !== radius;
        Object.assign(pl, { name, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, radius: Math.round(radius) });
        if (moved) for (const g of Object.values(store.state.geo)) delete g[pl.id];   // start fresh, silently
        store.saveConfig();
        return json(res, 200, { ok: true, id: pl.id });
      }
      if (route === 'POST /api/admin/place/delete') {
        if (!place(body.id)) throw new Error('no such Place');
        C.places = C.places.filter(x => x.id !== body.id);
        C.rules = C.rules.filter(r => r.place !== body.id);
        for (const g of Object.values(store.state.geo)) delete g[body.id];
        store.saveConfig();
        return json(res, 200, { ok: true });
      }
      if (route === 'POST /api/admin/rule') {
        const r = cleanRule(body);
        const i = C.rules.findIndex(x => x.id === r.id);
        if (i >= 0) C.rules[i] = r; else C.rules.push(r);
        store.saveConfig();
        return json(res, 200, { ok: true, id: r.id });
      }
      if (route === 'POST /api/admin/rule/delete') { C.rules = C.rules.filter(r => r.id !== body.id); store.saveConfig(); return json(res, 200, { ok: true }); }
      if (route === 'POST /api/admin/settings') {
        const n = { ...s };
        if (body.retentionDays !== undefined) { n.retentionDays = fin(body.retentionDays, 1, 3650); if (n.retentionDays == null) throw new Error('keep history: 1-3650 days'); }
        if (body.tileUrl !== undefined) { const t = str(body.tileUrl, 300); if (!/^https?:\/\/[^\s"'<>]+$/.test(t) || !t.includes('{z}') || !t.includes('{x}') || !t.includes('{y}')) throw new Error('tile URL needs {z}, {x} and {y}'); n.tileUrl = t; }
        if (body.tileAttribution !== undefined) n.tileAttribution = str(body.tileAttribution, 200);
        if (body.tileAttributionUrl !== undefined) { const t = str(body.tileAttributionUrl, 300); if (t && !validUrl(t)) throw new Error('attribution link'); n.tileAttributionUrl = t; }
        if (body.maxZoom !== undefined) { n.maxZoom = fin(body.maxZoom, 1, 22); if (n.maxZoom == null) throw new Error('max zoom 1-22'); }
        if (body.publicUrl !== undefined) { const t = str(body.publicUrl, 200).replace(/\/+$/, ''); if (t && !/^https?:\/\/[a-z0-9.\-]+(:\d+)?$/i.test(t)) throw new Error('public address looks like https://places.example.com'); n.publicUrl = t; }
        if (body.timeZone !== undefined) { if (!validTz(body.timeZone)) throw new Error('unknown time zone'); n.timeZone = body.timeZone; }
        for (const [k, lo, hi] of [['maxAccuracy', 10, 2000], ['leaveMinutes', 1, 60], ['leaveMeters', 50, 5000], ['cooldownMinutes', 0, 1440], ['arriveMinutes', 0, 30], ['exitFactor', 1, 4], ['exitExtra', 0, 1000], ['tileCacheMB', 20, 20000]]) if (body[k] !== undefined) { n[k] = fin(body[k], lo, hi); if (n[k] == null) throw new Error(`${k}: ${lo}-${hi}`); }
        if (body.holidays !== undefined) {
          const list = (Array.isArray(body.holidays) ? body.holidays : String(body.holidays).split(/[\s,;]+/)).map(x => String(x).trim()).filter(Boolean);
          if (list.length > 200 || list.some(x => !/^\d{4}-\d{2}-\d{2}$/.test(x) || Number.isNaN(Date.parse(x + 'T00:00:00Z')))) throw new Error('holidays: dates like 2026-12-24, separated by spaces or commas');
          n.holidays = [...new Set(list)].sort();
        }
        if (body.mapStyle !== undefined) { if (!STYLES.includes(body.mapStyle)) throw new Error('map style: street, satellite or hybrid'); n.mapStyle = body.mapStyle; }
        if (body.esriKey !== undefined) n.esriKey = str(body.esriKey, 400).replace(/[^A-Za-z0-9._\-~]/g, '');
        if (body.maptilerKey !== undefined) n.maptilerKey = str(body.maptilerKey, 200).replace(/[^A-Za-z0-9._\-~]/g, '');
        if (body.satellite !== undefined) {
          if (!SATELLITES.includes(body.satellite)) throw new Error('unknown satellite source');
          const k = PROVIDERS[body.satellite].key;
          if (k && !n[k]) throw new Error(`${PROVIDERS[body.satellite].name}: paste its key first`);
          n.satellite = body.satellite;
        }
        if (body.tileCache !== undefined) n.tileCache = !!body.tileCache;
        if (body.demo !== undefined) n.demo = !!body.demo;
        if (body.discordWebhook !== undefined) { const t = str(body.discordWebhook, 500); if (t && !validUrl(t)) throw new Error('Discord webhook URL'); n.discordWebhook = t; }
        if (body.ntfyServer !== undefined) { const t = str(body.ntfyServer, 200).replace(/\/+$/, '') || 'https://ntfy.sh'; if (!validUrl(t)) throw new Error('ntfy server'); n.ntfyServer = t; }
        if (body.ntfyTopic !== undefined) { const t = str(body.ntfyTopic, 64); if (t && !/^[A-Za-z0-9_-]+$/.test(t)) throw new Error('ntfy topic: letters, digits, - and _'); n.ntfyTopic = t; }
        if (body.ntfyToken !== undefined) n.ntfyToken = str(body.ntfyToken, 200);
        if (body.familyInOwnTracks !== undefined) n.familyInOwnTracks = !!body.familyInOwnTracks;
        C.settings = n; store.saveConfig();
        demoWorld();   // starts or stops the made-up family right away
        return json(res, 200, { ok: true });
      }
      if (route === 'POST /api/admin/test-push') {
        const r = await notifier.send({ kind: 'test', text: 'Hallow Places test: alerts reach this channel.' });
        return json(res, 200, r);
      }
      if (route === 'POST /api/admin/password') {
        if (!verifyPassword(String(body.old || ''), C.admin.hash)) throw new Error('current password is wrong');
        if (String(body.password || '').length < 10) throw new Error('use at least 10 characters');
        C.admin.hash = hashPassword(body.password); store.saveConfig(); sessions.dropWho('admin');
        return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, sessions.create('admin'), 30 * 86400) });
      }
    } catch (e) { return fail(res, 400, e.message); }
    return fail(res, 404, 'not found');
  }

  // ---- static files
  const PUB = path.join(HERE, 'public');
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
  const FILES = new Set(['index.html', 'app.js', 'map.js', 'app.css', 'icon.svg', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest']);

  const server = http.createServer(async (req, res) => {
    let u;
    try { u = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
    try {
      if (u.pathname === '/pub' || u.pathname === '/pub/') return await handlePub(req, res);
      if (u.pathname.startsWith('/api/')) return await handleApi(req, res, u);
      if (u.pathname === '/healthz') return json(res, 200, { ok: true, app: 'Hallow Places', version: VERSION, uptime: Math.round(process.uptime()) });
      if (u.pathname.startsWith('/tiles/')) {
        // the tile cache, for signed-in browsers only (also demo viewers) - never an open proxy
        const sess = sessions.get(cookie(req, 'hp_session'));
        if (!sess || (sess.who === 'demo' && !demoOn())) { res.writeHead(401, headers('text/plain; charset=utf-8')); return res.end(); }
        const m = /^\/tiles\/([a-zA-Z]+)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})$/.exec(u.pathname);
        if (!m || req.method !== 'GET' || S().tileCache === false) { res.writeHead(404, headers('text/plain; charset=utf-8')); return res.end(); }
        const r = await tileCache.get(m[1], Number(m[2]), Number(m[3]), Number(m[4]));
        if (r.status !== 200) { res.writeHead(r.status, headers('text/plain; charset=utf-8')); return res.end(); }
        res.writeHead(200, headers(r.type, { 'Cache-Control': 'private, max-age=86400' }));
        return res.end(r.body);
      }
      if (u.pathname.startsWith('/otrc/')) {
        const id = u.pathname.slice(6), d = downloads.get(id);
        if (!d || d.expires < now()) { downloads.delete(id); res.writeHead(410, headers('text/plain; charset=utf-8')); return res.end('This setup link has expired. Make a new one on the Hallow Places page.'); }
        downloads.delete(id);   // one use
        res.writeHead(200, headers('application/octet-stream', { 'Content-Disposition': `attachment; filename="${d.name}"` }));
        return res.end(d.text);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      const name = u.pathname === '/' || u.pathname === '/admin' || u.pathname === '/me' ? 'index.html' : u.pathname.slice(1);
      if (!FILES.has(name)) { res.writeHead(404, headers('text/plain; charset=utf-8')); return res.end('Not found'); }
      const body = await fs.promises.readFile(path.join(PUB, name)).catch(() => null);
      if (!body) { res.writeHead(404, headers('text/plain; charset=utf-8')); return res.end('Not found'); }
      res.writeHead(200, headers(TYPES[path.extname(name)] || 'application/octet-stream', { 'Cache-Control': 'no-cache' }));
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      log('request error:', e.message);
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    }
  });

  // ---- every minute: alerts that depend on time; every hour: retention and expired links
  const tick = () => { try { engine.tick(); } catch (e) { log('tick error:', e.message); } };
  const sweep = () => {
    try { const n = store.sweep(S().retentionDays, localTime(now(), tz()).date); if (n) log(`retention: removed ${n} old day file(s)`); } catch (e) { log('retention error:', e.message); }
    for (const [k, d] of downloads) if (d.expires < now()) downloads.delete(k);
    try { const t = tileCache.trim(S().tileCacheMB || 500); if (t.removed) log(`tiles: trimmed ${t.removed} old tile(s) from the cache`); } catch (e) { log('tile cache error:', e.message); }
  };
  const t1 = setInterval(tick, opts.tickMs || 60000); t1.unref?.();
  const t2 = setInterval(sweep, opts.sweepMs || 3600000); t2.unref?.();
  sweep();
  server.on('close', () => { clearInterval(t1); clearInterval(t2); demo?.stop(); store.flush(); });
  demoWorld();

  return {
    server, store, engine, cfg, setupCode, tick, sweep,
    listen: (port = cfg.port, host = cfg.host) => new Promise(r => server.listen(port, host, () => r(server.address().port))),
    close: () => new Promise(r => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

function validTz(z) { try { new Intl.DateTimeFormat('en', { timeZone: String(z) }); return true; } catch { return false; } }

// node server.js
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = config();
  const app = createServer(cfg);
  app.listen().then(p => console.log(`Hallow Places ${VERSION} on ${cfg.host}:${p}, data in ${cfg.dataDir}` + (app.store.config.settings.publicUrl ? ` (public address ${app.store.config.settings.publicUrl})` : '') + (cfg.demo || app.store.config.settings.demo ? ' - DEMO MODE: the map shows a made-up family (open the page and choose "Look at the demo")' : '')));
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
