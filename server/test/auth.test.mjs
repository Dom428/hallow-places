import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, newToken, tokenHash, tokenMatches, parseBasic, createSessions, createLimiter } from '../lib/auth.js';

test('passwords: scrypt hashes, right / wrong / malformed, Unicode normalised', () => {
  const h = hashPassword('correct horse battery');
  assert.match(h, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.notEqual(h, hashPassword('correct horse battery'), 'salted');
  assert.equal(verifyPassword('correct horse battery', h), true);
  assert.equal(verifyPassword('correct horse batterY', h), false);
  assert.equal(verifyPassword('', h), false);
  assert.equal(verifyPassword('x', 'plain-text'), false);
  assert.equal(verifyPassword('x', undefined), false);
  assert.equal(verifyPassword('Café', hashPassword('Café')), true, 'NFKC');
});

test('phone tokens: long, random, only the hash is kept and compared in constant time', () => {
  const t = newToken();
  assert.ok(t.length >= 43 && /^[A-Za-z0-9_-]+$/.test(t));
  assert.notEqual(t, newToken());
  const h = tokenHash(t);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(tokenMatches(t, h), true);
  assert.equal(tokenMatches(t + 'x', h), false);
  assert.equal(tokenMatches(t, undefined), false);
  assert.equal(tokenMatches(t, 'short'), false);
});

test('HTTP Basic parsing', () => {
  const b = 'Basic ' + Buffer.from('mia:to:ken').toString('base64');
  assert.deepEqual(parseBasic(b), { user: 'mia', pass: 'to:ken' });
  assert.equal(parseBasic('Bearer abc'), null);
  assert.equal(parseBasic('Basic ' + Buffer.from('nocolon').toString('base64')), null);
  assert.equal(parseBasic(undefined), null);
});

test('sessions expire when unused; dropWho signs a person out everywhere', () => {
  let now = 0;
  const s = createSessions({ ttlMs: 1000, now: () => now });
  const a = s.create('mia'), b = s.create('mia'), c = s.create('admin');
  assert.equal(s.get(a).who, 'mia');
  now = 900; assert.ok(s.get(a)); assert.ok(s.get(c)); now = 1800; assert.ok(s.get(a), 'used = kept alive');
  assert.equal(s.get(b), null, 'unused for > ttl');
  s.dropWho('mia'); assert.equal(s.get(a), null); assert.ok(s.get(c));
  assert.equal(s.get('nonsense'), null); assert.equal(s.get(null), null);
});

test('failure limiter: blocks after max failures within the window', () => {
  let now = 0;
  const l = createLimiter({ max: 3, windowMs: 1000, now: () => now });
  l.fail('ip'); l.fail('ip'); assert.equal(l.blocked('ip'), false);
  l.fail('ip'); assert.equal(l.blocked('ip'), true); assert.equal(l.blocked('other'), false);
  now = 1001; assert.equal(l.blocked('ip'), false);
  l.fail('ip'); l.fail('ip'); l.fail('ip'); l.clear('ip'); assert.equal(l.blocked('ip'), false);
});
