#!/usr/bin/env node
/*
 * Generates the three placeholder icons (16/48/128): a flat dark square with
 * "RRC" drawn in a 5x7 bitmap font. No dependencies — writes PNGs directly
 * using Node's zlib.
 *
 * Usage: node tools/make-icons.js   (from the extension/ directory)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- minimal PNG encoder ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  // compression, filter, interlace = 0

  // Raw image data: each scanline prefixed with filter byte 0.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---- 5x7 glyphs ----

const GLYPHS = {
  R: [
    '11110',
    '10001',
    '10001',
    '11110',
    '10100',
    '10010',
    '10001'
  ],
  C: [
    '01110',
    '10001',
    '10000',
    '10000',
    '10000',
    '10001',
    '01110'
  ]
};

const BG = [0x24, 0x29, 0x2f, 0xff]; // GitHub-ish dark slate
const FG = [0xf0, 0xf6, 0xfc, 0xff];

function drawIcon(size, text, scale) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) BG.forEach((v, j) => { rgba[i * 4 + j] = v; });

  const glyphW = 5, glyphH = 7, gap = 1;
  const textW = (text.length * glyphW + (text.length - 1) * gap) * scale;
  const textH = glyphH * scale;
  const x0 = Math.floor((size - textW) / 2);
  const y0 = Math.floor((size - textH) / 2);

  [...text].forEach((ch, gi) => {
    const glyph = GLYPHS[ch];
    const gx = x0 + gi * (glyphW + gap) * scale;
    for (let ry = 0; ry < glyphH; ry++) {
      for (let rx = 0; rx < glyphW; rx++) {
        if (glyph[ry][rx] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = gx + rx * scale + sx;
            const py = y0 + ry * scale + sy;
            if (px < 0 || py < 0 || px >= size || py >= size) continue;
            const o = (py * size + px) * 4;
            FG.forEach((v, j) => { rgba[o + j] = v; });
          }
        }
      }
    }
  });

  return encodePng(size, size, rgba);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

// 16px is too small for three letters — a single "R" keeps it legible.
const specs = [
  { size: 16, text: 'R', scale: 2 },
  { size: 48, text: 'RRC', scale: 2 },
  { size: 128, text: 'RRC', scale: 6 }
];

for (const { size, text, scale } of specs) {
  const file = path.join(outDir, 'icon' + size + '.png');
  fs.writeFileSync(file, drawIcon(size, text, scale));
  console.log('wrote', file);
}
