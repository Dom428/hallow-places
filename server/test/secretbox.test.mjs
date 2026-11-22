import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { seal, open, poly1305, hsalsa20, owntracksKey, encryptOwnTracks, decryptOwnTracks } from '../lib/secretbox.js';

const h = s => Buffer.from(s.replace(/\s+/g, ''), 'hex');

// The NaCl reference test (tests/secretbox.c in NaCl / libsodium): "firstkey", the 24-byte nonce and the 131-byte message
const KEY = h('1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389');
const NONCE = h('69696ee955b62b73cd62bda875fc73d68219e0036b7a0b37');
const MSG = h(`be075fc53c81f2d5cf141316ebeb0c7b5228c52a4c62cbd44b66849b64244ffce5ecbaaf33bd751a1ac728d45e6c61296cdc3c01233561f41db66cce314adb310e3be8250c46f06dceea3a7fa1348057e2f6556ad6b1318a024a838f21af1fde048977eb48f59ffd4924ca1c60902e52f0a089bc76897040e082f937763848645e0705`);
const BOX = h(`f3ffc7703f9400e52a7dfb4b3d3305d98e993b9f48681273c29650ba32fc76ce48332ea7164d96a4476fb8c531a1186ac0dfc17c98dce87b4da7f011ec48c97271d2c20f9b928fe2270d6fb863d51738b48eeee314a7cc8ab932164548e526ae90224368517acfeabd6bb3732bc0e9da99832b61ca01b6de56244a9e88d5f9b37973f622a43d14a6599b1f654cb45a74e355a5`);

test('secretbox: NaCl reference vector (seal and open)', () => {
  assert.deepEqual(seal(MSG, NONCE, KEY), BOX);
  assert.deepEqual(open(BOX, NONCE, KEY), MSG);
});

test('HSalsa20: NaCl core test (the shared secret of the box test -> "firstkey")', () => {
  // tests/core1.c: shared secret 4a5d9d5b... with a zero nonce gives firstkey
  const shared = h('4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742');
  assert.deepEqual(hsalsa20(shared, Buffer.alloc(16)), KEY);
});

test('Poly1305: RFC 8439 section 2.5.2 vector', () => {
  const key = h('85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b');
  assert.equal(poly1305(Buffer.from('Cryptographic Forum Research Group'), key).toString('hex'), 'a8061dc1305136c6c22b8baf0c0127a9');
});

test("Poly1305: matches Node's own ChaCha20-Poly1305 tags (RFC 8439 construction) for 300 random messages", () => {
  const le64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const pad = n => Buffer.alloc((16 - (n % 16)) % 16);
  for (let i = 0; i < 300; i++) {
    const key = crypto.randomBytes(32), nonce = crypto.randomBytes(12), aad = crypto.randomBytes(i % 37), msg = crypto.randomBytes(i * 3);
    const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    c.setAAD(aad, { plaintextLength: msg.length });
    const ct = Buffer.concat([c.update(msg), c.final()]), tag = c.getAuthTag();
    const otk = crypto.createCipheriv('chacha20', key, Buffer.concat([Buffer.alloc(4), nonce])).update(Buffer.alloc(32));
    const macData = Buffer.concat([aad, pad(aad.length), ct, pad(ct.length), le64(aad.length), le64(ct.length)]);
    assert.deepEqual(poly1305(macData, otk), tag, `message ${i}`);
  }
});

test('secretbox: round trip for many lengths, and any change is refused', () => {
  for (const len of [0, 1, 15, 16, 17, 63, 64, 65, 200, 4097]) {
    const k = crypto.randomBytes(32), n = crypto.randomBytes(24), m = crypto.randomBytes(len);
    const b = seal(m, n, k);
    assert.equal(b.length, len + 16);
    assert.deepEqual(open(b, n, k), m);
    const bad = Buffer.from(b); bad[bad.length - 1 - (len ? 0 : 15)] ^= 1;
    assert.equal(open(bad, n, k), null, 'changed byte');
    assert.equal(open(b, crypto.randomBytes(24), k), null, 'wrong nonce');
    assert.equal(open(b, n, crypto.randomBytes(32)), null, 'wrong key');
  }
  assert.equal(open(Buffer.alloc(10), NONCE, KEY), null, 'too short');
});

test('OwnTracks: key is the passphrase zero-padded / cut to 32 bytes; encrypt / decrypt', () => {
  assert.deepEqual(owntracksKey('abc'), Buffer.concat([Buffer.from('abc'), Buffer.alloc(29)]));
  assert.deepEqual(owntracksKey('x'.repeat(40)), Buffer.from('x'.repeat(32)));
  const text = JSON.stringify({ _type: 'location', lat: 12.3456, lon: -32.1, tst: 1763280000 });
  const data = encryptOwnTracks(text, 'my family key');
  assert.equal(Buffer.from(data, 'base64').length, 24 + 16 + Buffer.byteLength(text));
  assert.equal(decryptOwnTracks(data, 'my family key'), text);
  assert.equal(decryptOwnTracks(data, 'another key'), null);
  assert.equal(decryptOwnTracks('bm90IGEgYm94', 'my family key'), null);
  assert.equal(decryptOwnTracks(undefined, 'k'), null);
  // what libsodium on the phone would make: nonce || crypto_secretbox_easy(m, nonce, key)
  const nonce = crypto.randomBytes(24);
  const phone = Buffer.concat([nonce, seal(Buffer.from(text), nonce, owntracksKey('my family key'))]).toString('base64');
  assert.equal(decryptOwnTracks(phone, 'my family key'), text);
});
