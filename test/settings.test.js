'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings, DEFAULTS } = require('../src/settings');

test('settings fall back to defaults and persist changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinshot-'));
  const file = path.join(dir, 'nested', 'settings.json');
  const s = new Settings(file);
  assert.equal(s.get('autoSave'), DEFAULTS.autoSave);
  s.set('autoSave', false);
  assert.equal(new Settings(file).get('autoSave'), false);
  assert.equal(new Settings(file).get('shortcuts').captureArea, DEFAULTS.shortcuts.captureArea);
});

test('corrupt settings files are ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinshot-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{not json');
  assert.equal(new Settings(file).get('copyToClipboard'), true);
});

test('old default shortcuts move to the new ones (⌘⇧3 full screen, ⌘⇧4 area)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinshot-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ shortcuts: { captureArea: 'CommandOrControl+Shift+2' } }));
  assert.equal(new Settings(file).get('shortcuts').captureArea, 'CommandOrControl+Shift+4');
  fs.writeFileSync(
    file,
    JSON.stringify({ shortcuts: { captureArea: 'CommandOrControl+Shift+3', captureScreen: 'CommandOrControl+Shift+1' } }),
  );
  const sc = new Settings(file).get('shortcuts');
  assert.equal(sc.captureScreen, 'CommandOrControl+Shift+3');
  assert.equal(sc.captureArea, 'CommandOrControl+Shift+4');
  fs.writeFileSync(file, JSON.stringify({ shortcuts: { captureArea: 'Alt+S' } }));
  assert.equal(new Settings(file).get('shortcuts').captureArea, 'Alt+S');
});

test('a migration never leaves two actions on one shortcut', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinshot-'));
  const file = path.join(dir, 'settings.json');
  // Custom full-screen shortcut that collides with the new area default.
  fs.writeFileSync(
    file,
    JSON.stringify({ shortcuts: { captureArea: 'CommandOrControl+Shift+3', captureScreen: 'CommandOrControl+Shift+4' } }),
  );
  const sc = new Settings(file).get('shortcuts');
  const used = Object.values(sc).filter(Boolean);
  assert.equal(new Set(used).size, used.length);
  assert.equal(sc.captureScreen, 'CommandOrControl+Shift+4', "the user's own choice wins");
});
