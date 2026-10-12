// End-to-end tests for everything beyond the basic capture → annotate → pin
// flow (that's smoke.mjs): window capture, Capture Text (OCR), thumbnail
// actions, pins, every editor tool, Preferences, settings toggles, scrolling
// capture and GIF export. Another app's windows come from test/fixture.
//
//   xvfb-run -a -s "-screen 0 1440x900x24" node test/features.mjs
//   SHOTS=dir … to keep screenshots
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Fixture,
  REPORT_HTML,
  closingKey,
  xclick,
  xdrag,
  xmove,
  captureState,
  capturePixels,
  launchPinShot,
  sleep,
  snapDesktop,
  step,
  stubDialog,
  until,
  waitForTitle,
  watchdog,
  windowsTitled,
} from './helpers.mjs';

const shots = process.env.SHOTS;
const fixture = await Fixture.start();
const { app, pictures } = await launchPinShot();
watchdog(8, async () => {
  // Where is PinShot's main thread stuck? (Debug aid: needs gdb.)
  try {
    const out = execFileSync('gdb', ['-p', String(app.process().pid), '-batch', '-ex', 'thread apply 1 bt 40'], {
      timeout: 60000,
    }).toString();
    console.error('main thread stack:\n' + out.split('\n').filter((l) => /^#/.test(l)).join('\n'));
  } catch (err) {
    console.error('no stack:', err.message);
  }
  const state = await app.evaluate(({ BrowserWindow }) => ({
    windows: BrowserWindow.getAllWindows().filter((w) => w.isVisible()).map((w) => w.getTitle()),
    errors: globalThis.pinshotTest.errors,
  }));
  console.error('state at hang:', JSON.stringify(state));
});
const t = (fn, arg) => app.evaluate(fn, arg);
const latest = async (kind) => (await captureState(app)).filter((c) => !kind || c.kind === kind).sort((a, b) => b.id - a.id)[0];
/** Close every thumbnail, pin and editor the way the app does (gracefully), and wait until they're gone. */
const closeAll = async () => {
  await t(() => {
    const T = globalThis.pinshotTest;
    for (const c of [...T.captures.values()]) {
      T.closeThumb(c);
      for (const w of [c.pin, c.editor]) if (w && !w.isDestroyed()) w.close();
    }
  });
  await until(() => t(() => globalThis.pinshotTest.captures.size === 0), { what: 'everything closed' });
};
const readClipboardText = () => t(({ clipboard }) => clipboard.readText());
const clipboardImageBytes = () =>
  t(async ({ clipboard }) => {
    const items = await clipboard.read();
    const item = items.find((i) => i.types.includes('image/png'));
    return item ? (await (await item.getType('image/png')).arrayBuffer()).byteLength : 0;
  });

/** Open the selector in a mode and wait until it's on screen. */
async function openSelector(mode) {
  await t((_e, m) => globalThis.pinshotTest.startSelection(m), mode);
  const overlay = await waitForTitle(app, 'PinShot Capture');
  await overlay.waitForFunction(() => document.body.dataset.ready === '1');
  await until(() => t(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.getTitle() === 'PinShot Capture' && w.isVisible())));
  return overlay;
}

async function dragIn(_page, from, to) {
  await xdrag(from, to); // real pointer input: see xdo() in helpers.mjs
}

const NOTES = { x: 960, y: 60, width: 420, height: 300 };
const FEED = { x: 960, y: 420, width: 420, height: 440 };

try {
  // "Another app": a report covering the screen, a notes window and a long scrolling feed.
  await fixture.open('Desktop', { x: 0, y: 0, width: 1440, height: 900 }, REPORT_HTML);
  await fixture.open(
    'Notes',
    NOTES,
    `<body style="margin:0;background:#f59e0b;font:22px sans-serif;padding:20px">Meeting notes<br>• Ship PinShot</body>`,
  );
  const rows = Array.from(
    { length: 160 },
    (_, i) =>
      `<div style="height:28px;padding:0 12px;display:flex;align-items:center;background:${i % 2 ? '#eef2ff' : '#fff'};color:hsl(${(i * 37) % 360} 60% 35%)">` +
      `Row ${String(i + 1).padStart(3, '0')} · ${'▮'.repeat((i * 7) % 13 + 2)}</div>`,
  ).join('');
  await fixture.open('Feed', FEED, `<body style="margin:0;font:15px sans-serif;overflow-y:scroll;height:100vh">${rows}</body>`);
  await sleep(800);

  // ---------------------------------------------------------------------------
  step('crosshair and coordinates appear at the cursor straight away, without moving the mouse');
  for (const freeze of [true, false]) {
    await t((_e, f) => globalThis.pinshotTest.setPreference('freezeScreen', f), freeze);
    execFileSync('xdotool', ['mousemove', '500', '400']);
    await sleep(300);
    const sel = await openSelector('shot');
    const at = await until(
      () =>
        sel.evaluate(() => {
          const r = document.getElementById('readout');
          return r.hidden ? null : { x: r1.textContent, y: r2.textContent, cursor: getComputedStyle(document.body).cursor };
        }),
      { timeout: 3000, what: `readout without a mouse move (${freeze ? 'frozen' : 'live'})` },
    );
    assert.deepEqual(at, { x: '500', y: '400', cursor: 'crosshair' });
    await closingKey(sel, 'Escape');
    await until(() => t(({ BrowserWindow }) => !BrowserWindow.getAllWindows().some((w) => w.getTitle() === 'PinShot Capture' && w.isVisible())), { what: 'selector hidden' });
  }
  await t(() => globalThis.pinshotTest.setPreference('freezeScreen', true));

  // ---------------------------------------------------------------------------
  step('window capture: Space switches to window mode, hover highlights, click captures');
  let overlay = await openSelector('shot');
  await overlay.keyboard.press('Space');
  await xmove(NOTES.x + 200, NOTES.y + 150);
  const hl = await overlay.evaluate(() => {
    const el = document.getElementById('window-highlight');
    const r = el.getBoundingClientRect();
    return { hidden: el.hidden, x: r.x, y: r.y, width: r.width, height: r.height, mode: document.body.classList.contains('window-mode') };
  });
  assert.equal(hl.mode, true, 'window mode on');
  assert.deepEqual({ x: hl.x, y: hl.y, width: hl.width, height: hl.height, hidden: hl.hidden }, { ...NOTES, hidden: false });
  await snapDesktop(app, shots, 'window-mode');
  await xclick(NOTES.x + 200, NOTES.y + 150);
  const win = await until(async () => (await latest('image'))?.size.width === NOTES.width && (await latest('image')), { what: 'window capture' });
  assert.deepEqual(win.size, { width: NOTES.width, height: NOTES.height });
  const [[r, g, b]] = await capturePixels(app, win.id, [[5, 5]]);
  assert.ok(Math.abs(r - 245) < 8 && Math.abs(g - 158) < 8 && Math.abs(b - 11) < 8, `window pixels are the notes window (${r},${g},${b})`);
  assert.deepEqual((await t(() => globalThis.pinshotTest.errors)), []);

  step('window mode can be toggled back off with Space');
  overlay = await openSelector('shot');
  await overlay.keyboard.press('Space');
  await overlay.keyboard.press('Space');
  assert.equal(await overlay.evaluate(() => document.body.classList.contains('window-mode')), false);
  await closingKey(overlay, 'Escape');
  // …but make sure it has landed, so a late Esc can't cancel the next selection.
  await until(() => t(({ BrowserWindow }) => !BrowserWindow.getAllWindows().some((w) => w.getTitle() === 'PinShot Capture' && w.isVisible())), { what: 'selector hidden' });
  await closeAll();

  // ---------------------------------------------------------------------------
  step('live selection (no frozen screen): appears instantly, captures the real screen');
  await t(() => globalThis.pinshotTest.setPreference('freezeScreen', false));
  const t0 = Date.now();
  overlay = await openSelector('shot');
  const shownIn = Date.now() - t0;
  assert.deepEqual(
    await overlay.evaluate(() => [document.body.classList.contains('live'), document.getElementById('backdrop').width]),
    [true, 1],
    'no frozen copy of the screen',
  );
  console.log(`  selector on screen ${shownIn} ms after the shortcut`);
  // (On this test display see-through windows render opaque, so a capture of
  // the selector itself would come out black instead of the notes window.)
  await dragIn(overlay, [NOTES.x + 10, NOTES.y + 10], [NOTES.x + 210, NOTES.y + 110]);
  const liveShot = await until(async () => (await latest('image')) || null, { what: 'live capture' });
  assert.deepEqual(liveShot.size, { width: 200, height: 100 });
  const [[lr, lg, lb]] = await capturePixels(app, liveShot.id, [[190, 90]]);
  assert.ok(Math.abs(lr - 245) < 8 && Math.abs(lg - 158) < 8 && Math.abs(lb - 11) < 8, `real screen, not the selector (${lr},${lg},${lb})`);
  await closeAll();

  step('live selection: Space before the window list arrives still switches to window mode');
  overlay = await openSelector('shot');
  await overlay.keyboard.press('Space');
  await overlay.waitForFunction(() => document.body.classList.contains('window-mode'));
  await xclick(NOTES.x + 200, NOTES.y + 150);
  const liveWin = await until(async () => (await latest('image')) || null, { what: 'live window capture' });
  assert.deepEqual(liveWin.size, { width: NOTES.width, height: NOTES.height });
  await closeAll();
  await t(() => globalThis.pinshotTest.setPreference('freezeScreen', true));

  // ---------------------------------------------------------------------------
  step('Capture Text: OCR an area straight to the clipboard');
  await t(({ clipboard }) => clipboard.writeText('nothing yet'));
  overlay = await openSelector('text');
  assert.match(await overlay.evaluate(() => document.getElementById('hint').textContent), /text to copy/);
  await dragIn(overlay, [310, 210], [850, 340]);
  const text = await until(async () => {
    const v = await readClipboardText();
    return v !== 'nothing yet' && v;
  }, { timeout: 30000, what: 'OCR result' });
  assert.match(text, /Quarterly report/);
  assert.match(text, /jane@example\.com/);
  const hud = await t(() => globalThis.pinshotTest.hud());
  assert.match(hud.message, /^Copied \d+ characters$/);
  assert.equal((await captureState(app)).length, 0, 'Capture Text makes no screenshot');
  console.log(`  read: ${JSON.stringify(text)}`);

  step('Copy Text from a screenshot thumbnail');
  overlay = await openSelector('shot');
  await dragIn(overlay, [310, 210], [850, 340]);
  let thumb = await waitForTitle(app, 'PinShot Quick Access');
  await thumb.waitForFunction(() => !document.body.classList.contains('flying'));
  await t(({ clipboard }) => clipboard.writeText('nothing yet'));
  await thumb.hover('body');
  await thumb.click('[data-action="text"]');
  const text2 = await until(async () => {
    const v = await readClipboardText();
    return v !== 'nothing yet' && v;
  }, { timeout: 30000, what: 'thumbnail OCR' });
  assert.match(text2, /Quarterly report/);

  // ---------------------------------------------------------------------------
  step('thumbnail Copy puts the PNG on the clipboard and dismisses it');
  await t(({ clipboard }) => clipboard.writeText('text, not an image'));
  let cap = await latest('image');
  thumb.click('[data-action="copy"]').catch(() => {});
  await until(async () => (await clipboardImageBytes()) > 0, { what: 'image on clipboard' });
  await until(async () => !(await captureState(app)).find((c) => c.id === cap.id), { what: 'thumbnail dismissed' });

  step('thumbnail Save writes the file where you choose');
  overlay = await openSelector('shot');
  await dragIn(overlay, [310, 210], [610, 410]);
  thumb = await waitForTitle(app, 'PinShot Quick Access');
  await thumb.waitForFunction(() => !document.body.classList.contains('flying'));
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pinshot-out-')), 'saved.png');
  await stubDialog(app, 'showSaveDialog', { canceled: false, filePath: out });
  await thumb.hover('body');
  thumb.click('[data-action="save"]').catch(() => {});
  await until(() => fs.existsSync(out), { what: 'saved file' });
  assert.equal(fs.readFileSync(out).subarray(1, 4).toString(), 'PNG');
  await until(async () => (await captureState(app)).length === 0, { what: 'thumbnail dismissed after save' });

  step('Save as JPEG');
  overlay = await openSelector('shot');
  await dragIn(overlay, [310, 210], [610, 410]);
  thumb = await waitForTitle(app, 'PinShot Quick Access');
  await thumb.waitForFunction(() => !document.body.classList.contains('flying'));
  const outJpg = out.replace('.png', '.jpg');
  await stubDialog(app, 'showSaveDialog', { canceled: false, filePath: outJpg });
  await thumb.hover('body');
  thumb.click('[data-action="save"]').catch(() => {});
  await until(() => fs.existsSync(outJpg), { what: 'saved jpeg' });
  assert.equal(fs.readFileSync(outJpg).readUInt16BE(0), 0xffd8, 'JPEG magic');

  // ---------------------------------------------------------------------------
  step('pins: drag, scroll-zoom, actual size, opacity, hide/show all, menu, Esc');
  overlay = await openSelector('shot');
  await dragIn(overlay, [310, 210], [610, 410]);
  thumb = await waitForTitle(app, 'PinShot Quick Access');
  await thumb.waitForFunction(() => !document.body.classList.contains('flying'));
  await thumb.hover('body');
  thumb.click('[data-action="pin"]').catch(() => {});
  const pin = await waitForTitle(app, 'PinShot Pin');
  await pin.waitForFunction(() => document.getElementById('shot').naturalWidth > 0);
  await sleep(200);
  cap = await latest('image');
  assert.deepEqual(cap.pin, { x: 310, y: 210, width: 300, height: 200 });
  // Drag with the real X pointer (xdotool), as a person would.
  const xdo = (...args) => execFileSync('xdotool', args.map(String));
  xdo('mousemove', 460, 360);
  await sleep(100);
  xdo('mousedown', 1);
  for (let i = 1; i <= 8; i++) {
    xdo('mousemove', 460 + i * 5, 360 + Math.round(i * 2.5));
    await sleep(40);
  }
  xdo('mouseup', 1);
  await sleep(200);
  cap = await latest('image');
  assert.deepEqual([cap.pin.x, cap.pin.y], [350, 230], 'dragged by (40, 20)');
  await pin.mouse.wheel(0, -120);
  await sleep(150);
  cap = await latest('image');
  assert.ok(cap.pin.width > 300, `scroll up zooms in (${cap.pin.width})`);
  assert.equal(Math.round((cap.pin.width / cap.pin.height) * 100), 150, 'keeps aspect ratio');
  await pin.keyboard.press('Control+0');
  await sleep(150);
  cap = await latest('image');
  assert.deepEqual([cap.pin.width, cap.pin.height], [300, 200], 'actual size');
  await pin.keyboard.down('Alt');
  await pin.mouse.wheel(0, 120);
  await pin.mouse.wheel(0, 120);
  await pin.keyboard.up('Alt');
  await sleep(150);
  const opacity = await t(() => [...globalThis.pinshotTest.captures.values()].find((c) => c.pin).pin.getOpacity());
  assert.ok(opacity < 0.95 && opacity > 0.8, `alt+scroll lowers opacity (${opacity})`);
  const tray = () => t(() => globalThis.pinshotTest.trayTemplate().map((i) => i.label).filter(Boolean));
  assert.ok((await tray()).includes('Hide All Pins'));
  await t(() => globalThis.pinshotTest.trayTemplate().find((i) => i.label === 'Hide All Pins').click());
  assert.equal(await t(() => [...globalThis.pinshotTest.captures.values()].find((c) => c.pin).pin.isVisible()), false);
  assert.ok((await tray()).includes('Show All Pins'));
  await t(() => globalThis.pinshotTest.trayTemplate().find((i) => i.label === 'Show All Pins').click());
  assert.equal(await t(() => [...globalThis.pinshotTest.captures.values()].find((c) => c.pin).pin.isVisible()), true);
  const menu = await t(() => {
    const c = [...globalThis.pinshotTest.captures.values()].find((x) => x.pin);
    return globalThis.pinshotTest.pinMenuTemplate(c).map((i) => i.label).filter(Boolean);
  });
  assert.deepEqual(menu.slice(0, 5), ['Annotate…', 'Copy', 'Copy Text', 'Save As…', 'Show in Folder']);
  await t(() => {
    const c = [...globalThis.pinshotTest.captures.values()].find((x) => x.pin);
    globalThis.pinshotTest.pinMenuTemplate(c).find((i) => i.label === 'Opacity (85%)' || i.label?.startsWith('Opacity')).submenu[0].click();
  });
  assert.equal(await t(() => [...globalThis.pinshotTest.captures.values()].find((c) => c.pin).pin.getOpacity()), 1, 'opacity preset 100%');
  await closingKey(pin, 'Escape');
  await until(async () => !(await captureState(app)).some((c) => c.pin), { what: 'pin closed with Esc' });

  // ---------------------------------------------------------------------------
  step('editor: every drawing tool, select/move/recolour/nudge/delete, copy and save');
  overlay = await openSelector('shot');
  await dragIn(overlay, [310, 210], [870, 550]);
  thumb = await waitForTitle(app, 'PinShot Quick Access');
  await thumb.waitForFunction(() => !document.body.classList.contains('flying'));
  await thumb.dblclick('body', { position: { x: 40, y: 70 } }); // clear of the buttons
  const editor = await waitForTitle(app, 'PinShot — Annotate');
  editor.on('pageerror', (err) => console.error('editor error:', err.message));
  await editor.waitForFunction(() => window.__editorState?.doc?.crop);
  const box = await editor.locator('#canvas').boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  const draw = async (key, pts) => {
    await editor.keyboard.press(key);
    await editor.mouse.move(...at(...pts[0]));
    await editor.mouse.down();
    for (const p of pts.slice(1)) await editor.mouse.move(...at(...p), { steps: 4 });
    await editor.mouse.up();
  };
  await draw('l', [[0.1, 0.1], [0.4, 0.2]]); // line
  await draw('o', [[0.5, 0.1], [0.7, 0.3]]); // ellipse
  await draw('p', [[0.1, 0.5], [0.2, 0.6], [0.3, 0.5], [0.4, 0.6]]); // pen
  await draw('h', [[0.1, 0.8], [0.5, 0.8]]); // highlighter
  await editor.keyboard.press('Shift+?'); // a stray key does nothing
  let doc = await editor.evaluate(() => window.__editorState.doc.shapes.map((s) => s.type));
  assert.deepEqual(doc, ['line', 'ellipse', 'pen', 'highlighter']);
  await editor.keyboard.press('3'); // thick
  await editor.keyboard.press('v');
  await editor.mouse.click(...at(0.25, 0.15)); // select the line
  assert.equal(await editor.evaluate(() => window.__editorState.selectedId), 1);
  await editor.click('.swatch[data-color="#0a84ff"]');
  const line = () => editor.evaluate(() => window.__editorState.doc.shapes[0]);
  assert.equal((await line()).color, '#0a84ff', 'recoloured');
  const before = await line();
  await editor.mouse.move(...at(0.25, 0.15));
  await editor.mouse.down();
  await editor.mouse.move(...at(0.3, 0.25), { steps: 4 });
  await editor.mouse.up();
  const moved = await line();
  assert.ok(moved.x1 > before.x1 && moved.y1 > before.y1, 'dragged the line');
  await editor.keyboard.press('ArrowRight');
  assert.equal((await line()).x1, moved.x1 + 1, 'arrow key nudges by 1px');
  await editor.keyboard.press('Shift+ArrowDown');
  assert.equal((await line()).y1, moved.y1 + 10, 'shift+arrow nudges by 10px');
  await editor.keyboard.press('Delete');
  doc = await editor.evaluate(() => window.__editorState.doc.shapes.map((s) => s.type));
  assert.deepEqual(doc, ['ellipse', 'pen', 'highlighter'], 'deleted');
  await editor.keyboard.press('Control+z');
  assert.equal(await editor.evaluate(() => window.__editorState.doc.shapes.length), 4, 'undo the delete');
  await t(({ clipboard }) => clipboard.writeText('text'));
  await editor.click('#copy');
  await until(async () => (await clipboardImageBytes()) > 0, { what: 'editor copy' });
  const edOut = path.join(path.dirname(out), 'annotated.png');
  await stubDialog(app, 'showSaveDialog', { canceled: false, filePath: edOut });
  await editor.click('#save');
  await until(() => fs.existsSync(edOut), { what: 'editor save' });
  await snapDesktop(app, shots, 'editor-tools');
  await stubDialog(app, 'showMessageBox', { response: 1 }); // "Keep Editing"
  await editor.click('#cancel');
  await sleep(300);
  assert.equal((await windowsTitled(app, 'PinShot — Annotate')).length, 1, 'Keep Editing keeps the editor open');
  await stubDialog(app, 'showMessageBox', { response: 0 }); // "Discard"
  editor.click('#cancel').catch(() => {});
  await until(async () => !(await windowsTitled(app, 'PinShot — Annotate')).length, { what: 'editor closed' });
  await closeAll();

  // ---------------------------------------------------------------------------
  step('Preferences: record shortcuts, refuse duplicates, clear, toggles, recording format');
  await t(() => globalThis.pinshotTest.openPreferences());
  const prefs = await waitForTitle(app, 'PinShot Preferences');
  await prefs.waitForFunction(() => document.body.dataset.ready === '1');
  prefs.on('close', () => console.log('  [prefs page closed]'));
  prefs.on('crash', () => console.log('  [prefs page crashed]'));
  prefs.on('framenavigated', (f) => console.log(`  [prefs navigated to ${f.url()}]`));
  prefs.on('pageerror', (e) => console.log(`  [prefs error ${e.message}]`));
  await snapDesktop(app, shots, 'preferences');
  if (shots) await prefs.screenshot({ path: path.join(shots, 'preferences-window.png') });
  const settings = () => t(() => globalThis.pinshotTest.settings().data);
  const registered = (a) => t(({ globalShortcut }, acc) => globalShortcut.isRegistered(acc), a);
  assert.equal(await registered('CommandOrControl+Shift+2'), true, 'default Capture Text shortcut');
  await prefs.click('.shortcut[data-name="captureText"]');
  assert.equal(await registered('CommandOrControl+Shift+2'), false, 'shortcuts pause while recording keys');
  await prefs.keyboard.press('Control+Shift+K');
  await until(async () => (await settings()).shortcuts.captureText === 'CommandOrControl+Shift+K', { what: 'new shortcut saved' });
  assert.equal(await registered('CommandOrControl+Shift+K'), true);
  assert.equal(await registered('CommandOrControl+Shift+2'), false);
  assert.equal(await registered('CommandOrControl+Shift+4'), true, 'other shortcuts resumed');
  assert.equal(await prefs.textContent('.shortcut[data-name="captureText"]'), 'Ctrl+Shift+K');
  await prefs.click('.shortcut[data-name="captureScreen"]');
  await prefs.keyboard.press('Control+Shift+K');
  await prefs.waitForFunction(() => /Already used for Capture Text/.test(document.body.textContent));
  assert.equal((await settings()).shortcuts.captureScreen, 'CommandOrControl+Shift+3', 'duplicate refused');
  await prefs.click('.shortcut[data-name="captureScreen"]');
  await prefs.keyboard.press('KeyA');
  await prefs.waitForFunction(() => /Add Ctrl, Alt or Shift/.test(document.body.textContent));
  await prefs.keyboard.press('Backspace');
  await until(async () => (await settings()).shortcuts.captureScreen === '', { what: 'shortcut cleared' });
  assert.equal(await registered('CommandOrControl+Shift+3'), false);
  await prefs.click('label:has([data-pref="autoSave"])');
  await until(async () => (await settings()).autoSave === false, { what: 'autoSave off' });
  await prefs.click('label:has([data-pref="copyToClipboard"])');
  await until(async () => (await settings()).copyToClipboard === false, { what: 'copy off' });
  await prefs.click('.segmented[data-pref="recordingFormat"] [data-value="gif"]');
  await until(async () => (await settings()).recordingFormat === 'gif', { what: 'GIF format' });
  assert.equal(await prefs.isHidden('#row-system-audio'), process.platform === 'linux', 'system audio is macOS/Windows only');
  assert.equal(await prefs.isHidden('#row-login'), process.platform === 'linux', 'launch at login is macOS/Windows only');
  const userData = await t(({ app: electronApp }) => electronApp.getPath('userData'));
  const persisted = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  assert.equal(persisted.shortcuts.captureText, 'CommandOrControl+Shift+K', 'saved to settings.json');

  step('settings toggles take effect: no auto-save, no clipboard copy');
  await t(({ clipboard }) => clipboard.writeText('untouched'));
  overlay = await openSelector('shot');
  await dragIn(overlay, [310, 210], [610, 410]);
  await until(() => latest('image'), { what: 'capture' });
  cap = await latest('image');
  assert.equal(cap.filePath, null, 'not saved');
  assert.equal(await readClipboardText(), 'untouched', 'clipboard untouched');
  await closeAll();
  await prefs.click('label:has([data-pref="autoSave"])');
  await prefs.click('label:has([data-pref="copyToClipboard"])');
  await until(async () => (await settings()).autoSave && (await settings()).copyToClipboard, { what: 'toggles back on' });
  prefs.close().catch(() => {});

  // ---------------------------------------------------------------------------
  step('scrolling capture: scroll a long page and get one stitched image');
  await fixture.eval('Feed', 'document.scrollingElement.scrollTop = 0');
  overlay = await openSelector('scroll');
  assert.match(await overlay.evaluate(() => document.getElementById('hint').textContent), /area you will scroll/);
  const area = { x: FEED.x + 10, y: FEED.y + 20, width: 380, height: 400 };
  await dragIn(overlay, [area.x, area.y], [area.x + area.width, area.y + area.height]);
  const bar = await waitForTitle(app, 'PinShot Recording');
  await bar.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 });
  await sleep(500);
  const scrolled = 1200;
  for (let y = 40; y <= scrolled; y += 40) {
    await fixture.eval('Feed', `document.scrollingElement.scrollTop = ${y}`);
    await sleep(120);
  }
  await sleep(600);
  assert.match(await bar.textContent('#status'), /px/);
  await snapDesktop(app, shots, 'scrolling-capture');
  await t(() => globalThis.pinshotTest.toggleScrollingCapture()); // ⌘⇧6 again finishes
  const tall = await until(() => latest('image'), { timeout: 15000, what: 'stitched capture' });
  const expected = area.height + scrolled;
  assert.ok(Math.abs(tall.size.height - expected) <= 4, `stitched height ${tall.size.height} ≈ ${expected}`);
  assert.equal(tall.size.width, area.width);
  // The bottom of the stitched image must match what's on screen now (the end of the scroll).
  const tail = await t(
    async ({ desktopCapturer }, { area, id }) => {
      const [s] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1440, height: 900 } });
      const live = s.thumbnail.crop(area).toBitmap();
      const c = globalThis.pinshotTest.captures.get(id);
      const { width, height } = c.image.getSize();
      const st = c.image.crop({ x: 0, y: height - area.height, width, height: area.height }).toBitmap();
      // Compare brightness: the capture comes from a video stream whose colour
      // subsampling slightly smears coloured text, but luma is exact.
      const luma = (b, i) => b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114;
      let diff = 0;
      for (let i = 0; i < live.length; i += 4) diff += Math.abs(luma(live, i) - luma(st, i));
      globalThis.__liveTail = s.thumbnail.crop(area).toPNG().toString('base64');
      return diff / (live.length / 4);
    },
    { area, id: tall.id },
  );
  if (shots) {
    const png = await t((_e, id) => globalThis.pinshotTest.captures.get(id).png.toString('base64'), tall.id);
    fs.writeFileSync(path.join(shots, 'scrolling-result.png'), Buffer.from(png, 'base64'));
    fs.writeFileSync(path.join(shots, 'scrolling-live-tail.png'), Buffer.from(await t(() => globalThis.__liveTail), 'base64'));
  }
  assert.ok(tail < 1.5, `end of the stitched image matches the screen (mean luma diff ${tail.toFixed(2)})`);
  assert.equal(await t(() => globalThis.pinshotTest.isScrolling()), false);

  await closeAll();

  // ---------------------------------------------------------------------------
  step('GIF: record with format GIF; the recording becomes a GIF');
  await fixture.eval(
    'Desktop',
    `(() => { const b = document.createElement('div'); b.id = 'mover';
      b.style.cssText = 'position:fixed;left:340px;top:420px;width:60px;height:60px;background:#f43f5e';
      document.body.appendChild(b); let x = 340; setInterval(() => { x = x > 760 ? 340 : x + 12; b.style.left = x + 'px'; }, 40); })()`,
  );
  await t(() => globalThis.pinshotTest.toggleRecording());
  overlay = await waitForTitle(app, 'PinShot Capture');
  await overlay.waitForFunction(() => document.body.dataset.ready === '1');
  await dragIn(overlay, [320, 380], [840, 520]);
  let recBar = await waitForTitle(app, 'PinShot Recording');
  await recBar.waitForFunction(() => !document.body.classList.contains('starting'), null, { timeout: 15000 });
  await sleep(1800);
  await t(() => globalThis.pinshotTest.toggleRecording());
  const gifCap = await until(async () => {
    const c = await latest();
    return c && c.kind === 'gif' && !c.busy && c;
  }, { timeout: 60000, what: 'GIF from recording' });
  assert.equal(fs.readFileSync(gifCap.filePath).subarray(0, 6).toString(), 'GIF89a');
  assert.ok(!fs.readdirSync(pictures).some((f) => f.endsWith('.mp4')), 'the MP4 was replaced by the GIF');
  const probe = (f) =>
    execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'json', f]).toString();
  const gifInfo = JSON.parse(probe(gifCap.filePath)).streams[0];
  assert.equal(gifInfo.width, 520);
  assert.ok(Number(gifInfo.nb_read_frames) >= 12, `animated (${gifInfo.nb_read_frames} frames)`);
  console.log(`  ${path.basename(gifCap.filePath)}: ${gifInfo.width}×${gifInfo.height}, ${gifInfo.nb_read_frames} frames`);
  thumb = await waitForTitle(app, 'PinShot Quick Access');
  assert.match(await thumb.textContent('#duration'), /^GIF · /);
  await snapDesktop(app, shots, 'gif-thumbnail');
  await closeAll();

  step('GIF button on an MP4 recording makes a GIF alongside it');
  await t(() => globalThis.pinshotTest.settings().set('recordingFormat', 'mp4'));
  await t(() => globalThis.pinshotTest.toggleRecording());
  overlay = await waitForTitle(app, 'PinShot Capture');
  await overlay.waitForFunction(() => document.body.dataset.ready === '1');
  await dragIn(overlay, [320, 380], [840, 520]);
  recBar = await waitForTitle(app, 'PinShot Recording');
  await recBar.waitForFunction(() => !document.body.classList.contains('starting'), null, { timeout: 15000 });
  await sleep(1500);
  await t(() => globalThis.pinshotTest.toggleRecording());
  const mp4 = await until(async () => (await latest('video')) || null, { timeout: 15000, what: 'video' });
  thumb = await waitForTitle(app, 'PinShot Quick Access');
  await thumb.waitForFunction(() => !document.body.classList.contains('flying'));
  await thumb.hover('body');
  await thumb.click('[data-action="gif"]');
  const gif2 = await until(async () => (await latest('gif')) || null, { timeout: 60000, what: 'GIF alongside' });
  assert.ok(fs.existsSync(mp4.filePath) && fs.existsSync(gif2.filePath), 'both files kept');
  assert.equal((await captureState(app)).filter((c) => c.thumb).length, 2, 'video and GIF thumbnails');
  // Recordings land in Capture History too; "record as GIF" swapped its entry's MP4 for the GIF.
  const historyFiles = (await t(() => globalThis.pinshotTest.historyList())).map((e) => [e.kind, e.name]);
  for (const c of [gifCap, mp4, gif2]) {
    assert.ok(historyFiles.some(([kind, name]) => kind === c.kind && name === path.basename(c.filePath)), `${c.kind} in history`);
  }

  step('tray menu lists every action');
  const labels = await tray();
  for (const l of ['Capture Area', 'Capture Fullscreen', 'Capture Text', 'Scrolling Capture', 'Record Screen', 'Preferences…', 'Quit PinShot']) {
    assert.ok(labels.includes(l), `tray has ${l}`);
  }
  assert.deepEqual(await t(() => globalThis.pinshotTest.errors), [], 'no errors reported');
  console.log('PinShot feature tests passed');
} catch (err) {
  // Leave a trail: what PinShot was showing and any errors it reported.
  console.error('FAILED:', err.message);
  console.error('captures:', JSON.stringify(await captureState(app).catch(() => 'unavailable')));
  console.error('errors:', JSON.stringify(await t(() => globalThis.pinshotTest.errors).catch(() => 'unavailable')));
  console.error('hud:', JSON.stringify(await t(() => globalThis.pinshotTest.hud()).catch(() => 'unavailable')));
  console.error('clipboard:', JSON.stringify(await readClipboardText().catch(() => 'unavailable')));
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  fixture.stop();
}
