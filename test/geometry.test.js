'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeRect, toPixelRect, fitPinSize, clampIntoArea, zoomBounds, thumbSize, stackLayout,
  captureFileName, recordingFileName, recordingBarBounds, intersect, compositePlan, dominantDisplay,
} = require('../src/geometry');

test('normalizeRect handles drags in any direction', () => {
  assert.deepEqual(normalizeRect(50, 40, 10, 100), { x: 10, y: 40, width: 40, height: 60 });
});

test('toPixelRect scales to retina pixels and clamps to the image', () => {
  assert.deepEqual(toPixelRect({ x: 10.4, y: 5, width: 20, height: 10 }, 2, 1000, 1000), {
    x: 20, y: 10, width: 41, height: 20,
  });
  assert.deepEqual(toPixelRect({ x: -5, y: 90, width: 30, height: 30 }, 1, 100, 100), {
    x: 0, y: 90, width: 25, height: 10,
  });
});

test('fitPinSize keeps real size when it fits and shrinks big captures', () => {
  const wa = { width: 1000, height: 800 };
  assert.deepEqual(fitPinSize(400, 200, 2, wa), { width: 200, height: 100 });
  assert.deepEqual(fitPinSize(4000, 2000, 1, wa, 0.5), { width: 500, height: 250 });
});

test('clampIntoArea moves windows back on-screen', () => {
  const area = { x: 0, y: 0, width: 800, height: 600 };
  assert.deepEqual(clampIntoArea({ x: 750, y: -20, width: 100, height: 50 }, area), {
    x: 700, y: 0, width: 100, height: 50,
  });
});

test('zoomBounds scales around the centre and keeps aspect ratio', () => {
  assert.deepEqual(zoomBounds({ x: 100, y: 100, width: 200, height: 100 }, 2, 2), {
    x: 0, y: 50, width: 400, height: 200,
  });
  assert.equal(zoomBounds({ x: 0, y: 0, width: 50, height: 25 }, 0.1, 2).width, 40);
});

test('captureFileName is sortable and filesystem-safe', () => {
  assert.equal(captureFileName(new Date(2026, 9, 1, 9, 5, 7)), 'PinShot 2026-10-01 at 09.05.07.png');
});

test('thumbSize fits the thumbnail box without upscaling', () => {
  assert.deepEqual(thumbSize(1200, 600), { width: 240, height: 120 });
  assert.deepEqual(thumbSize(300, 900), { width: 57, height: 170 });
  assert.deepEqual(thumbSize(100, 50), { width: 100, height: 50 });
});

test('stackLayout stacks newest at the bottom-left, older ones upwards', () => {
  const wa = { x: 0, y: 25, width: 1440, height: 875 };
  const [newest, older] = stackLayout([{ width: 240, height: 120 }, { width: 200, height: 100 }], wa);
  assert.deepEqual(newest, { x: 16, y: 764, width: 240, height: 120 });
  assert.deepEqual(older, { x: 16, y: 652, width: 200, height: 100 });
  const crowded = stackLayout(Array(10).fill({ width: 100, height: 200 }), wa);
  assert.equal(crowded[9].y, 41); // parked at the top instead of going off-screen
});

test('recordingFileName keeps the extension', () => {
  assert.equal(recordingFileName('mp4', new Date(2026, 9, 1, 9, 5, 7)), 'PinShot Recording 2026-10-01 at 09.05.07.mp4');
});

test('recordingBarBounds sits below the area, else above, else inside', () => {
  const wa = { x: 0, y: 0, width: 1440, height: 900 };
  const size = { width: 200, height: 40 };
  assert.deepEqual(recordingBarBounds({ x: 100, y: 100, width: 400, height: 300 }, wa, size), {
    x: 200, y: 412, width: 200, height: 40,
  });
  assert.equal(recordingBarBounds({ x: 100, y: 500, width: 400, height: 380 }, wa, size).y, 448);
  assert.equal(recordingBarBounds({ x: 0, y: 0, width: 1440, height: 900 }, wa, size).y, 848);
  assert.equal(recordingBarBounds({ x: 1400, y: 100, width: 40, height: 40 }, wa, size).x, 1232);
});

test('intersect returns the overlap or null', () => {
  assert.deepEqual(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }), {
    x: 5, y: 5, width: 5, height: 5,
  });
  assert.equal(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 }), null);
});

test('compositePlan splits a selection across mixed-density displays', () => {
  const displays = [
    { id: 'L', bounds: { x: 0, y: 0, width: 1440, height: 900 }, scale: 1 },
    { id: 'R', bounds: { x: 1440, y: 0, width: 1280, height: 800 }, scale: 2 },
  ];
  const plan = compositePlan({ x: 1340, y: 100, width: 200, height: 50 }, displays);
  assert.equal(plan.scale, 2);
  assert.equal(plan.width, 400);
  assert.equal(plan.height, 100);
  assert.deepEqual(plan.pieces, [
    { id: 'L', src: { x: 1340, y: 100, width: 100, height: 50 }, dest: { x: 0, y: 0, width: 200, height: 100 } },
    { id: 'R', src: { x: 0, y: 100, width: 100, height: 50 }, dest: { x: 200, y: 0, width: 200, height: 100 } },
  ]);
  // Pieces tile the output exactly.
  assert.equal(plan.pieces.reduce((n, p) => n + p.dest.width * p.dest.height, 0), plan.width * plan.height);
  assert.equal(compositePlan({ x: 5000, y: 0, width: 10, height: 10 }, displays), null);
});

test('compositePlan leaves gaps where no display is (L-shaped layouts)', () => {
  const displays = [
    { id: 'A', bounds: { x: 0, y: 0, width: 100, height: 100 }, scale: 1 },
    { id: 'B', bounds: { x: 100, y: 50, width: 100, height: 100 }, scale: 1 },
  ];
  const plan = compositePlan({ x: 50, y: 0, width: 100, height: 100 }, displays);
  assert.deepEqual(plan.pieces.map((p) => p.dest), [
    { x: 0, y: 0, width: 50, height: 100 },
    { x: 50, y: 50, width: 50, height: 50 },
  ]);
});

test('dominantDisplay picks the display with most of the rect', () => {
  const displays = [
    { id: 'L', bounds: { x: 0, y: 0, width: 1440, height: 900 } },
    { id: 'R', bounds: { x: 1440, y: 0, width: 1280, height: 800 } },
  ];
  assert.equal(dominantDisplay({ x: 1400, y: 0, width: 100, height: 100 }, displays).id, 'R');
  assert.equal(dominantDisplay({ x: 1300, y: 0, width: 100, height: 100 }, displays).id, 'L');
});
