// Multi-monitor selections. Xvfb only has one screen, so PinShot's test mode
// splits it into two virtual displays — the left at 1×, the right at 2×
// density — each with its own selector window, just like two real monitors.
//
//   xvfb-run -a -s "-screen 0 1440x900x24" node test/multimonitor.mjs
import assert from 'node:assert/strict';
import { Fixture, closingKey, xdown, xmove, xup, captureState, capturePixels, launchPinShot, sleep, snapDesktop, step, until, watchdog, windowsTitled } from './helpers.mjs';

const shots = process.env.SHOTS;
watchdog(5);
const fixture = await Fixture.start();
const { app } = await launchPinShot({ PINSHOT_FAKE_DISPLAYS: 'split' });
const t = (fn, arg) => app.evaluate(fn, arg);

// Vertical colour bands every 60px, so we can tell exactly which part of the screen ended up where.
const BAND = 60;
const bandColor = (i) => `hsl(${(i * 47) % 360} 70% 50%)`;
const html = `<body style="margin:0;display:flex">${Array.from({ length: 24 }, (_, i) => `<div style="width:${BAND}px;height:100vh;background:${bandColor(i)}"></div>`).join('')}</body>`;

const overlayState = () =>
  t(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => w.getTitle() === 'PinShot Capture')
      .map((w) => ({ visible: w.isVisible(), bounds: w.getBounds() }))
      .sort((a, b) => a.bounds.x - b.bounds.x));

async function openSelector(mode = 'shot') {
  await t((_e, m) => globalThis.pinshotTest.startSelection(m), mode);
  await until(async () => (await overlayState()).filter((o) => o.visible).length === 2, { what: 'both selectors visible' });
  const pages = await windowsTitled(app, 'PinShot Capture');
  const withX = await Promise.all(pages.map(async (p) => ({ p, x: await p.evaluate(() => window.screenX) })));
  withX.sort((a, b) => a.x - b.x);
  return withX.map((w) => w.p);
}

try {
  const bandsWin = await fixture.open('Bands', { x: 0, y: 0, width: 1440, height: 900 }, html);
  await sleep(800);

  // What the screen looks like before we start (the reference for the stitched capture).
  const xs = [615, 645, 675, 705, 735, 765, 795, 825, 855, 885];
  const reference = await t(async ({ desktopCapturer }, xs) => {
    const [s] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1440, height: 900 } });
    return xs.map((x) => {
      const b = s.thumbnail.crop({ x, y: 400, width: 1, height: 1 }).toBitmap();
      return [b[0], b[1], b[2]];
    });
  }, xs);

  step('one selector per display, each showing its own part of the screen');
  let [left, right] = await openSelector();
  assert.deepEqual(
    (await overlayState()).map((o) => o.bounds),
    [
      { x: 0, y: 0, width: 720, height: 900 },
      { x: 720, y: 0, width: 720, height: 900 },
    ],
  );
  // The right display is 2× density: its frozen image has twice the pixels.
  assert.deepEqual(await right.evaluate(() => [backdrop.width, backdrop.height]), [1440, 1800]);
  assert.deepEqual(await left.evaluate(() => [backdrop.width, backdrop.height]), [720, 900]);

  step('drag from the left display onto the right one');
  // Real pointer input: the press on the left display keeps the pointer grabbed as it crosses over.
  await xmove(600, 300);
  await xdown();
  await xmove(700, 400, { steps: 4 });
  await xmove(900, 500, { steps: 6 }); // past the left window's edge, onto the right display
  const rightSel = await until(
    () =>
      right.evaluate(() => {
        const el = document.getElementById('selection');
        if (el.hidden) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    { what: 'selection drawn on the right display' },
  );
  // Global x 600 is local -120 on the right display; its window clips the rect to the visible 0–180.
  assert.deepEqual(rightSel, { x: -120, y: 300, width: 300, height: 200 }, 'right display draws its part');
  const leftSel = await left.evaluate(() => {
    const r = document.getElementById('selection').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  assert.deepEqual(leftSel, { x: 600, y: 300, width: 300, height: 200 }, 'left display draws the whole rect (clipped by its window)');
  assert.deepEqual(
    await right.evaluate(() => [document.getElementById('readout').hidden, r1.textContent, r2.textContent]),
    [false, '300', '200'],
    'size readout follows the cursor onto the right display',
  );
  assert.equal(await left.evaluate(() => document.getElementById('readout').hidden), true);
  await snapDesktop(app, shots, 'multimonitor-drag');
  await xup();

  step('the capture stitches both displays at the higher (2×) density');
  const cap = await until(async () => (await captureState(app))[0], { what: 'capture' });
  assert.equal(cap.scale, 2);
  assert.deepEqual(cap.size, { width: 600, height: 400 });
  // Sample the middle of several bands on each side of the seam (global x → output px = (x - 600) * 2).
  const got = await capturePixels(app, cap.id, xs.map((x) => [(x - 600) * 2, 200]));
  const live = reference.map((row) => row);
  // toBitmap order may be BGRA; compare as sorted channel sets to stay order-agnostic.
  const key = (c) => [...c.slice(0, 3)].sort((a, b) => a - b).join(',');
  const close = (a, b) => key(a).split(',').every((v, i) => Math.abs(v - key(b).split(',')[i]) < 12);
  xs.forEach((x, i) => assert.ok(close(got[i], live[i]), `x=${x}: capture ${got[i]} vs screen ${live[i]}`));
  await t(() => {
    for (const c of [...globalThis.pinshotTest.captures.values()]) globalThis.pinshotTest.closeThumb(c);
  });
  await until(() => t(() => globalThis.pinshotTest.captures.size === 0), { what: 'thumbnail closed' });

  step('Esc on either display cancels both');
  [left, right] = await openSelector();
  await closingKey(right, 'Escape');
  await until(async () => (await overlayState()).every((o) => !o.visible), { what: 'both hidden' });

  step('window mode switches on every display at once');
  [left, right] = await openSelector();
  await left.keyboard.press('Space');
  await until(() => right.evaluate(() => document.body.classList.contains('window-mode')), { what: 'right in window mode' });
  await xmove(720 + 300, 300);
  const hl = await right.evaluate(() => {
    const r = document.getElementById('window-highlight').getBoundingClientRect();
    return { hidden: document.getElementById('window-highlight').hidden, x: r.x, width: r.width };
  });
  assert.deepEqual(
    hl,
    { hidden: false, x: bandsWin.x - 720, width: bandsWin.width },
    'the window spanning both displays is highlighted in display coordinates',
  );
  await closingKey(right, 'Escape');

  assert.deepEqual(await t(() => globalThis.pinshotTest.errors), []);
  console.log('PinShot multi-monitor tests passed');
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  fixture.stop();
}
