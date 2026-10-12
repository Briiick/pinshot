// Capture History, and dragging a thumbnail out of the corner into it.
//
//   xvfb-run -a -s "-screen 0 1440x900x24" node test/history.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Fixture, REPORT_HTML, captureState, launchPinShot, sleep, snapDesktop, step, stubDialog, until, waitForTitle, watchdog, xdown, xmove, xup } from './helpers.mjs';

const shots = process.env.SHOTS;
watchdog(4);
const fixture = await Fixture.start();
const { app, pictures } = await launchPinShot();
const t = (fn, arg) => app.evaluate(fn, arg);
const historyList = () => t(() => globalThis.pinshotTest.historyList());

/** Take a full-screen capture and wait for its thumbnail to land in the corner. */
async function shoot() {
  const before = new Set((await captureState(app)).map((c) => c.id));
  await t(() => globalThis.pinshotTest.captureFullscreen());
  const cap = await until(async () => (await captureState(app)).find((c) => !before.has(c.id)), { what: 'capture' });
  await until(() => t((_e, id) => globalThis.pinshotTest.captures.get(id)?.thumb?.landed, cap.id), { what: 'thumbnail landed' });
  return (await captureState(app)).find((c) => c.id === cap.id);
}

/** Real mouse drag starting on a thumbnail. */
async function dragFrom(bounds, to) {
  const from = [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2];
  await xmove(...from);
  await sleep(150); // hover controls appear
  await xdown();
  await xmove(from[0] + 8, from[1] - 8, { steps: 2 });
  await xmove(...to, { steps: 12 });
  await sleep(200);
  await xup();
}

try {
  await fixture.open('Report', { x: 300, y: 120, width: 800, height: 520 }, REPORT_HTML);
  await sleep(500);

  step('every capture goes into the history');
  const a = await shoot();
  let list = await historyList();
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'image');
  assert.ok(list[0].preview, 'has a preview');
  assert.equal(fs.readdirSync(pictures).length, 1, 'auto-saved once');

  step('dragging the thumbnail out into another app sends it to the history');
  await dragFrom(a.thumb, [700, 380]);
  await until(async () => !(await captureState(app)).some((c) => c.id === a.id), { what: 'thumbnail gone', timeout: 15000 });
  assert.deepEqual(await t(() => globalThis.pinshotTest.drags), [{ id: a.id, dropped: true }]);
  assert.equal((await historyList()).length, 1, 'still in the history');
  await snapDesktop(app, shots, 'history-dragged-out');

  step('a drag released back on the thumbnail keeps it');
  const b = await shoot();
  await dragFrom(b.thumb, [b.thumb.x + b.thumb.width / 2 + 20, b.thumb.y + b.thumb.height / 2 - 20]);
  await until(async () => (await t(() => globalThis.pinshotTest.drags)).length === 2, { what: 'second drag' });
  assert.deepEqual((await t(() => globalThis.pinshotTest.drags))[1], { id: b.id, dropped: false });
  await sleep(400);
  assert.ok((await captureState(app)).find((c) => c.id === b.id)?.thumb, 'thumbnail stays');
  await t((_e, id) => globalThis.pinshotTest.closeThumb(globalThis.pinshotTest.captures.get(id)), b.id);

  step('screenshots that are not auto-saved are kept in the history folder');
  await t(() => globalThis.pinshotTest.setPreference('autoSave', false));
  const c = await shoot();
  assert.equal(c.filePath, null);
  const owned = await t((_e, id) => {
    const capture = globalThis.pinshotTest.captures.get(id);
    const h = globalThis.pinshotTest.history();
    return { file: h.get(capture.historyId).file, owned: h.owns(h.get(capture.historyId).file) };
  }, c.id);
  assert.ok(owned.owned && fs.existsSync(owned.file), 'copy in the history folder');
  assert.equal(fs.readdirSync(pictures).length, 2, 'nothing new in the save folder');
  await t((_e, id) => globalThis.pinshotTest.closeThumb(globalThis.pinshotTest.captures.get(id)), c.id);
  await until(async () => (await captureState(app)).length === 0, { what: 'thumbnails closed' });

  step('the History window lists them, newest first');
  assert.ok((await t(() => globalThis.pinshotTest.trayTemplate())).some((i) => i.label === 'Capture History…'));
  await t(() => globalThis.pinshotTest.openHistory());
  const page = await waitForTitle(app, 'PinShot History');
  const cards = () => page.evaluate(() => [...document.querySelectorAll('.card')].map((el) => el.dataset.id));
  list = await historyList();
  await until(async () => (await cards()).length === 3, { what: '3 cards' });
  assert.deepEqual(await cards(), list.map((e) => e.id));
  assert.equal(await page.evaluate(() => document.querySelector('h2').textContent), 'Today');
  await until(() => page.evaluate(() => [...document.querySelectorAll('.card img')].every((i) => i.complete && i.naturalWidth > 0)), { what: 'previews loaded' });
  await page.hover('.card');
  await snapDesktop(app, shots, 'history-window');

  step('filter: no recordings yet shows the empty state');
  await page.click('#filter [data-filter=video]');
  assert.equal(await page.evaluate(() => document.getElementById('empty').hidden), false);
  await page.click('#filter [data-filter=all]');
  assert.equal(await page.evaluate(() => document.getElementById('empty').hidden), true);

  step('double-click brings a capture back to the corner');
  const oldest = list[2].id;
  await page.dblclick(`.card[data-id="${oldest}"] img`, { position: { x: 30, y: 20 } });
  const back = await until(async () => {
    const c = await t((_e, hid) => [...globalThis.pinshotTest.captures.values()].find((c) => c.historyId === hid && c.thumb?.landed)?.id, oldest);
    return c && (await captureState(app)).find((s) => s.id === c);
  }, { what: 'restored thumbnail' });
  assert.equal(back.filePath, list[2].file ?? back.filePath);
  assert.deepEqual(back.size, a.size, 'full-size screenshot');
  assert.equal((await historyList()).length, 3, 'not duplicated in the history');

  step('copy and pin from the history');
  await t(({ clipboard }) => clipboard.writeText('nothing yet'));
  await page.hover(`.card[data-id="${list[1].id}"]`);
  await page.click(`.card[data-id="${list[1].id}"] [data-action=copy]`);
  await until(
    () => t(async ({ clipboard }) => (await clipboard.read()).some((item) => item.types.includes('image/png'))),
    { what: 'image on clipboard' },
  );
  await page.hover(`.card[data-id="${list[1].id}"]`);
  await page.click(`.card[data-id="${list[1].id}"] [data-action=pin]`);
  await until(async () => (await captureState(app)).some((s) => s.pin), { what: 'pin from history' });

  step('delete removes it; PinShot’s own copy goes too');
  await page.hover(`.card[data-id="${list[0].id}"]`);
  await page.click(`.card[data-id="${list[0].id}"] [data-action=delete]`);
  await until(async () => (await cards()).length === 2, { what: '2 cards' });
  assert.ok(!fs.existsSync(owned.file), 'history copy deleted');
  await page.focus(`.card[data-id="${list[1].id}"]`);
  await page.keyboard.press('Delete');
  await until(async () => (await cards()).length === 1, { what: '1 card' });
  assert.equal(fs.readdirSync(pictures).length, 2, 'saved screenshots are never deleted');

  step('Clear… empties it after confirming');
  await stubDialog(app, 'showMessageBox', { response: 0 });
  await page.click('#clear');
  await until(() => page.evaluate(() => !document.getElementById('empty').hidden), { what: 'empty history' });
  assert.deepEqual(await historyList(), []);

  assert.deepEqual(await t(() => globalThis.pinshotTest.errors), []);
  console.log('PinShot history tests passed');
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  fixture.stop();
}
