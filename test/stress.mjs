// Stress test: repeats window capture, window-mode toggling, closing thumbnails
// mid-animation and switching between live/frozen selection, 30 times. Used to
// hunt a native crash; run it after touching window lifecycles.
//
//   npm run test:stress     (Linux, xvfb)
import { Fixture, REPORT_HTML, closingKey, launchPinShot, sleep, until, waitForTitle, xclick, xmove } from './helpers.mjs';
const fixture = await Fixture.start();
const { app } = await launchPinShot();
app.process().on('exit', (c, s) => s && console.log(`PinShot crashed (${s})`));
const t = (fn, arg) => app.evaluate(fn, arg);
const NOTES = { x: 960, y: 60, width: 420, height: 300 };
await fixture.open('Desktop', { x: 0, y: 0, width: 1440, height: 900 }, REPORT_HTML);
await fixture.open('Notes', NOTES, '<body style="background:#f59e0b">notes</body>');
await sleep(800);
const visible = () => t(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.getTitle() === 'PinShot Capture' && w.isVisible()));
async function openSel() {
  await t(() => globalThis.pinshotTest.startSelection('shot'));
  const o = await waitForTitle(app, 'PinShot Capture');
  await o.waitForFunction(() => document.body.dataset.ready === '1');
  await until(visible, { what: 'selector visible' });
  return o;
}
try {
  for (let i = 0; i < 30; i++) {
    let o = await openSel();
    await o.keyboard.press('Space');
    await xclick(NOTES.x + 200, NOTES.y + 150);
    await until(() => t(() => globalThis.pinshotTest.captures.size > 0), { what: 'window capture' });
    o = await openSel();
    await o.keyboard.press('Space');
    await o.keyboard.press('Space');
    await closingKey(o, 'Escape');
    await until(async () => !(await visible()), { what: 'selector hidden' });
    await t(() => { const T = globalThis.pinshotTest; for (const c of [...T.captures.values()]) { T.trace('test close thumb'); T.closeThumb(c); } });
    await until(() => t(() => globalThis.pinshotTest.captures.size === 0), { what: 'thumbnails closed' });
    await t((_e, f) => globalThis.pinshotTest.setPreference('freezeScreen', f), i % 2 === 0);
    if (i % 10 === 9) console.log(`  ${i + 1} rounds`);
  }
  console.log('PinShot stress test passed');
} catch (e) {
  console.log('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  fixture.stop();
}
