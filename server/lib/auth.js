// Passwords (scrypt), phone tokens (long random, only their SHA-256 is kept), web sessions and failure limits.
import crypto from 'node:crypto';

const N = 16384, R = 8, P = 1, LEN = 32;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw).normalize('NFKC'), salt, LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${h.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([^$]+)\$([^$]+)$/.exec(String(stored || ''));
  if (!m) { crypto.scryptSync('x', 'dummy-salt-value', LEN, { N, r: R, p: P }); return false; }   // same time either way
  const want = Buffer.from(m[5], 'base64');
  const got = crypto.scryptSync(String(pw).normalize('NFKC'), Buffer.from(m[4], 'base64'), want.length, { N: +m[1], r: +m[2], p: +m[3], maxmem: 64 * 1024 * 1024 });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export const newToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const tokenHash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
export function tokenMatches(t, hash) {
  if (typeof hash !== 'string' || hash.length !== 64) return false;
  return crypto.timingSafeEqual(Buffer.from(tokenHash(t), 'hex'), Buffer.from(hash, 'hex'));
}

// HTTP Basic: { user, pass } or null
export function parseBasic(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(String(header || ''));
  if (!m) return null;
  const s = Buffer.from(m[1], 'base64').toString('utf8');
  const i = s.indexOf(':');
  return i < 0 ? null : { user: s.slice(0, i), pass: s.slice(i + 1) };
}

// in-memory web sessions (signing in again after a server restart is fine for a family)
export function createSessions({ ttlMs = 30 * 86400000, now = () => Date.now() } = {}) {
  const map = new Map();   // sha256(id) -> { who, created, seen }
  return {
    create(who) { const id = newToken(32); map.set(tokenHash(id), { who, created: now(), seen: now() }); return id; },
    get(id) {
      if (!id) return null;
      const k = tokenHash(id), s = map.get(k);
      if (!s) return null;
      if (now() - s.seen > ttlMs) { map.delete(k); return null; }
      s.seen = now();
      return s;
    },
    drop(id) { if (id) map.delete(tokenHash(id)); },
    dropWho(who) { for (const [k, s] of map) if (s.who === who) map.delete(k); },
    size: () => map.size,
  };
}

// at most `max` failures per key in `windowMs`
export function createLimiter({ max = 10, windowMs = 10 * 60000, now = () => Date.now() } = {}) {
  const fails = new Map();
  const list = k => { const t = now(), l = (fails.get(k) || []).filter(x => t - x < windowMs); fails.set(k, l); return l; };
  return {
    blocked: k => list(k).length >= max,
    fail: k => { list(k).push(now()); },
    clear: k => fails.delete(k),
  };
}
