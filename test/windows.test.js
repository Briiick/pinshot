'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseXwininfoChildren } = require('../src/windows');

test('parses xwininfo -root -children (topmost first, absolute coords)', () => {
  const out = `
xwininfo: Window id: 0x21f (the root window) (has no name)

  Root window id: 0x21f (the root window) (has no name)
  Parent window id: 0x0 (none)
     4 children:
     0x200006 "Top \\"quoted\\"": ("electron" "electron")  300x200+200+100  +200+100
     0x200003 "Bottom": ("electron" "electron")  400x300+50+60  +50+60
     0x200005 (has no name): ()  1x1+0+0  +0+0
     0x200000 "Chromium clipboard": ()  10x10+-100+-100  +-100+-100
`;
  const wins = parseXwininfoChildren(out);
  assert.deepEqual(wins.map((w) => w.id), [0x200006, 0x200003, 0x200005, 0x200000]);
  assert.equal(wins[0].title, 'Top "quoted"');
  assert.deepEqual(wins[1].bounds, { x: 50, y: 60, width: 400, height: 300 });
  assert.deepEqual(wins[3].bounds, { x: -100, y: -100, width: 10, height: 10 });
});
