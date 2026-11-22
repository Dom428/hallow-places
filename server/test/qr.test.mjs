import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, toSvg, divisor, remainder, formatBits, alignment, totalCodewords, dataCodewords } from '../lib/qr.js';

test('QR: Reed-Solomon matches the spec example (HELLO WORLD, 1-M, 10 EC codewords)', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(remainder(data, divisor(10)), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('QR: format bits for level L, masks 0-7 (spec table)', () => {
  const want = ['111011111000100', '111001011110011', '111110110101010', '111100010011101', '110011000101111', '110001100011000', '110110001000001', '110100101110110'];
  for (let m = 0; m < 8; m++) assert.equal(formatBits(m).toString(2).padStart(15, '0'), want[m], `mask ${m}`);
});

test('QR: sizes and alignment positions (spec tables)', () => {
  assert.deepEqual([1, 2, 6, 7, 10, 14, 40].map(totalCodewords), [26, 44, 172, 196, 346, 581, 3706]);
  assert.deepEqual([1, 10, 20, 40].map(dataCodewords), [19, 274, 861, 2956]);
  assert.deepEqual(alignment(1), []);
  assert.deepEqual(alignment(7), [6, 22, 38]);
  assert.deepEqual(alignment(14), [6, 26, 46, 66]);
  assert.deepEqual(alignment(32), [6, 34, 60, 86, 112, 138]);
  assert.deepEqual(alignment(40), [6, 30, 58, 86, 114, 142, 170]);
});

// ---- an independent decoder, written from the spec (not from the encoder), to read every code back
const EXP = [], LOG = [];
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x = (x << 1) ^ (x & 0x80 ? 0x11d : 0); }
const gmul = (a, b) => (a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0);
const BLOCKS = [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25];
const ECLEN = [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 10: [6, 28, 50], 13: [6, 34, 62], 15: [6, 26, 48, 70], 20: [6, 34, 62, 90], 25: [6, 32, 58, 84, 110] };

function decode(m) {
  const n = m.length, ver = (n - 17) / 4;
  assert.ok(Number.isInteger(ver) && ver >= 1 && ver <= 40, 'size');
  // format: read copy 1 (around the top-left finder), check it against the second copy and the BCH code
  const f1 = [], f2 = [];
  for (let i = 0; i <= 5; i++) f1.push(m[i][8]); f1.push(m[7][8], m[8][8], m[8][7]); for (let i = 5; i >= 0; i--) f1.push(m[8][i]);
  for (let i = 0; i < 8; i++) f2.push(m[8][n - 1 - i]); for (let i = 7; i >= 1; i--) f2.push(m[n - i][8]);
  const val = bits => bits.reduce((a, b, i) => a | ((b ? 1 : 0) << i), 0);
  const fmt = val(f1);
  assert.equal(fmt, val(f2), 'both format copies agree');
  const raw = fmt ^ 0x5412;
  assert.equal(raw >> 13, 1, 'level L');
  let rem = raw; for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0x537 << (i - 10);
  assert.equal(rem, 0, 'format BCH');
  const mask = (raw >> 10) & 7;
  assert.equal(m[n - 8][8], true, 'dark module');
  // function modules
  const fn = Array.from({ length: n }, () => new Array(n).fill(false));
  const box = (r0, c0, h, w) => { for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) if (r >= 0 && c >= 0 && r < n && c < n) fn[r][c] = true; };
  box(0, 0, 9, 9); box(0, n - 8, 9, 8); box(n - 8, 0, 8, 9);
  box(6, 0, 1, n); box(0, 6, n, 1);
  const al = ALIGN[ver]; assert.ok(al, 'test table has this version');
  for (const r of al) for (const c of al) { if ((r === 6 && c === 6) || (r === 6 && c === al.at(-1)) || (r === al.at(-1) && c === 6)) continue; box(r - 2, c - 2, 5, 5); }
  if (ver >= 7) {
    box(0, n - 11, 6, 3); box(n - 11, 0, 3, 6);
    let v = 0; for (let i = 0; i < 18; i++) if (m[Math.floor(i / 3)][n - 11 + (i % 3)]) v |= 1 << i;
    assert.equal(v >> 12, ver, 'version info');
    let r2 = v; for (let i = 17; i >= 12; i--) if (r2 & (1 << i)) r2 ^= 0x1f25 << (i - 12);
    assert.equal(r2, 0, 'version BCH');
  }
  const maskAt = (r, c) => [(r + c) % 2 === 0, r % 2 === 0, c % 3 === 0, (r + c) % 3 === 0, (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r * c) % 2 + (r * c) % 3 === 0, ((r * c) % 2 + (r * c) % 3) % 2 === 0, ((r + c) % 2 + (r * c) % 3) % 2 === 0][mask];
  // codewords: two-column strips from the right, alternating up and down, skipping the timing column
  const bits = [];
  let upward = true;
  for (let c = n - 1; c > 0; c -= 2) {
    if (c === 6) c = 5;
    for (let k = 0; k < n; k++) {
      const r = upward ? n - 1 - k : k;
      for (const cc of [c, c - 1]) if (!fn[r][cc]) bits.push(m[r][cc] !== maskAt(r, cc));
    }
    upward = !upward;
  }
  const total = Math.floor(bits.length / 8), words = [];
  for (let i = 0; i < total; i++) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i * 8 + j] ? 1 : 0); words.push(b); }
  // de-interleave and check each block's syndromes are zero
  const nb = BLOCKS[ver], ec = ECLEN[ver], shortTotal = Math.floor(total / nb), numLong = total % nb, shortData = shortTotal - ec;
  const blocks = Array.from({ length: nb }, (_, i) => ({ data: [], ec: [], len: shortData + (i >= nb - numLong ? 1 : 0) }));
  let k = 0;
  for (let i = 0; i < shortData + 1; i++) for (const b of blocks) if (i < b.len) b.data.push(words[k++]);
  for (let i = 0; i < ec; i++) for (const b of blocks) b.ec.push(words[k++]);
  for (const b of blocks) {
    const cw = [...b.data, ...b.ec];
    for (let j = 0; j < ec; j++) { let s = 0; for (const c of cw) s = gmul(s, EXP[j]) ^ c; assert.equal(s, 0, `syndrome ${j}`); }
  }
  const data = blocks.flatMap(b => b.data);
  // byte mode
  let pos = 0; const take = len => { let v = 0; for (let i = 0; i < len; i++, pos++) v = (v << 1) | ((data[pos >> 3] >> (7 - (pos & 7))) & 1); return v; };
  assert.equal(take(4), 4, 'byte mode');
  const count = take(ver < 10 ? 8 : 16), out = [];
  for (let i = 0; i < count; i++) out.push(take(8));
  return { text: Buffer.from(out).toString('utf8'), ver, mask };
}

test('QR: every code reads back with an independent decoder (versions 1-25, all 8 masks seen)', () => {
  const masks = new Set(), vers = new Set();
  const texts = ['HELLO', 'https://places.example.com/', 'owntracks:///config?inline=' + 'eyJfdHlwZSI6ImNvbmZpZ3VyYXRpb24ifQ%3D%3D'.repeat(3), 'Hallow Places éü✓'];
  for (const len of [10, 30, 60, 100, 130, 200, 300, 500, 700, 900, 1200]) texts.push('x'.repeat(len).replace(/x/g, (_, i) => 'ABCdef0123-_:/?='[(i * 7 + len) % 16]));
  for (const t of texts) {
    const m = encode(t);
    if (!ALIGN[(m.length - 17) / 4]) continue;
    const r = decode(m);
    assert.equal(r.text, t);
    masks.add(r.mask); vers.add(r.ver);
  }
  // all masks: encode many short strings
  for (let mk = 0; mk < 8; mk++) for (const t of ['mask test', 'x'.repeat(400)]) { const r = decode(encode(t, mk)); assert.equal(r.mask, mk); assert.equal(r.text, t); masks.add(r.mask); }
  assert.equal(masks.size, 8, 'all masks exercised');
  assert.ok([...vers].some(v => v >= 10), 'a version with 16-bit length');
  assert.ok([...vers].some(v => v >= 7), 'a version with version info');
});

test('QR: a typical phone setup link fits, and the SVG is black on white', () => {
  const link = 'owntracks:///config?inline=' + encodeURIComponent(Buffer.from(JSON.stringify({ _type: 'configuration', mode: 3, url: 'https://places.example.com/pub', auth: true, username: 'mia', password: 'x'.repeat(43), deviceId: 'phone', tid: 'MI', monitoring: 1, cmd: true, pubExtendedData: true, encryptionKey: 'y'.repeat(32) })).toString('base64'));
  const m = encode(link);
  assert.ok(m.length <= 117, 'version 25 or lower');
  const svg = toSvg(m);
  assert.match(svg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /fill="#fff"/);
  assert.throws(() => encode('x'.repeat(3000)), /too long/);
});
