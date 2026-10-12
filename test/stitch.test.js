'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Stitcher, findOffset, signatures, SAMPLES } = require('../src/renderer/stitch');

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

/** `frame` squeezed to SAMPLES columns, like the renderer's GPU downscale (bilinear at each column centre). */
function squeeze(frame) {
  const { width, height, data } = frame;
  const out = new Uint8ClampedArray(SAMPLES * height * 4);
  for (let y = 0; y < height; y++) {
    for (let s = 0; s < SAMPLES; s++) {
      const fx = ((s + 0.5) * width) / SAMPLES - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(width - 1, x0 + 1);
      const w = fx - x0;
      for (let c = 0; c < 4; c++) {
        out[(y * SAMPLES + s) * 4 + c] = data[(y * width + x0) * 4 + c] * (1 - w) + data[(y * width + x1) * 4 + c] * w;
      }
    }
  }
  return { width: SAMPLES, height, data: out };
}

/** Feed `frames` the way the renderer does; returns the stitcher and the rows it asked for. */
function addBySignatures(st, frames) {
  const fetched = [];
  let sig = null;
  for (const f of frames) {
    sig = signatures(squeeze(f), sig); // one reused buffer
    const rowBytes = f.width * 4;
    st.addSignatures(sig, f.width, f.height, (y, count) => {
      fetched.push([y, count]);
      return f.data.slice(y * rowBytes, (y + count) * rowBytes);
    });
  }
  return fetched;
}

test('stitches from squeezed signatures, reading only the rows it keeps', () => {
  const page = makePage(320, 2400);
  const view = 300;
  const offsets = [0, 0, 37, 120, 121, 300, 480, 640, 800, 1000, 1001, 1180, 1380, 1560, 1760, 1950, 2100];
  const st = new Stitcher();
  const fetched = addBySignatures(st, offsets.map((o) => frameAt(page, o, view)));
  const out = st.result();
  assert.equal(out.height, 2100 + view);
  assert.ok(sameRows(out, 0, page, 0, out.height), 'stitched image equals the page');
  // The whole first frame, then just the newly revealed bottom rows; nothing for the repeated frame.
  assert.deepEqual(fetched[0], [0, view]);
  assert.deepEqual(fetched[1], [view - 37, 37]);
  assert.equal(fetched.length, offsets.length - 1);
  assert.equal(fetched.reduce((n, [, count]) => n + count, 0), out.height);
});

test('squeezed signatures ignore a sticky header too', () => {
  const page = makePage(320, 1600, 11);
  const st = new Stitcher();
  addBySignatures(st, [0, 90, 200, 330, 500, 640].map((o) => frameAt(page, o, 300, 24)));
  const out = st.result();
  assert.equal(out.height, 640 + 300);
  assert.ok(sameRows(out, 24, page, 24, out.height - 24));
});

test('stops reading frames once full', () => {
  const page = makePage(200, 3000, 5);
  const st = new Stitcher({ maxHeight: 650 });
  const fetched = addBySignatures(st, [0, 100, 200, 300, 400, 500].map((o) => frameAt(page, o, 300)));
  assert.equal(st.result().height, 650);
  assert.equal(st.full, true);
  assert.equal(fetched.length, 5);
  assert.deepEqual(fetched.at(-1), [200, 50], 'the last block is cut to fit');
  assert.ok(sameRows(st.result(), 0, page, 0, 650));
  // Further frames aren't even looked at.
  assert.deepEqual(st.add({ width: 0, height: 0, data: null }), { added: 0, height: 650, lost: false, full: true });
});

test('findOffset: unchanged frames, hints and the tolerance', () => {
  const page = makePage(320, 1200, 9);
  const sigAt = (o) => signatures(frameAt(page, o, 300));
  const prev = sigAt(200);
  assert.equal(findOffset(prev, sigAt(200), 300), 0);
  assert.equal(findOffset(prev, sigAt(260), 300), 60);
  // A hint only changes the search order, never the answer.
  for (const hint of [-1, 1, 30, 60, 61, 254, 400]) assert.equal(findOffset(prev, sigAt(260), 300, { hint }), 60);
  assert.equal(findOffset(prev, sigAt(800), 300, { hint: 60 }), -1, 'no overlap');
  // A blank frame has nothing to match on.
  const blank = new Float32Array(300 * SAMPLES).fill(255);
  assert.equal(findOffset(blank, blank, 300), -1);
});

test('findOffset: a small change near the top (hover, caret, spinner) doesn’t lose the match', () => {
  let s = 3;
  const rand = () => ((s = Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const H = 400;
  const page = new Float32Array(3000 * SAMPLES).map(() => 40 + rand() * 170);
  const frame = (top) => page.slice(top * SAMPLES, (top + H) * SAMPLES).map((v) => v + (rand() - 0.5) * 2);
  for (let k = 0; k < 20; k++) {
    const prev = frame(100 + k * 30);
    const next = frame(140 + k * 30);
    for (let row = 34; row < 37; row++) for (let x = 10; x < 30; x++) next[row * SAMPLES + x] += 120;
    assert.equal(findOffset(prev, next, H, { hint: 40 }), 40);
  }
});
