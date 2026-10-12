'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { History } = require('../src/history');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pinshot-history-'));

test('history keeps entries newest first and persists them', async () => {
  const dir = tmp();
  const saved = path.join(tmp(), 'Saved.png');
  fs.writeFileSync(saved, 'png');
  const h = new History(dir);
  const a = h.add({ file: saved, width: 10, height: 5, preview: Buffer.from('p1') });
  const own = h.pathFor('Copy.png');
  fs.writeFileSync(own, 'png');
  const b = h.add({ file: own, kind: 'image', preview: Buffer.from('p2') });
  assert.deepEqual((await h.list()).map((e) => e.id), [b.id, a.id]);
  assert.equal(fs.readFileSync(a.preview, 'utf8'), 'p1');
  assert.ok(a.previewVersion, 'preview version for the History window cache');

  h.flush();
  const again = new History(dir);
  assert.deepEqual((await again.list()).map((e) => e.id), [b.id, a.id]);
  assert.equal(again.get(a.id).width, 10);
});

test('removing an entry deletes PinShot’s own copy but never the user’s file', async () => {
  const dir = tmp();
  const saved = path.join(tmp(), 'Saved.png');
  fs.writeFileSync(saved, 'png');
  const h = new History(dir);
  const user = h.add({ file: saved, preview: Buffer.from('p') });
  const own = h.pathFor('Copy.png');
  fs.writeFileSync(own, 'png');
  const mine = h.add({ file: own, preview: Buffer.from('p') });
  await h.idle();

  h.remove(user.id);
  assert.ok(fs.existsSync(saved), 'user file kept');
  assert.ok(!fs.existsSync(user.preview), 'preview removed');
  h.remove(mine.id);
  assert.ok(!fs.existsSync(own), 'history copy removed');
  assert.deepEqual(await h.list(), []);
});

test('entries whose file disappeared drop out of the list', async () => {
  const dir = tmp();
  const file = path.join(tmp(), 'Gone.png');
  fs.writeFileSync(file, 'png');
  const h = new History(dir);
  h.add({ file });
  fs.rmSync(file);
  assert.deepEqual(await h.list(), []);
  h.flush();
  assert.deepEqual(await new History(dir).list(), []);
});

test('history is capped, oldest first out', async () => {
  const dir = tmp();
  const h = new History(dir, { limit: 3 });
  const files = [1, 2, 3, 4].map((n) => {
    const f = h.pathFor(`${n}.png`);
    fs.writeFileSync(f, 'png');
    return f;
  });
  for (const file of files) h.add({ file });
  assert.deepEqual((await h.list()).map((e) => path.basename(e.file)), ['4.png', '3.png', '2.png']);
  assert.ok(!fs.existsSync(files[0]), 'the oldest history copy was deleted');
});

test('update swaps the file (e.g. recording → GIF) and refreshes the preview', async () => {
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
  await h.idle();
  assert.equal(fs.readFileSync(h.get(e.id).preview, 'utf8'), 'new');
});

test('a corrupt index starts an empty history', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'history.json'), '{nope');
  assert.deepEqual(await new History(dir).list(), []);
});

test('the index is written once after a burst of changes, compactly', async () => {
  const dir = tmp();
  const h = new History(dir, { saveDelay: 20 });
  const file = path.join(tmp(), 'A.png');
  fs.writeFileSync(file, 'png');
  for (let i = 0; i < 5; i++) h.add({ file });
  assert.ok(!fs.existsSync(path.join(dir, 'history.json')), 'not written straight away');
  await new Promise((r) => setTimeout(r, 60));
  await h.idle();
  const raw = fs.readFileSync(path.join(dir, 'history.json'), 'utf8');
  assert.equal(JSON.parse(raw).length, 5);
  assert.ok(!raw.includes('\n'), 'no pretty-printing');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('a removed entry whose preview was still being written leaves nothing behind', async () => {
  const dir = tmp();
  const h = new History(dir);
  const file = path.join(tmp(), 'A.png');
  fs.writeFileSync(file, 'png');
  const e = h.add({ file, preview: Buffer.alloc(1 << 20) });
  h.remove(e.id);
  await h.idle();
  assert.ok(!fs.existsSync(e.preview));
});
