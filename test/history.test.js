'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { History } = require('../src/history');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pinshot-history-'));

test('history keeps entries newest first and persists them', () => {
  const dir = tmp();
  const saved = path.join(tmp(), 'Saved.png');
  fs.writeFileSync(saved, 'png');
  const h = new History(dir);
  const a = h.add({ file: saved, width: 10, height: 5, preview: Buffer.from('p1') });
  const own = h.pathFor('Copy.png');
  fs.writeFileSync(own, 'png');
  const b = h.add({ file: own, kind: 'image', preview: Buffer.from('p2') });
  assert.deepEqual(h.list().map((e) => e.id), [b.id, a.id]);
  assert.equal(fs.readFileSync(a.preview, 'utf8'), 'p1');

  const again = new History(dir);
  assert.deepEqual(again.list().map((e) => e.id), [b.id, a.id]);
  assert.equal(again.get(a.id).width, 10);
});

test('removing an entry deletes PinShot’s own copy but never the user’s file', () => {
  const dir = tmp();
  const saved = path.join(tmp(), 'Saved.png');
  fs.writeFileSync(saved, 'png');
  const h = new History(dir);
  const user = h.add({ file: saved, preview: Buffer.from('p') });
  const own = h.pathFor('Copy.png');
  fs.writeFileSync(own, 'png');
  const mine = h.add({ file: own, preview: Buffer.from('p') });

  h.remove(user.id);
  assert.ok(fs.existsSync(saved), 'user file kept');
  assert.ok(!fs.existsSync(user.preview), 'preview removed');
  h.remove(mine.id);
  assert.ok(!fs.existsSync(own), 'history copy removed');
  assert.deepEqual(h.list(), []);
});

test('entries whose file disappeared drop out of the list', () => {
  const dir = tmp();
  const file = path.join(tmp(), 'Gone.png');
  fs.writeFileSync(file, 'png');
  const h = new History(dir);
  h.add({ file });
  fs.rmSync(file);
  assert.deepEqual(h.list(), []);
  assert.deepEqual(new History(dir).list(), []);
});

test('history is capped, oldest first out', () => {
  const dir = tmp();
  const h = new History(dir, { limit: 3 });
  const files = [1, 2, 3, 4].map((n) => {
    const f = h.pathFor(`${n}.png`);
    fs.writeFileSync(f, 'png');
    return f;
  });
  for (const file of files) h.add({ file });
  assert.deepEqual(h.list().map((e) => path.basename(e.file)), ['4.png', '3.png', '2.png']);
  assert.ok(!fs.existsSync(files[0]), 'the oldest history copy was deleted');
});

test('update swaps the file (e.g. recording → GIF) and refreshes the preview', () => {
  const dir = tmp();
  const h = new History(dir);
  const video = h.pathFor('r.mp4');
  fs.writeFileSync(video, 'mp4');
  const e = h.add({ file: video, kind: 'video', preview: Buffer.from('old') });
  const gif = h.pathFor('r.gif');
  fs.writeFileSync(gif, 'gif');
  h.update(e.id, { file: gif, kind: 'gif' }, Buffer.from('new'));
  assert.equal(h.get(e.id).kind, 'gif');
  assert.ok(!fs.existsSync(video));
  assert.equal(fs.readFileSync(h.get(e.id).preview, 'utf8'), 'new');
});

test('a corrupt index starts an empty history', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'history.json'), '{nope');
  assert.deepEqual(new History(dir).list(), []);
});
