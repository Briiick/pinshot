// End-to-end smoke test: launches PinShot, captures an area, checks the
// thumbnail flies to the bottom-left corner and stays there, annotates it,
// pins it, then crops the pin.
//
//   npm run test:ui            (Linux, needs xvfb-run)
//   SHOTS=dir npm run test:ui  to also keep screenshots of each step
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closingKey, xdown, xmove, xup } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pinshot-home-'));
const shots = process.env.SHOTS;
// Fail loudly instead of hanging if something never responds.
setTimeout(() => {
  console.error('FAILED: smoke test hung');
  process.exit(1);
}, 8 * 60_000).unref();
if (shots) fs.mkdirSync(shots, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (name) => console.log(`- ${name}`);
const snap = async (page, name) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
};
const waitForTitle = async (app, title) => {
  for (let i = 0; i < 100; i++) {
    for (const w of app.windows()) {
      if (w.isClosed()) continue;
      const t = await Promise.race([w.title().catch(() => ''), sleep(500).then(() => '')]);
      if (t === title) return w;
    }
    await sleep(100);
  }
  throw new Error(`No window titled "${title}"`);
};

const app = await electron.launch({
  args: [root, '--no-sandbox'],
  env: { ...process.env, PINSHOT_TEST: '1', HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_PICTURES_DIR: path.join(home, 'Pictures') },
});

/** Screenshot of the whole (virtual) desktop, including PinShot's floating windows. */
const snapDesktop = async (name) => {
  if (!shots) return;
  const b64 = await app.evaluate(async ({ desktopCapturer }) => {
    const [s] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1440, height: 900 } });
    return s.thumbnail.toPNG().toString('base64');
  });
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(b64, 'base64'));
};

const captureState = () =>
  app.evaluate(() => {
    const t = globalThis.pinshotTest;
    return [...t.captures.values()].map((c) => ({
      id: c.id,
      size: c.image.getSize(),
      filePath: c.filePath,
      thumb: c.thumb && !c.thumb.isDestroyed() ? c.thumb.getBounds() : null,
      pin: c.pin && !c.pin.isDestroyed() ? c.pin.getBounds() : null,
    }));
  });

try {
  // Something colourful on the "desktop" to capture.
  await app.evaluate(({ BrowserWindow }) => {
    const w = new BrowserWindow({ x: 0, y: 0, width: 1440, height: 900, frame: false, title: 'Desktop' });
    const html = `<title>Desktop</title><body style="margin:0;font:28px sans-serif;background:linear-gradient(135deg,#4f46e5,#06b6d4)">
      <div style="position:absolute;left:300px;top:200px;width:560px;height:340px;background:#fff;border-radius:14px;
      padding:28px;box-shadow:0 20px 50px #0005"><h2 style="margin:0 0 12px">Quarterly report</h2>
      <p style="font-size:18px;color:#444">Revenue up 24%. Customer email: jane@example.com</p>
      <div style="display:flex;gap:12px;margin-top:30px">${[60, 120, 90, 160, 140]
        .map((h) => `<div style="width:60px;height:${h}px;background:#6366f1;align-self:flex-end"></div>`)
        .join('')}</div></div></body>`;
    w.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  });
  const desktop = await waitForTitle(app, 'Desktop');
  await desktop.waitForLoadState('load');
  await sleep(1500); // let the X server composite it before we capture

  step('area capture with the macOS-style selector');
  await app.evaluate(() => globalThis.pinshotTest.startAreaCapture());
  const overlay = await waitForTitle(app, 'PinShot Capture');
  await overlay.waitForFunction(() => document.body.dataset.ready === '1');
  await xmove(280, 180);
  await xdown();
  await xmove(600, 380, { steps: 5 });
  await xmove(880, 560, { steps: 5 });
  assert.deepEqual(
    await overlay.evaluate(() => [r1.textContent, r2.textContent]),
    ['600', '380'],
    'readout shows width and height while dragging',
  );
  await snap(overlay, '1-selecting');
  // Inputs that close their own window never get a CDP reply, so don't await them.
  await xup();

  step('screenshot flies to the bottom-left corner and stays there');
  const thumb = await waitForTitle(app, 'PinShot Quick Access');
  await sleep(120);
  await snapDesktop('2a-flying');
  await thumb.waitForFunction(() => !document.body.classList.contains('flying'), null, { timeout: 5000 });
  let [cap] = await captureState();
  assert.deepEqual(cap.size, { width: 600, height: 380 });
  assert.ok(fs.existsSync(cap.filePath), 'capture auto-saved');
  assert.deepEqual(cap.thumb, { x: 16, y: 900 - 16 - 152, width: 240, height: 152 });
  await sleep(1500);
  [cap] = await captureState();
  assert.ok(cap.thumb, 'thumbnail is still there');
  await thumb.mouse.move(120, 70); // reveal the hover actions
  await sleep(200);
  await snapDesktop('2-quick-access');

  step('the selector window is pre-built, reused and hidden between captures');
  const overlayState = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((w) => w.getTitle() === 'PinShot Capture')
        .map((w) => ({ id: w.id, visible: w.isVisible() })));
  const [firstOverlay] = await overlayState();
  assert.equal(firstOverlay.visible, false, 'hidden after a selection');
  const grabScreen = () =>
    app.evaluate(async ({ desktopCapturer }) => {
      const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1440, height: 900 } });
      globalThis.__grabs = [...(globalThis.__grabs || []), src.thumbnail.toBitmap()];
    });
  await grabScreen();
  await app.evaluate(() => globalThis.pinshotTest.startAreaCapture());
  for (let i = 0; i < 50 && !(await overlayState())[0].visible; i++) await sleep(100);
  await grabScreen();
  // The frozen screenshot must line up exactly with the real screen: no shift, squash, flash or
  // blank frame. Only the little cursor readout may differ.
  const [changed, diffBox] = await app.evaluate(() => {
    const [a, b] = globalThis.__grabs;
    let diff = 0;
    const box = [1e9, 1e9, -1, -1];
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 40) {
        diff++;
        const p = i / 4, x = p % 1440, y = Math.floor(p / 1440);
        box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
      }
    }
    return [diff / (a.length / 4), box];
  });
  assert.ok(changed < 0.001, `screen changed when the selector appeared (${(changed * 100).toFixed(2)}% of pixels, in ${diffBox})`);
  const reused = await overlayState();
  assert.equal(reused.length, 1, 'no second selector window');
  assert.deepEqual(reused[0], { id: firstOverlay.id, visible: true });
  assert.ok(await overlay.evaluate(() => document.getElementById('selection').hidden), 'old selection cleared');
  await closingKey(overlay, 'Escape');
  for (let i = 0; i < 50 && (await overlayState())[0].visible; i++) await sleep(100);
  assert.equal((await overlayState())[0].visible, false, 'Esc hides it again');
  assert.equal((await captureState()).length, 1, 'cancelling captures nothing');

  step('a second capture stacks above the first');
  await app.evaluate(() => globalThis.pinshotTest.captureFullscreen());
  // Wait for the fly-in and the reflow to finish (slower on CI machines).
  const settled = (pred, timeout = 8000) =>
    (async () => {
      const end = Date.now() + timeout;
      for (;;) {
        const s = await captureState();
        if (pred(s) || Date.now() > end) return s;
        await sleep(100);
      }
    })();
  const stacked = await settled(
    (s) =>
      s.length === 2 &&
      s.every((c) => c.thumb) &&
      s[1].thumb.y + s[1].thumb.height === 900 - 16 &&
      s[0].thumb.y + s[0].thumb.height <= s[1].thumb.y - 12,
  );
  assert.equal(stacked.length, 2);
  assert.equal(stacked[1].thumb.y + stacked[1].thumb.height, 900 - 16, 'newest at the bottom');
  assert.ok(stacked[0].thumb.y + stacked[0].thumb.height <= stacked[1].thumb.y - 12, 'older one moved up');
  await snapDesktop('2b-stack');
  // Close the fullscreen one again via its ✕ button.
  const thumbs = [];
  for (const w of app.windows()) if (!w.isClosed() && (await w.title()) === 'PinShot Quick Access') thumbs.push(w);
  const second = thumbs.find((w) => w !== thumb);
  await second.hover('body');
  second.click('[data-action="close"]').catch(() => {});
  [cap] = await settled((s) => s.length === 1 && s[0].thumb?.y === 900 - 16 - 152);
  assert.equal((await captureState()).length, 1);
  assert.equal(cap.thumb.y, 900 - 16 - 152, 'remaining thumbnail slid back down');

  step('annotate from the thumbnail');
  await thumb.hover('body');
  await thumb.click('[data-action="edit"]');
  const editor = await waitForTitle(app, 'PinShot — Annotate');
  editor.on('pageerror', (err) => console.error('editor error:', err.message));
  await editor.waitForFunction(() => window.__editorState?.doc?.crop);
  const box = await editor.locator('#canvas').boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  const drag = async (tool, from, to) => {
    await editor.keyboard.press(tool);
    await editor.mouse.move(...at(...from));
    await editor.mouse.down();
    await editor.mouse.move(...at(...to), { steps: 6 });
    await editor.mouse.up();
  };
  await drag('a', [0.85, 0.15], [0.62, 0.55]); // arrow
  await drag('r', [0.08, 0.12], [0.6, 0.32]); // rectangle around the title
  await drag('b', [0.5, 0.27], [0.86, 0.37]); // pixelate the email address
  await editor.keyboard.press('n'); // numbered steps
  await editor.mouse.click(...at(0.1, 0.75));
  await editor.mouse.click(...at(0.25, 0.68));
  await editor.keyboard.press('t'); // text
  await editor.mouse.click(...at(0.42, 0.85));
  await editor.keyboard.type('Ship it!');
  await editor.keyboard.press('Escape');
  const shapes = await editor.evaluate(() => window.__editorState.doc.shapes.map((s) => s.type));
  assert.deepEqual(shapes, ['arrow', 'rect', 'pixelate', 'step', 'step', 'text']);
  await editor.keyboard.press('Control+z');
  assert.equal(await editor.evaluate(() => window.__editorState.doc.shapes.length), 5);
  await editor.keyboard.press('Control+Shift+z');
  assert.equal(await editor.evaluate(() => window.__editorState.doc.shapes.length), 6);
  await snap(editor, '3-editor');

  const before = fs.statSync(cap.filePath).size;
  editor.click('#done').catch(() => {});
  for (let i = 0; i < 80 && fs.statSync(cap.filePath).size === before; i++) await sleep(100);
  assert.notEqual(fs.statSync(cap.filePath).size, before, 'saved file updated with annotations');
  [cap] = await captureState();
  assert.ok(cap.thumb, 'thumbnail stays after annotating');

  step('pin it from the thumbnail');
  await thumb.hover('body');
  thumb.click('[data-action="pin"]').catch(() => {});
  const pin = await waitForTitle(app, 'PinShot Pin');
  await pin.waitForFunction(() => document.getElementById('shot').naturalWidth > 0);
  [cap] = await settled((s) => s.length === 1 && !s[0].thumb && s[0].pin);
  assert.equal(cap.thumb, null, 'thumbnail closes once pinned');
  assert.deepEqual(cap.pin, { x: 280, y: 180, width: 600, height: 380 }, 'pinned where it was taken');
  await snapDesktop('4-annotated-pin');

  step('crop from the pin');
  await pin.dblclick('body', { position: { x: 300, y: 300 } });
  const editor2 = await waitForTitle(app, 'PinShot — Annotate');
  await editor2.waitForFunction(() => window.__editorState?.doc?.crop);
  const box2 = await editor2.locator('#canvas').boundingBox();
  await editor2.keyboard.press('c');
  await editor2.mouse.move(box2.x + 10, box2.y + 10);
  await editor2.mouse.down();
  await editor2.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2, { steps: 5 });
  await editor2.mouse.up();
  await editor2.keyboard.press('Enter'); // apply crop
  await closingKey(editor2, 'Enter');
  [cap] = await settled((s) => s[0] && s[0].size.width < 600);
  assert.ok(cap.size.width < 600 && cap.size.height < 380, `cropped to ${JSON.stringify(cap.size)}`);

  /** Recording dimensions + duration, read by actually loading the file in Chromium. */
  const probeVideo = async (file) => {
    await app.evaluate(({ BrowserWindow }, f) => {
      const w = new BrowserWindow({ show: false, width: 400, height: 300 });
      w.loadFile(f);
    }, file);
    let page;
    for (let i = 0; i < 50 && !page; i++) {
      page = app.windows().find((w) => !w.isClosed() && decodeURIComponent(w.url()).endsWith(path.basename(file)));
      if (!page) await sleep(100);
    }
    const info = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const v = document.querySelector('video');
          const done = () => resolve({ width: v.videoWidth, height: v.videoHeight });
          if (v.readyState >= 1) done();
          else v.addEventListener('loadedmetadata', done);
        }),
    );
    page.close().catch(() => {});
    return info;
  };
  const header = (file) => fs.readFileSync(file).subarray(0, 12);
  const isVideoFile = (file) =>
    file.endsWith('.mp4') ? header(file).toString('latin1', 4, 8) === 'ftyp' : header(file).readUInt32BE(0) === 0x1a45dfa3;
  const videos = async () => (await captureState()).filter((c) => c.filePath && /\.(mp4|webm)$/.test(c.filePath));

  step('record an area of the screen');
  await app.evaluate(() => { for (const c of globalThis.pinshotTest.captures.values()) c.pin?.close(); });
  await app.evaluate(() => globalThis.pinshotTest.toggleRecording());
  await overlay.waitForFunction(() => document.body.dataset.ready === '1' && !document.getElementById('hint').hidden);
  await snap(overlay, '5-record-select');
  await xmove(280, 180);
  await xdown();
  await xmove(880, 560, { steps: 6 });
  await xup();
  const bar = await waitForTitle(app, 'PinShot Recording');
  await bar.waitForFunction(() => !document.body.classList.contains('starting'), null, { timeout: 10000 });
  const recWindows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => w.isVisible())
      .map((w) => ({ title: w.getTitle(), ...w.getBounds() })));
  const strips = recWindows.filter((w) => w.title === 'PinShot Recording Outline');
  assert.equal(strips.length, 4, 'four outline strips');
  const area = { x: 280, y: 180, width: 600, height: 380 };
  const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  for (const w of recWindows) {
    if (w.title.startsWith('PinShot Recording')) assert.ok(!overlaps(w, area), `${w.title} must not cover the recorded area`);
  }
  assert.equal(recWindows.find((w) => w.title === 'PinShot Recording').y, 560 + 12, 'controls sit just below the area');
  // Animate something inside the area so the video has motion in it.
  await desktop.evaluate(() => {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:400px;top:420px;width:60px;height:60px;background:#f43f5e;transition:left 1.5s linear';
    document.body.appendChild(box);
    requestAnimationFrame(() => { box.style.left = '760px'; });
  });
  await sleep(2200);
  await snapDesktop('5-recording');
  await app.evaluate(() => globalThis.pinshotTest.toggleRecording()); // ⌘⇧5 again stops it
  for (let i = 0; i < 50 && !(await videos()).length; i++) await sleep(100);
  const [clip] = await videos();
  assert.ok(clip, 'recording became a thumbnail');
  assert.ok(isVideoFile(clip.filePath), `valid video container: ${clip.filePath}`);
  assert.equal(await app.evaluate(() => globalThis.pinshotTest.isRecording()), false);
  assert.deepEqual(await probeVideo(clip.filePath), { width: 600, height: 380 }, 'video is cropped to the area');
  if (process.env.FFMPEG !== '0') {
    // Pull the last frame and make sure it shows the screen, not black.
    const { execFileSync } = await import('node:child_process');
    try {
      const raw = execFileSync('ffmpeg', ['-v', 'error', '-sseof', '-0.5', '-i', clip.filePath, '-frames:v', '1',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
      let bright = 0;
      for (let i = 0; i < raw.length; i += 3) if (raw[i] + raw[i + 1] + raw[i + 2] > 150) bright++;
      assert.ok(bright / (raw.length / 3) > 0.5, 'recorded frames show the screen content');
    } catch (err) {
      if (err.code === 'ENOENT') console.log('  (ffmpeg not installed: skipping frame content check)');
      else throw err;
    }
  }
  const clipThumb = await waitForTitle(app, 'PinShot Quick Access');
  await sleep(700);
  await snapDesktop('6-recording-thumbnail');
  console.log(`  recorded ${path.basename(clip.filePath)} (${fs.statSync(clip.filePath).size} bytes)`);

  step('record the full screen with Enter');
  await app.evaluate(() => globalThis.pinshotTest.toggleRecording());
  await overlay.waitForFunction(() => document.body.dataset.ready === '1');
  await closingKey(overlay, 'Enter');
  const bar2 = await waitForTitle(app, 'PinShot Recording');
  await bar2.waitForFunction(() => !document.body.classList.contains('starting'), null, { timeout: 10000 });
  await sleep(1200);
  bar2.click('#stop').catch(() => {});
  for (let i = 0; i < 50 && (await videos()).length < 2; i++) await sleep(100);
  const full = (await videos()).find((c) => c.filePath !== clip.filePath);
  assert.deepEqual(await probeVideo(full.filePath), { width: 1440, height: 900 });

  step('discarding a recording leaves nothing behind');
  const before2 = fs.readdirSync(path.dirname(full.filePath)).length;
  await app.evaluate(() => globalThis.pinshotTest.toggleRecording());
  await overlay.waitForFunction(() => document.body.dataset.ready === '1');
  await closingKey(overlay, 'Enter');
  const bar3 = await waitForTitle(app, 'PinShot Recording');
  await bar3.waitForFunction(() => !document.body.classList.contains('starting'), null, { timeout: 10000 });
  await sleep(1200);
  bar3.click('#discard').catch(() => {});
  await sleep(800);
  assert.equal(fs.readdirSync(path.dirname(full.filePath)).length, before2, 'no file kept');
  assert.equal((await videos()).length, 2, 'no thumbnail for a discarded recording');
  void clipThumb;

  console.log('PinShot UI smoke test passed');
} finally {
  await app.close();
}
