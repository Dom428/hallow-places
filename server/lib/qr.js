// A small QR code encoder (byte mode, error correction L, versions 1-40, mask chosen by the spec's penalty score),
// so a phone's setup link is never sent to an online QR service. A port of Hallow Remote's Qr.cs (ISO/IEC 18004, the
// same way Nayuki's reference code does it), extended to every version.
const EC_L = [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
const BLOCKS_L = [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25];

export function rawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
  return r;
}
export const totalCodewords = ver => Math.floor(rawModules(ver) / 8);
export const dataCodewords = ver => totalCodewords(ver) - EC_L[ver] * BLOCKS_L[ver];

export function alignment(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2, size = ver * 4 + 17;
  const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

function mul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z;
}
export function divisor(degree) {
  const r = new Array(degree).fill(0); r[degree - 1] = 1; let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = mul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
    root = mul(root, 0x02);
  }
  return r;
}
export function remainder(data, div) {
  const r = new Array(div.length).fill(0);
  for (const b of data) {
    const f = (b ^ r[0]) & 0xff;
    r.shift(); r.push(0);
    for (let i = 0; i < r.length; i++) r[i] ^= mul(div[i], f);
  }
  return r;
}

// text -> matrix of booleans, m[row][col], true = dark
export function encode(text, forceMask) {
  const bytes = Buffer.from(String(text), 'utf8');
  let ver = 1;
  while (ver <= 40 && 4 + (ver < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
  if (ver > 40) throw new Error('too long for a QR code');
  const size = ver * 4 + 17, dataLen = dataCodewords(ver);
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); for (const b of bytes) put(b, 8);
  put(0, Math.min(4, dataLen * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < dataLen * 8; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = new Array(dataLen).fill(0);
  bits.forEach((b, i) => { if (b) data[i >> 3] |= 0x80 >> (i & 7); });

  const nb = BLOCKS_L[ver], ec = EC_L[ver], total = totalCodewords(ver), shortLen = Math.floor(total / nb), numShort = nb - total % nb;
  const div = divisor(ec), blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const len = shortLen - ec + (i < numShort ? 0 : 1), dat = data.slice(k, k + len); k += len;
    const e = remainder(dat, div), blk = new Array(shortLen + 1).fill(0);
    dat.forEach((v, j) => { blk[j] = v; });
    e.forEach((v, j) => { blk[(i < numShort ? len + 1 : len) + j] = v; });
    blocks.push(blk);
  }
  const all = [];
  for (let i = 0; i < shortLen + 1; i++) for (let j = 0; j < nb; j++) if (i !== shortLen - ec || j >= numShort) all.push(blocks[j][i]);

  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, d) => { m[y][x] = d; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy)); set(x, y, dist !== 2 && dist !== 4);
    }
  const al = alignment(ver);
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  if (ver >= 7) {
    let rem = ver; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vbits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) { const b = ((vbits >>> i) & 1) === 1, a = size - 11 + i % 3, c = Math.floor(i / 3); set(a, c, b); set(c, a, b); }
  }
  format(set, size, 0);
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (!fn[y][x] && bit < all.length * 8) { m[y][x] = ((all[bit >> 3] >>> (7 - (bit & 7))) & 1) === 1; bit++; }
    }
  }
  let best = 0, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(m, fn, mask); format(set, size, mask);
    const score = penalty(m); if (score < bestScore) { best = mask; bestScore = score; }
    applyMask(m, fn, mask);
  }
  if (forceMask >= 0 && forceMask < 8) best = forceMask;   // tests only
  applyMask(m, fn, best); format(set, size, best);
  return m;
}

function applyMask(m, fn, mask) {
  const n = m.length;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (fn[i][j]) continue;
    let f;
    switch (mask) {
      case 0: f = (i + j) % 2 === 0; break;
      case 1: f = i % 2 === 0; break;
      case 2: f = j % 3 === 0; break;
      case 3: f = (i + j) % 3 === 0; break;
      case 4: f = (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0; break;
      case 5: f = (i * j) % 2 + (i * j) % 3 === 0; break;
      case 6: f = ((i * j) % 2 + (i * j) % 3) % 2 === 0; break;
      default: f = ((i + j) % 2 + (i * j) % 3) % 2 === 0; break;
    }
    if (f) m[i][j] = !m[i][j];
  }
}

export function penalty(m) {
  const n = m.length; let p = 0;
  const at = (pass, line, k) => (pass === 0 ? m[line][k] : m[k][line]);
  const dark = (pass, line, k) => k >= 0 && k < n && at(pass, line, k);
  const pat = [true, false, true, true, true, false, true];
  for (let pass = 0; pass < 2; pass++) for (let line = 0; line < n; line++) {
    let run = 1;
    for (let k = 1; k <= n; k++) {
      if (k < n && at(pass, line, k) === at(pass, line, k - 1)) run++;
      else { if (run >= 5) p += 3 + run - 5; run = 1; }
    }
    for (let k = -4; k < n; k++) {
      let hit = true; for (let t = 0; t < 7 && hit; t++) if (dark(pass, line, k + t) !== pat[t]) hit = false;
      if (!hit) continue;
      let before = true, after = true;
      for (let t = 1; t <= 4; t++) { if (dark(pass, line, k - t)) before = false; if (dark(pass, line, k + 6 + t)) after = false; }
      if (before) p += 40; if (after) p += 40;
    }
  }
  let darkCount = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (m[y][x]) darkCount++;
    if (y < n - 1 && x < n - 1 && m[y][x] === m[y + 1][x] && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x + 1]) p += 3;
  }
  p += Math.floor(Math.abs(darkCount * 20 - n * n * 10) / (n * n)) * 10;
  return p;
}

// 15 format bits: level L (01) + mask, BCH-protected, XOR 0x5412
export function formatBits(mask) {
  const data = (1 << 3) | mask; let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
function format(set, size, mask) {
  const bits = formatBits(mask), b = i => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, b(i));
  set(8, 7, b(6)); set(8, 8, b(7)); set(7, 8, b(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, b(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, b(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, b(i));
  set(8, size - 8, true);
}

// matrix -> a crisp SVG (black on white with a quiet zone, whatever the page theme)
export function toSvg(m, border = 4) {
  const n = m.length + border * 2;
  let d = '';
  m.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x + border},${y + border}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
