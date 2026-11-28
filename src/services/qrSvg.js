'use strict';

// QR Model 2, versions 1–15, error correction M. Blocks differing in length
// have one extra data byte in each of the final (total % blocks) blocks.
const TOTAL = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10];
const ECC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24];
const ALIGN = [[], [], [6,18], [6,22], [6,26], [6,30], [6,34], [6,22,38],
  [6,24,42], [6,26,46], [6,28,50], [6,30,54], [6,32,58], [6,34,62], [6,26,46,66], [6,26,48,70]];

function multiply(a, b) {
  let product = 0;
  while (b) {
    if (b & 1) product ^= a;
    b >>>= 1;
    a = (a << 1) ^ ((a & 128) ? 0x11d : 0);
  }
  return product;
}

function generator(degree) {
  let polynomial = [1];
  let root = 1;
  for (let i = 0; i < degree; i++) {
    const next = [...polynomial, 0];
    polynomial.forEach((coefficient, j) => { next[j + 1] ^= multiply(coefficient, root); });
    polynomial = next;
    root = multiply(root, 2);
  }
  return polynomial;
}

function codewords(bytes, version, utf8) {
  const blocks = BLOCKS[version], ecc = ECC[version];
  const capacity = TOTAL[version] - blocks * ecc;
  const bits = [];
  function append(value, count) {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  }
  if (utf8) { append(7, 4); append(26, 8); } // ECI assignment for UTF-8
  append(4, 4);
  append(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) append(byte, 8);
  append(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((n, bit) => n * 2 + bit, 0));
  }
  for (let pad = 0; data.length < capacity; pad++) data.push(pad % 2 ? 0x11 : 0xec);

  const divisor = generator(ecc), payloads = [], checks = [];
  let offset = 0;
  for (let b = 0; b < blocks; b++) {
    const length = Math.floor(capacity / blocks) + Number(b >= blocks - capacity % blocks);
    const chunk = data.slice(offset, offset + length);
    offset += length;
    const remainder = [...chunk, ...Array(ecc).fill(0)];
    for (let i = 0; i < length; i++) {
      const lead = remainder[i];
      divisor.forEach((coefficient, j) => { remainder[i + j] ^= multiply(lead, coefficient); });
    }
    payloads.push(chunk);
    checks.push(remainder.slice(length));
  }
  const interleaved = [];
  for (const group of [payloads, checks]) {
    for (let i = 0; i < group.at(-1).length; i++) {
      for (const block of group) if (i < block.length) interleaved.push(block[i]);
    }
  }
  return interleaved;
}

// Systematic BCH code used for both format and version information.
function bch(value, polynomial, degree) {
  let remainder = value << degree;
  for (let i = 31 - Math.clz32(remainder); i >= degree; i--) {
    if ((remainder >>> i) & 1) remainder ^= polynomial << (i - degree);
  }
  return (value << degree) | remainder;
}

const masks = [
  (x,y) => (x+y)%2, (x,y) => y%2, x => x%3, (x,y) => (x+y)%3,
  (x,y) => (Math.floor(y/2)+Math.floor(x/3))%2, (x,y) => x*y%2+x*y%3,
  (x,y) => (x*y%2+x*y%3)%2, (x,y) => ((x+y)%2+x*y%3)%2,
];

function layout(version, data, mask) {
  const size = 17 + 4 * version;
  const matrix = Array.from({ length: size }, () => Array(size).fill(null));
  const set = (x, y, value) => { matrix[y][x] = Boolean(value); };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size-4, 3], [3, size-4]]) {
    for (let y = Math.max(0, cy-4); y <= Math.min(size-1, cy+4); y++) {
      for (let x = Math.max(0, cx-4); x <= Math.min(size-1, cx+4); x++) {
        const distance = Math.max(Math.abs(x-cx), Math.abs(y-cy));
        set(x, y, distance !== 2 && distance !== 4);
      }
    }
  }
  for (const cy of ALIGN[version]) for (const cx of ALIGN[version]) {
    if ((cx === 6 && (cy === 6 || cy === size-7)) || (cx === size-7 && cy === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      set(cx+dx, cy+dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const format = bch(mask, 0x537, 10) ^ 0x5412; // M uses level bits 00
  const bit = (word, i) => (word >>> i) & 1;
  for (let i = 0; i < 15; i++) {
    if (i < 8) set(8, i < 6 ? i : i+1, bit(format, i));
    else set(i === 8 ? 7 : 14-i, 8, bit(format, i));
    if (i < 8) set(size-1-i, 8, bit(format, i));
    else set(8, size-15+i, bit(format, i));
  }
  set(8, size-8, true);
  if (version >= 7) {
    const word = bch(version, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const x = size-11+i%3, y = Math.floor(i/3);
      set(x, y, bit(word, i));
      set(y, x, bit(word, i));
    }
  }
  let cursor = 0, upward = true;
  for (let right = size-1; right > 0; right -= 2) {
    if (right === 6) right--;
    for (let j = 0; j < size; j++) {
      const y = upward ? size-1-j : j;
      for (const x of [right, right-1]) {
        if (matrix[y][x] !== null) continue;
        const value = bit(data[cursor >>> 3] || 0, 7 - cursor % 8);
        set(x, y, value ^ Number(masks[mask](x,y) === 0));
        cursor++;
      }
    }
    upward = !upward;
  }
  return matrix;
}

function linePenalty(line) {
  let score = 0;
  const runs = [];
  for (const dark of line) {
    if (runs.at(-1)?.dark === dark) runs.at(-1).length++;
    else runs.push({ dark, length: 1 });
  }
  for (const { length } of runs) if (length >= 5) score += length - 2;
  // Include the white border when checking finder-like patterns on either side.
  if (runs[0].dark) runs.unshift({ dark: false, length: 0 });
  if (runs.at(-1).dark) runs.push({ dark: false, length: 0 });
  runs[0].length += line.length;
  runs.at(-1).length += line.length;
  for (let i = 1; i + 5 < runs.length; i += 2) {
    const unit = runs[i].length;
    if (runs[i+1].length !== unit || runs[i+2].length !== 3*unit ||
        runs[i+3].length !== unit || runs[i+4].length !== unit) continue;
    const left = runs[i-1].length, right = runs[i+5].length;
    if (left >= 4*unit && right >= unit) score += 40;
    if (right >= 4*unit && left >= unit) score += 40;
  }
  return score;
}

function penalty(matrix) {
  const size = matrix.length;
  let dark = 0, score = 0;
  for (let y = 0; y < size; y++) {
    score += linePenalty(matrix[y]) + linePenalty(matrix.map(row => row[y]));
    for (let x = 0; x < size; x++) {
      const cell = matrix[y][x];
      dark += Number(cell);
      if (x && y && matrix[y][x-1] === cell && matrix[y-1][x] === cell && matrix[y-1][x-1] === cell) score += 3;
    }
  }
  return score + 10 * Math.floor(Math.abs(dark * 20 / (size*size) - 10));
}

function encodeQrMatrix(text, ecLevel = 'M') {
  if (ecLevel !== 'M' || typeof text !== 'string') throw new TypeError('需要文本和 M 级纠错');
  const bytes = Buffer.from(text, 'utf8');
  const utf8 = bytes.some(b => b >= 128);
  const version = TOTAL.findIndex((total, v) => v > 0 &&
    4 + (utf8 ? 12 : 0) + (v < 10 ? 8 : 16) + bytes.length*8 <= (total - BLOCKS[v]*ECC[v])*8);
  if (version < 0) throw new RangeError('二维码内容过长');
  const data = codewords(bytes, version, utf8);
  let best, lowest = Infinity;
  for (let mask = 0; mask < masks.length; mask++) {
    const matrix = layout(version, data, mask);
    const score = penalty(matrix);
    if (score < lowest) { best = matrix; lowest = score; }
  }
  return best;
}

function generateQrSvg(text, { quietZone = 4 } = {}) {
  if (!Number.isSafeInteger(quietZone) || quietZone < 0 || quietZone > 64) throw new RangeError('二维码留白无效');
  const matrix = encodeQrMatrix(text);
  const size = matrix.length + 2 * quietZone;
  const path = [];
  matrix.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) path.push(`M${x+quietZone} ${y+quietZone}h1v1h-1z`);
  }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="手机随身听配对二维码" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#FFFFFF"/><path fill="#1A1916" d="${path.join('')}"/></svg>`;
}

module.exports = { generateQrSvg, encodeQrMatrix };
