'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Stitcher } = require('../src/renderer/stitch');

/** A tall "page" with text-like blocks, deterministic. */
function makePage(width, height, seed = 7) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y += 14 + Math.floor(rand() * 10)) {
    const lineH = 6 + Math.floor(rand() * 6);
    let x = 8;
    while (x < width - 20) {
      const w = 6 + Math.floor(rand() * 40);
      const shade = Math.floor(rand() * 120);
      for (let yy = y; yy < Math.min(height, y + lineH); yy++) {
        for (let xx = x; xx < Math.min(width, x + w); xx++) {
          const i = (yy * width + xx) * 4;
          data[i] = shade;
          data[i + 1] = shade + 30;
          data[i + 2] = shade + 60;
        }
      }
      x += w + 6 + Math.floor(rand() * 10);
    }
  }
  return { width, height, data };
}

/** The viewport of `page` scrolled to `offset`, optionally with a sticky header. */
function frameAt(page, offset, height, header = 0) {
  const rowBytes = page.width * 4;
  const data = page.data.slice(offset * rowBytes, (offset + height) * rowBytes);
  for (let y = 0; y < header; y++) data.fill(40, y * rowBytes, (y + 1) * rowBytes); // dark sticky bar
  return { width: page.width, height, data };
}

function sameRows(a, aStart, b, bStart, rows) {
  const rowBytes = a.width * 4;
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < rowBytes; i++) {
      if (a.data[(aStart + r) * rowBytes + i] !== b.data[(bStart + r) * rowBytes + i]) return false;
    }
  }
  return true;
}

test('stitches frames scrolled by varying amounts back into the page', () => {
  const page = makePage(320, 2400);
  const view = 300;
  const offsets = [0, 0, 37, 120, 121, 300, 480, 640, 800, 1000, 1001, 1180, 1380, 1560, 1760, 1950, 2100];
  const st = new Stitcher();
  for (const o of offsets) st.add(frameAt(page, o, view));
  const out = st.result();
  assert.equal(out.height, 2100 + view);
  assert.ok(sameRows(out, 0, page, 0, out.height), 'stitched image equals the page');
});

test('ignores a sticky header when matching', () => {
  const page = makePage(320, 1600, 11);
  const view = 300;
  const st = new Stitcher();
  for (const o of [0, 90, 200, 330, 500, 640]) st.add(frameAt(page, o, view, 24));
  const out = st.result();
  assert.equal(out.height, 640 + view);
  // Everything below the first frame's header matches the page.
  assert.ok(sameRows(out, 24, page, 24, out.height - 24));
});

test('reports when the user scrolled too far between frames', () => {
  const page = makePage(320, 2000, 3);
  const st = new Stitcher();
  st.add(frameAt(page, 0, 300));
  const r = st.add(frameAt(page, 900, 300)); // no overlap at all
  assert.equal(r.lost, true);
  assert.equal(st.result().height, 300);
  // Recovers once frames overlap again.
  assert.equal(st.add(frameAt(page, 150, 300)).added, 150);
});

test('respects the maximum height', () => {
  const page = makePage(200, 3000, 5);
  const st = new Stitcher({ maxHeight: 700 });
  for (let o = 0; o <= 2000; o += 100) st.add(frameAt(page, o, 300));
  assert.equal(st.result().height, 700);
});
