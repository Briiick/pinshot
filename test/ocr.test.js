'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { joinFragments } = require('../src/ocr');

test('joins Vision fragments into lines, top to bottom, left to right', () => {
  // Vision boxes are normalised with the origin at the bottom-left.
  const text = joinFragments([
    { text: 'world', x: 0.4, y: 0.8, h: 0.05 },
    { text: 'Second line', x: 0.1, y: 0.6, h: 0.05 },
    { text: 'Hello', x: 0.1, y: 0.81, h: 0.05 },
  ]);
  assert.equal(text, 'Hello world\nSecond line');
});
