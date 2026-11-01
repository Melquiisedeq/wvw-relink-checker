// Every icon is the crest on a transparent ground: favicon.ico whole, favicon-192.png and apple-touch-icon.png smaller.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const ico = readFileSync(new URL('../../site/favicon.ico', import.meta.url));

// Frames of an ICO: 6-byte header, 16-byte entries, each frame a PNG here.
function frames(buf) {
  const out = [];
  for (let i = 0; i < buf.readUInt16LE(4); i++) {
    const e = 6 + 16 * i;
    const size = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    out.push({ width: buf[e] || 256, png: buf.subarray(offset, offset + size) });
  }
  return out;
}

// RGBA 8-bit, non-interlaced PNG to rows of pixel bytes.
function pixels(png) {
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png[25], 6, 'colour type RGBA');
  assert.equal(png[24], 8, '8 bits');
  assert.equal(png[28], 0, 'not interlaced');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const parts = [];
  for (let p = 8; p < png.length;) {
    const len = png.readUInt32BE(p), type = png.toString('latin1', p + 4, p + 8);
    if (type === 'IDAT') parts.push(png.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * 4, img = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= 4 ? img[y * stride + x - 4] : 0;
      const b = y ? img[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y ? img[(y - 1) * stride + x - 4] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      img[y * stride + x] = (v + [0, a, b, (a + b) >> 1, paeth][filter]) & 255;
    }
  }
  return { width, height, alpha: (x, y) => img[y * stride + x * 4 + 3] };
}

test('favicon.ico holds 16, 32 and 48 frames', () => {
  assert.deepEqual(frames(ico).map(f => f.width), [16, 32, 48]);
});

test('every corner of every favicon.ico frame is transparent', () => {
  for (const { width, png } of frames(ico)) {
    const { width: w, height: h, alpha } = pixels(png);
    assert.equal(w, width);
    for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) {
      assert.equal(alpha(x, y), 0, `${width}px frame, corner ${x},${y}`);
    }
  }
});

test('every corner of favicon-192.png and apple-touch-icon.png is transparent', () => {
  for (const [name, side] of [['favicon-192.png', 192], ['apple-touch-icon.png', 180]]) {
    const { width: w, height: h, alpha } = pixels(readFileSync(new URL(`../../site/assets/${name}`, import.meta.url)));
    assert.deepEqual([w, h], [side, side], `${name} size`);
    for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) {
      assert.equal(alpha(x, y), 0, `${name}, corner ${x},${y}`);
    }
  }
});
