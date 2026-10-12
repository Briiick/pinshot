'use strict';

const {
  app,
  BrowserWindow,
  ClipboardItem,
  Menu,
  Tray,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  session,
  shell,
  systemPreferences,
} = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { Settings } = require('./settings');
const { History } = require('./history');
const { listWindows } = require('./windows');
const { recognizeText, shutdownOcr } = require('./ocr');
const {
  normalizeRect,
  toPixelRect,
  fitPinSize,
  clampIntoArea,
  zoomBounds,
  thumbSize,
  stackLayout,
  captureFileName,
  recordingFileName,
  recordingBarBounds,
  intersect,
  compositePlan,
  dominantDisplay,
} = require('./geometry');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const PRELOAD = path.join(__dirname, 'preload.js');
const RENDERER = path.join(__dirname, 'renderer');
const SHUTTER_SOUND =
  '/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/Screen Capture.aif';
const SYSTEM_AUDIO_SUPPORTED = isMac || isWin;

// System audio in recordings: Windows supports loopback natively; on macOS it
// comes from ScreenCaptureKit behind these Chromium features (macOS 13+).
if (isMac) app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');

// Crash forensics for the test suite: synchronous breadcrumbs that survive a native crash.
const TRACE_FILE = process.env.PINSHOT_TEST && process.env.PINSHOT_TRACE;
const trace = TRACE_FILE ? (msg) => fs.appendFileSync(TRACE_FILE, `${Date.now() % 100000} ${msg}\n`) : () => {};

let settings;
let history; // Capture History (see history.js)
let historyWindow = null;
let tray = null;
let pinsHidden = false;
let nextCaptureId = 1;
let grabbing = false;
let selecting = null; // the selection in progress (see startSelection)
let recording = null; // the screen recording in progress, if any
let scrolling = null; // the scrolling capture in progress, if any
let mediaSource = null; // what getDisplayMedia() should capture: { source, audio }
let prefsWindow = null;
let hudWindow = null;
let shortcutErrors = {};

/**
 * Every screenshot or recording still on screen in some form.
 *   id -> { id, kind, image, png, scale, filePath, origin, displayId, thumb, pin, pinOpacity, editor }
 * `kind` is 'image', 'video' or 'gif'. `origin` is where it was taken (screen
 * points) and `scale` the pixel density, so pins open at real size in the same
 * spot. A capture can have a thumbnail, a pin and an editor at once; it is
 * forgotten once all are closed.
 */
const captures = new Map();
const quickStack = []; // capture ids with a thumbnail, newest first

// What each global shortcut does. Keys match settings.shortcuts.
const ACTIONS = {
  captureScreen: { label: 'Capture Fullscreen', run: () => captureFullscreen() },
  captureArea: { label: 'Capture Area', run: () => startSelection('shot') },
  captureText: { label: 'Capture Text', run: () => startSelection('text') },
  scrollingCapture: { label: 'Scrolling Capture', run: () => toggleScrollingCapture() },
  recordScreen: { label: 'Record Screen', run: () => toggleRecording() },
  toggleAllPins: { label: 'Hide / Show Pins', run: () => toggleAllPins() },
};

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openPreferences());
  app.whenReady().then(init);
}

// Thumbnails, pins and editors come and go; the tray keeps the app alive.
app.on('window-all-closed', () => {});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  shutdownOcr();
});

function init() {
  settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
  history = new History(path.join(app.getPath('userData'), 'History'));
  if (isMac && app.dock) app.dock.hide();

  createTray();
  registerShortcuts();
  registerIpc();
  syncOverlays();
  // Recordings and scrolling captures ask for the screen with getDisplayMedia(); answer with the display we picked.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    if (!mediaSource) return callback({});
    callback(mediaSource.audio ? { video: mediaSource.source, audio: 'loopback' } : { video: mediaSource.source });
  });
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(event, () => {
      if (!selecting) syncOverlays();
      layoutQuickStack();
    });
  }
  if (isMac && !settings.get('seenShortcutTip') && !process.env.PINSHOT_TEST) showShortcutTip();
}

function saveDirectory() {
  return settings.get('saveDirectory') || path.join(app.getPath('pictures'), 'PinShot');
}

// ---------------------------------------------------------------------------
// Tray + shortcuts
// ---------------------------------------------------------------------------

function trayIcon() {
  // macOS tints a black "template" icon to match the menu bar; elsewhere use a coloured one.
  const file = isMac ? 'trayTemplate.png' : 'tray.png';
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', file));
  if (isMac) icon.setTemplateImage(true);
  return icon;
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('PinShot');
  refreshTrayMenu();
}

function trayTemplate() {
  const sc = settings.get('shortcuts');
  const pinCount = [...captures.values()].filter((c) => c.pin).length;
  const item = (name, label = ACTIONS[name].label) => ({ label, accelerator: sc[name] || undefined, click: ACTIONS[name].run });
  return [
    item('captureScreen'),
    item('captureArea'),
    item('captureText'),
    item('scrollingCapture', scrolling ? 'Finish Scrolling Capture' : 'Scrolling Capture'),
    item('recordScreen', recording ? 'Stop Recording' : 'Record Screen'),
    { type: 'separator' },
    { label: 'Close All Thumbnails', enabled: quickStack.length > 0, click: closeAllThumbs },
    { ...item('toggleAllPins', pinsHidden ? 'Show All Pins' : 'Hide All Pins'), enabled: pinCount > 0 },
    { label: 'Close All Pins', enabled: pinCount > 0, click: closeAllPins },
    { type: 'separator' },
    { label: 'Capture History…', click: openHistory },
    { label: 'Open Save Folder', click: openSaveFolder },
    { label: 'Preferences…', accelerator: 'CommandOrControl+,', click: openPreferences },
    { type: 'separator' },
    { label: 'Quit PinShot', role: 'quit' },
  ];
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  shortcutErrors = {};
  const sc = settings.get('shortcuts');
  for (const [name, action] of Object.entries(ACTIONS)) {
    const accelerator = sc[name];
    if (!accelerator) continue;
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, action.run);
    } catch {
      ok = false;
    }
    if (!ok) shortcutErrors[name] = 'In use by another app';
  }
  const failed = Object.keys(shortcutErrors).map((n) => sc[n]);
  tray?.setToolTip(failed.length ? `PinShot — shortcut(s) in use by another app: ${failed.join(', ')}` : 'PinShot');
  refreshTrayMenu();
  return shortcutErrors;
}

/** Change one shortcut, refusing duplicates and keys another app already owns. */
function setShortcut(name, accelerator) {
  if (!ACTIONS[name]) return { ok: false, error: 'Unknown action' };
  const sc = { ...settings.get('shortcuts') };
  if (accelerator) {
    const clash = Object.keys(ACTIONS).find((n) => n !== name && sc[n] === accelerator);
    if (clash) return { ok: false, error: `Already used for ${ACTIONS[clash].label}` };
  }
  const previous = sc[name];
  sc[name] = accelerator || '';
  settings.set('shortcuts', sc);
  registerShortcuts();
  if (shortcutErrors[name]) {
    sc[name] = previous;
    settings.set('shortcuts', sc);
    registerShortcuts();
    return { ok: false, error: 'That shortcut is in use by another app' };
  }
  return { ok: true };
}

/**
 * macOS keeps ⌘⇧3, ⌘⇧4 and ⌘⇧5 for its own screenshot tool, so
 * the built-in shortcuts have to be switched off for PinShot to receive them.
 */
function showShortcutTip() {
  settings.set('seenShortcutTip', true);
  const choice = dialog.showMessageBoxSync({
    type: 'info',
    message: 'Let PinShot handle ⌘⇧3, ⌘⇧4 and ⌘⇧5',
    detail:
      'macOS reserves these for its own screenshot tool. To use PinShot instead:\n\n' +
      'System Settings → Keyboard → Keyboard Shortcuts… → Screenshots, then untick ' +
      '"Save picture of screen as a file", "Save picture of selected area as a file" ' +
      'and "Screenshot and recording options".\n\n' +
      'You can reopen this from PinShot → Preferences.',
    buttons: ['Open Keyboard Settings', 'Later'],
    defaultId: 0,
  });
  if (choice === 0) shell.openExternal('x-apple.systempreferences:com.apple.Keyboard-Settings.extension');
}

async function chooseSaveFolder(parent) {
  const options = {
    title: 'Choose where PinShot saves captures',
    defaultPath: saveDirectory(),
    properties: ['openDirectory', 'createDirectory'],
  };
  const { canceled, filePaths } = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  if (!canceled && filePaths[0]) settings.set('saveDirectory', filePaths[0]);
  return saveDirectory();
}

function openSaveFolder() {
  const dir = saveDirectory();
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

function openPreferences() {
  if (prefsWindow && !prefsWindow.isDestroyed()) {
    prefsWindow.show();
    prefsWindow.focus();
    return;
  }
  prefsWindow = new BrowserWindow({
    width: 620,
    height: 700,
    minWidth: 560,
    minHeight: 480,
    show: false,
    title: 'PinShot Preferences',
    backgroundColor: '#1e1f22',
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  prefsWindow.on('closed', () => {
    prefsWindow = null;
    registerShortcuts(); // in case it closed mid shortcut-recording
  });
  prefsWindow.loadFile(path.join(RENDERER, 'prefs.html'));
  prefsWindow.once('ready-to-show', () => {
    if (isMac) app.focus({ steal: true });
    prefsWindow.show();
  });
}

function preferencesState() {
  const login = isMac || isWin ? app.getLoginItemSettings().openAtLogin : null;
  return {
    platform: process.platform,
    settings: settings.data,
    saveDirectory: saveDirectory(),
    actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, a]) => [k, a.label])),
    shortcutErrors,
    launchAtLogin: login,
    systemAudioSupported: SYSTEM_AUDIO_SUPPORTED,
    version: app.getVersion(),
  };
}

const PREF_KEYS = new Set([
  'copyToClipboard',
  'autoSave',
  'playSound',
  'recordMicrophone',
  'recordSystemAudio',
  'recordingFormat',
  'freezeScreen',
]);

function setPreference(key, value) {
  if (key.startsWith('shortcut:')) return setShortcut(key.slice(9), value);
  if (key === 'launchAtLogin') {
    app.setLoginItemSettings({ openAtLogin: !!value });
    return { ok: true };
  }
  if (!PREF_KEYS.has(key)) return { ok: false, error: 'Unknown setting' };
  settings.set(key, value);
  if (key === 'freezeScreen' && !selecting) syncOverlays(); // rebuild the selectors see-through or not
  refreshTrayMenu();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Displays and grabbing the screen
// ---------------------------------------------------------------------------

/** On macOS, explain how to grant Screen Recording access if it was denied. */
function ensureScreenPermission() {
  if (!isMac) return true;
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'denied' || status === 'restricted') {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      message: 'PinShot needs Screen Recording permission',
      detail:
        'Open System Settings → Privacy & Security → Screen Recording, enable PinShot, then restart the app.',
      buttons: ['Open System Settings', 'Cancel'],
      defaultId: 0,
    });
    if (choice === 0) {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    }
    return false;
  }
  return true;
}

/**
 * Float a window over every Space (and fullscreen apps). On macOS this
 * normally flips the process type, which briefly hides every window and
 * makes the screen jump; PinShot is already a menu-bar (UIElement) app, so
 * that flip is skipped.
 */
function showOnAllSpaces(win) {
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
}

/**
 * The displays to select across. The test suite can split the real screen
 * into two virtual displays (the right one at 2× density) to exercise
 * multi-monitor selections on a machine that only has one.
 */
function displays() {
  const real = screen.getAllDisplays();
  if (process.env.PINSHOT_TEST && process.env.PINSHOT_FAKE_DISPLAYS === 'split') {
    const p = screen.getPrimaryDisplay();
    const half = Math.floor(p.bounds.width / 2);
    const make = (id, x, width, scaleFactor) => ({
      id,
      bounds: { x, y: p.bounds.y, width, height: p.bounds.height },
      workArea: { x, y: p.workArea.y, width, height: p.workArea.height },
      size: { width, height: p.bounds.height },
      scaleFactor,
      fakeOf: p,
    });
    return [make(9001, p.bounds.x, half, 1), make(9002, p.bounds.x + half, p.bounds.width - half, 2)];
  }
  return real;
}

/** The real display a rect mostly sits on (recording and scrolling capture use one display). */
function realDisplayFor(rect) {
  return dominantDisplay(rect, screen.getAllDisplays()) || screen.getPrimaryDisplay();
}

function displayUnderCursor() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

/** Full-resolution screenshots of the given displays: Map(id -> { image, scale }). */
async function grabDisplays(list) {
  trace('grabDisplays');
  const shots = new Map();
  const fake = list.filter((d) => d.fakeOf);
  if (fake.length) {
    const real = fake[0].fakeOf;
    const [{ image, scale }] = [...(await grabDisplays([real])).values()];
    for (const d of fake) {
      const r = { ...d.bounds, x: d.bounds.x - real.bounds.x, y: d.bounds.y - real.bounds.y };
      let piece = image.crop(toPixelRect(r, scale, image.getSize().width, image.getSize().height));
      if (d.scaleFactor !== scale) {
        piece = piece.resize({ width: Math.round(r.width * d.scaleFactor), height: Math.round(r.height * d.scaleFactor) });
      }
      shots.set(d.id, { image: piece, scale: d.scaleFactor });
    }
    return shots;
  }
  const thumbnailSize = {
    width: Math.max(...list.map((d) => Math.round(d.size.width * d.scaleFactor))),
    height: Math.max(...list.map((d) => Math.round(d.size.height * d.scaleFactor))),
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  if (!sources.length) throw new Error('No screens available to capture');
  list.forEach((d, i) => {
    const source =
      sources.find((s) => String(s.display_id) === String(d.id)) || (sources.length === list.length ? sources[i] : sources[0]);
    let image = source.thumbnail;
    if (image.isEmpty()) throw new Error('Screen capture returned an empty image');
    // One size was requested for every display; bring each back to its native pixel size.
    const native = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
    if (image.getSize().width > native.width + 1) image = image.resize({ ...native, quality: 'best' });
    // The thumbnail may not be exactly the size asked for; derive the real density.
    shots.set(d.id, { image, scale: image.getSize().width / d.bounds.width });
  });
  return shots;
}

/** The PinShot windows to leave out of window-capture mode. */
function ownWindows() {
  const nativeIds = new Set();
  if (process.platform === 'linux') {
    for (const w of BrowserWindow.getAllWindows()) {
      const handle = w.getNativeWindowHandle();
      if (handle.length >= 4) nativeIds.add(handle.readUInt32LE(0));
    }
  }
  return { pid: process.pid, nativeIds };
}

/** Put PNG bytes on the system clipboard as an image. */
function copyPng(png) {
  trace('copyPng');
  const item = new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) });
  clipboard.write([item]).catch((err) => console.error('PinShot: copy failed', err));
}

function playShutter() {
  if (!isMac || !settings.get('playSound') || !fs.existsSync(SHUTTER_SOUND)) return;
  spawn('afplay', [SHUTTER_SOUND], { detached: true, stdio: 'ignore' }).unref();
}

async function captureFullscreen() {
  if (selecting || grabbing || !ensureScreenPermission()) return;
  const display = displayUnderCursor();
  try {
    const { image, scale } = (await grabDisplays([display])).get(display.id);
    finishCapture(image, scale, display.bounds, display);
  } catch (err) {
    showError('Capture failed', err);
  }
}

// ---------------------------------------------------------------------------
// The selector: one window per display, built at launch and reused
// ---------------------------------------------------------------------------

const overlays = new Map(); // display id -> BrowserWindow

/**
 * Like macOS, the selector normally sits over the live screen (videos keep
 * playing) and the pixels are grabbed when you let go. "Freeze screen" shows a
 * still copy instead — the default on Linux, where see-through windows need a
 * compositor that may not be running.
 */
const liveSelection = () => !settings.get('freezeScreen');

/** One hidden selector window per display, so pressing a shortcut has nothing to build or load. */
function syncOverlays(list = displays()) {
  trace('syncOverlays');
  const ids = new Set(list.map((d) => d.id));
  const live = liveSelection();
  for (const [id, win] of overlays) {
    if (!ids.has(id) || win.isDestroyed() || win.live !== live) {
      if (!win.isDestroyed()) win.destroy();
      overlays.delete(id);
    }
  }
  for (const d of list) if (!overlays.has(d.id)) overlays.set(d.id, createOverlay(d, live));
}

function createOverlay(display, live) {
  const win = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: live,
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    alwaysOnTop: true,
    backgroundColor: live ? '#00000000' : '#000000',
    title: 'PinShot Capture',
    // macOS: let the first click start a selection even before PinShot is the active app.
    acceptFirstMouse: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.displayId = display.id;
  win.live = live;
  // macOS lets mouse events fall through see-through parts of a window unless told otherwise.
  win.setIgnoreMouseEvents(false);
  win.setAlwaysOnTop(true, 'screen-saver');
  showOnAllSpaces(win);
  win.on('closed', () => {
    if (overlays.get(display.id) === win) overlays.delete(display.id);
  });
  win.loadFile(path.join(RENDERER, 'overlay.html'));
  return win;
}

/** toBitmap()'s byte order is platform-dependent; find out once with a red pixel. */
let bgraCache;
function bitmapIsBGRA() {
  if (bgraCache === undefined) {
    // A 1×1 pure-red PNG: in BGRA order the red byte comes third.
    const png = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
    );
    bgraCache = png.toBitmap()[2] === 255;
  }
  return bgraCache;
}

/**
 * Freeze every display and let the user pick an area (or, with Space, a
 * window). `mode` decides what happens with it: 'shot', 'text' (OCR),
 * 'record' or 'scroll'.
 */
async function startSelection(mode = 'shot') {
  trace(`startSelection ${mode}`);
  if (selecting || grabbing || recording || scrolling || !ensureScreenPermission()) return;
  const list = displays();
  if (liveSelection()) return startLiveSelection(mode, list);
  grabbing = true;
  let shots;
  let windows;
  try {
    // Window mode makes no sense for scrolling capture.
    [shots, windows] = await Promise.all([
      grabDisplays(list),
      mode === 'scroll' ? Promise.resolve([]) : listWindows(ownWindows()),
    ]);
  } catch (err) {
    showError('Capture failed', err);
    return;
  } finally {
    grabbing = false;
  }

  syncOverlays(list);
  selecting = { mode, list, shots, windows, ready: new Set() };
  const bgra = bitmapIsBGRA();
  for (const d of list) {
    const win = overlays.get(d.id);
    const shot = shots.get(d.id);
    // Size it to this display while it's still hidden.
    win.setBounds(d.bounds);
    // Send the raw pixels: lossless (any compression softens text, which reads
    // as the screen "jumping" when the frozen copy replaces the live one) and
    // there's nothing to encode or decode.
    const payload = {
      ...shot.image.getSize(),
      bitmap: shot.image.toBitmap(),
      bgra,
      display: d.bounds, // the renderer pins the image to these screen coordinates
      mode,
      windows,
    };
    sendWhenLoaded(win, 'overlay:image', payload);
  }
}

/** Send to a window once its page has loaded (messages sent before that are lost); keeps order. */
function sendWhenLoaded(win, channel, payload) {
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => win.webContents.send(channel, payload));
  else win.webContents.send(channel, payload);
}

/**
 * Show the selectors straight away over the live screen. Nothing is grabbed
 * until a selection is made; the window list (for Space) arrives a moment later.
 */
function startLiveSelection(mode, list) {
  syncOverlays(list);
  const token = {};
  selecting = { mode, list, shots: null, windows: [], ready: new Set(), live: true, token };
  for (const d of list) {
    const win = overlays.get(d.id);
    win.setBounds(d.bounds);
    sendWhenLoaded(win, 'overlay:start', { display: d.bounds, mode });
  }
  if (mode === 'scroll') return; // no window mode for scrolling capture
  listWindows(ownWindows()).then((windows) => {
    trace(`live windows ${windows.length} current=${selecting?.token === token}`);
    if (selecting?.token !== token) return;
    selecting.windows = windows;
    for (const d of list) sendWhenLoaded(overlays.get(d.id), 'overlay:windows', windows);
  });
}

/** Every selector has painted its frozen screenshot: put them all on screen together. */
function onOverlayReady(win) {
  trace(`overlay ready ${win?.displayId}`);
  if (!selecting || !win) return;
  selecting.ready.add(win.displayId);
  if (selecting.ready.size < selecting.list.length) return;
  // A menu-bar app isn't frontmost by default; take focus so Esc etc. work.
  if (isMac) app.focus({ steal: true });
  const cursor = screen.getCursorScreenPoint();
  let focusWin = null;
  for (const d of selecting.list) {
    const w = overlays.get(d.id);
    w.setBounds(d.bounds);
    w.show();
    // macOS can nudge a window below the menu bar as it appears; put it back.
    w.setBounds(d.bounds);
    if (intersect(d.bounds, { x: cursor.x, y: cursor.y, width: 1, height: 1 })) focusWin = w;
  }
  (focusWin || overlays.get(selecting.list[0].id)).focus();
  // The cursor only becomes a crosshair (and the coordinates only show) once
  // the page under it sees a mouse event. Don't wait for the user to move:
  // send one at the current position now, and again once activation settles.
  for (const ms of [0, 60, 200]) setTimeout(nudgeCursor, ms);
}

/** Tell the selector under the cursor where the mouse is, as if it had just moved. */
function nudgeCursor() {
  if (!selecting) return;
  trace('nudge');
  const c = screen.getCursorScreenPoint();
  for (const d of selecting.list) {
    const win = overlays.get(d.id);
    if (!win || win.isDestroyed() || !win.isVisible()) continue;
    const b = win.getContentBounds();
    if (c.x < b.x || c.y < b.y || c.x >= b.x + b.width || c.y >= b.y + b.height) continue;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: c.x - b.x, y: c.y - b.y });
  }
}

function closeSelection() {
  trace('closeSelection');
  selecting = null;
  for (const win of overlays.values()) {
    if (win.isDestroyed()) continue;
    trace(`hide overlay ${win.displayId}`);
    win.hide();
    win.webContents.send('overlay:reset');
    trace('hid overlay');
  }
}

/** Relay something one selector did to all the others (drag-across-displays, window mode). */
function relayToOtherOverlays(sender, channel, payload) {
  for (const win of overlays.values()) {
    if (!win.isDestroyed() && win.webContents !== sender) win.webContents.send(channel, payload);
  }
}

/**
 * Build one image of a global rect from the frozen display screenshots,
 * stitching across displays (at the highest density involved) when needed.
 */
function composeRegion(rect, list, shots) {
  trace(`composeRegion ${JSON.stringify(rect)}`);
  const plan = compositePlan(
    rect,
    list.map((d) => ({ id: d.id, bounds: d.bounds, scale: shots.get(d.id).scale })),
  );
  if (!plan) return null;
  if (plan.pieces.length === 1) {
    // Common case: straight crop, no resampling.
    const piece = plan.pieces[0];
    const { image, scale } = shots.get(piece.id);
    const size = image.getSize();
    const px = toPixelRect(piece.src, scale, size.width, size.height);
    if (px.width < 1 || px.height < 1) return null;
    return { image: image.crop(px), scale };
  }
  const out = Buffer.alloc(plan.width * plan.height * 4); // transparent where no display is
  for (const piece of plan.pieces) {
    const { image, scale } = shots.get(piece.id);
    const size = image.getSize();
    let part = image.crop(toPixelRect(piece.src, scale, size.width, size.height));
    const { width: dw, height: dh } = piece.dest;
    if (dw < 1 || dh < 1) continue;
    if (part.getSize().width !== dw || part.getSize().height !== dh) {
      part = part.resize({ width: dw, height: dh, quality: 'best' });
    }
    const bitmap = part.toBitmap();
    const rowBytes = dw * 4;
    for (let y = 0; y < dh; y++) {
      bitmap.copy(out, ((piece.dest.y + y) * plan.width + piece.dest.x) * 4, y * rowBytes, (y + 1) * rowBytes);
    }
  }
  return { image: nativeImage.createFromBitmap(out, { width: plan.width, height: plan.height }), scale: plan.scale };
}

/** Capture a window itself (so overlapping windows don't show; macOS/Windows), else crop it from the screen. */
async function windowImage(win, list, shots) {
  const fallback = () => (trace('windowImage fallback'), composeRegion(win.bounds, list, shots));
  // Linux: Chromium's X11 window capturer is slow (seconds), rarely matches
  // xwininfo's ids, and can crash the app if a window it is tracking closes.
  // The window is on top where it was clicked, so crop it from the screen.
  if (process.platform === 'linux') return fallback();
  try {
    trace('windowImage getSources');
    const scale = Math.max(...list.filter((d) => intersect(d.bounds, win.bounds)).map((d) => shots.get(d.id).scale), 1);
    const thumbnailSize = { width: Math.round(win.bounds.width * scale), height: Math.round(win.bounds.height * scale) };
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize });
    const source = sources.find((s) => s.id.startsWith(`window:${win.id}:`));
    if (!source || source.thumbnail.isEmpty()) return fallback();
    const image = source.thumbnail;
    return { image, scale: image.getSize().width / win.bounds.width };
  } catch {
    return fallback();
  }
}

async function onOverlaySelect(payload) {
  trace(`select ${JSON.stringify(payload)}`);
  if (!selecting) return;
  const { mode, list, windows, live } = selecting;
  let { shots } = selecting;
  closeSelection();

  let rect;
  let win = null;
  if (payload.windowId != null) {
    win = windows.find((w) => w.id === payload.windowId);
    if (!win) return;
    rect = win.bounds;
  } else {
    const r = payload.rect;
    rect = normalizeRect(r.x, r.y, r.x + r.width, r.y + r.height);
    if (rect.width < 2 || rect.height < 2) return;
  }
  const display = realDisplayFor(rect);

  try {
    if (mode === 'record') return startRecording(rect, { full: !!payload.full });
    if (mode === 'scroll') return startScrollingCapture(rect);
    if (live) {
      // Let the window server take the selectors off screen, then grab what's really there.
      await new Promise((r) => setTimeout(r, isMac ? 150 : 100));
      shots = await grabDisplays(list);
    }
    const shot = win ? await windowImage(win, list, shots) : composeRegion(rect, list, shots);
    if (!shot) return;
    if (mode === 'text') return captureTextFrom(shot.image, shot.scale);
    finishCapture(shot.image, shot.scale, rect, display);
  } catch (err) {
    showError('Capture failed', err);
  }
}

// ---------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------

function newCapture(fields) {
  const capture = {
    id: nextCaptureId++,
    kind: 'image',
    thumb: null,
    pin: null,
    pinOpacity: 1,
    editor: null,
    ...fields,
  };
  captures.set(capture.id, capture);
  return capture;
}

/** Copy/save a new screenshot according to settings, then fly it into the corner. */
function finishCapture(image, scale, origin, display) {
  trace('finishCapture');
  playShutter();
  const png = image.toPNG();
  if (settings.get('copyToClipboard')) copyPng(png);

  let filePath = null;
  if (settings.get('autoSave')) {
    try {
      const dir = saveDirectory();
      fs.mkdirSync(dir, { recursive: true });
      filePath = path.join(dir, captureFileName());
      fs.writeFileSync(filePath, png);
    } catch (err) {
      filePath = null;
      console.error('PinShot: auto-save failed', err);
    }
  }
  const capture = newCapture({ image, png, scale, filePath, origin, displayId: display.id });
  rememberCapture(capture);
  createThumb(capture);
  return capture;
}

function dataUrl(capture) {
  return `data:image/png;base64,${capture.png.toString('base64')}`;
}

/** Forget a capture once nothing shows it any more. */
function releaseIfUnused(capture) {
  if (!capture.thumb && !capture.pin && !capture.editor) captures.delete(capture.id);
  refreshTrayMenu();
}

function windowFor(capture) {
  return [capture.editor, capture.pin, capture.thumb].find((w) => w && !w.isDestroyed()) || null;
}

/** Make sure the capture exists on disk (for drag & drop), returning the path. */
function ensureFile(capture) {
  if (capture.filePath && fs.existsSync(capture.filePath)) return capture.filePath;
  if (capture.historyFile && fs.existsSync(capture.historyFile)) return capture.historyFile;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinshot-'));
  capture.tempFile = path.join(dir, captureFileName());
  fs.writeFileSync(capture.tempFile, capture.png);
  return capture.tempFile;
}

async function saveCaptureAs(capture, parent) {
  const options = {
    title: 'Save Screenshot',
    defaultPath: capture.filePath || path.join(saveDirectory(), captureFileName()),
    filters: [
      { name: 'PNG Image', extensions: ['png'] },
      { name: 'JPEG Image', extensions: ['jpg', 'jpeg'] },
    ],
  };
  const { canceled, filePath } = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options);
  if (canceled || !filePath) return false;
  const jpeg = /\.jpe?g$/i.test(filePath);
  fs.writeFileSync(filePath, jpeg ? capture.image.toJPEG(92) : capture.png);
  return true;
}

/** Recordings and GIFs: copy the file somewhere else. */
async function saveFileAs(capture) {
  const ext = path.extname(capture.filePath).slice(1);
  const names = { mp4: 'MP4 Video', webm: 'WebM Video', gif: 'GIF Animation' };
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: capture.kind === 'gif' ? 'Save GIF' : 'Save Recording',
    defaultPath: capture.filePath,
    filters: [{ name: names[ext] || ext.toUpperCase(), extensions: [ext] }],
  });
  if (canceled || !filePath) return false;
  if (filePath !== capture.filePath) fs.copyFileSync(capture.filePath, filePath);
  return true;
}

// ---------------------------------------------------------------------------
// Capture Text (OCR) and the little heads-up display
// ---------------------------------------------------------------------------

/** A small message near the bottom of the screen, e.g. "Copied 120 characters". */
function showHud(message, { ms = 1800, busy = false } = {}) {
  const display = displayUnderCursor();
  const width = Math.min(420, Math.max(200, 24 + message.length * 7.5));
  const bounds = {
    x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
    y: display.workArea.y + display.workArea.height - 96,
    width: Math.round(width),
    height: 44,
  };
  if (!hudWindow || hudWindow.isDestroyed()) {
    hudWindow = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      focusable: false,
      resizable: false,
      skipTaskbar: true,
      hasShadow: true,
      show: false,
      title: 'PinShot HUD',
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
    });
    excludeFromCapture(hudWindow);
    hudWindow.setIgnoreMouseEvents(true);
    hudWindow.loadFile(path.join(RENDERER, 'hud.html'));
  }
  const win = hudWindow;
  win.setBounds(bounds);
  win.lastMessage = message;
  const send = () => {
    win.webContents.send('hud:message', { message, busy });
    win.showInactive();
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
  clearTimeout(win.hideTimer);
  if (ms) win.hideTimer = setTimeout(() => !win.isDestroyed() && win.hide(), ms);
}

async function captureTextFrom(image, scale) {
  showHud('Recognizing text…', { ms: 0, busy: true });
  try {
    const text = (await recognizeText(image, scale)).trim();
    if (!text) {
      showHud('No text found');
      return '';
    }
    await clipboard.writeText(text);
    const n = text.length;
    showHud(`Copied ${n} character${n === 1 ? '' : 's'}`);
    return text;
  } catch (err) {
    showHud('Text recognition failed');
    console.error('PinShot: OCR failed', err);
    return '';
  }
}

// ---------------------------------------------------------------------------
// Window animation
// ---------------------------------------------------------------------------

const easeOutCubic = (t) => 1 - (1 - t) ** 3;

/** Smoothly move/resize a window to `to`. Restarts cleanly if called mid-flight. */
function animateBounds(win, to, duration = 280, done) {
  trace(`animate ${win.getTitle()}`);
  if (win.animation) clearInterval(win.animation);
  const from = win.getBounds();
  const start = Date.now();
  const lerp = (a, b, k) => Math.round(a + (b - a) * k);
  win.animation = setInterval(() => {
    if (win.isDestroyed()) {
      trace('animation: window gone');
      clearInterval(win.animation);
      return;
    }
    const t = Math.min(1, (Date.now() - start) / duration);
    const k = easeOutCubic(t);
    win.setBounds({
      x: lerp(from.x, to.x, k),
      y: lerp(from.y, to.y, k),
      width: Math.max(1, lerp(from.width, to.width, k)),
      height: Math.max(1, lerp(from.height, to.height, k)),
    });
    if (t >= 1) {
      clearInterval(win.animation);
      win.animation = null;
      if (done) done();
    }
  }, 1000 / 60);
}

// ---------------------------------------------------------------------------
// Quick-access thumbnails (bottom-left)
// ---------------------------------------------------------------------------

function thumbBoxFor(capture) {
  const { width, height } = capture.image.getSize();
  if (!width || !height) return thumbSize(240, 150);
  return thumbSize(width / capture.scale, height / capture.scale);
}

/** Where every thumbnail should sit, per display. Returns Map(id -> bounds). */
function quickStackTargets() {
  const targets = new Map();
  const byDisplay = new Map();
  for (const id of quickStack) {
    const capture = captures.get(id);
    if (!capture) continue;
    const display = screen.getAllDisplays().find((d) => d.id === capture.displayId) || screen.getPrimaryDisplay();
    if (!byDisplay.has(display.id)) byDisplay.set(display.id, { display, items: [] });
    byDisplay.get(display.id).items.push(capture);
  }
  for (const { display, items } of byDisplay.values()) {
    const slots = stackLayout(items.map(thumbBoxFor), display.workArea);
    items.forEach((capture, i) => targets.set(capture.id, slots[i]));
  }
  return targets;
}

function layoutQuickStack() {
  trace('layoutQuickStack');
  const targets = quickStackTargets();
  for (const [id, bounds] of targets) {
    const thumb = captures.get(id)?.thumb;
    if (thumb && !thumb.isDestroyed() && thumb.landed) animateBounds(thumb, bounds, 220);
  }
}

function createThumb(capture) {
  trace('createThumb');
  const win = new BrowserWindow({
    ...capture.origin,
    frame: false,
    transparent: true,
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    title: 'PinShot Quick Access',
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'floating');
  showOnAllSpaces(win);
  win.captureId = capture.id;
  capture.thumb = win;
  quickStack.unshift(capture.id);

  win.on('closed', () => {
    trace('thumb closed');
    capture.thumb = null;
    const i = quickStack.indexOf(capture.id);
    if (i >= 0) quickStack.splice(i, 1);
    layoutQuickStack();
    releaseIfUnused(capture);
  });
  win.loadFile(path.join(RENDERER, 'thumb.html'));
  refreshTrayMenu();
}

/** The thumbnail has painted the screenshot at its original spot: show it and fly it home. */
function launchThumb(capture) {
  trace('launchThumb');
  const win = capture.thumb;
  if (!win || win.isDestroyed()) return;
  win.setBounds(capture.origin);
  win.showInactive();
  const targets = quickStackTargets();
  // Older thumbnails make room while the new one flies in.
  layoutQuickStack();
  animateBounds(win, targets.get(capture.id), 420, () => {
    win.landed = true;
    win.webContents.send('thumb:landed');
    layoutQuickStack();
  });
}

function closeThumb(capture) {
  const win = capture.thumb;
  if (!win || win.isDestroyed()) return;
  // Stop any fly-in/re-layout animation before the window goes away.
  if (win.animation) clearInterval(win.animation);
  win.animation = null;
  win.close();
}

function closeAllThumbs() {
  for (const id of [...quickStack]) closeThumb(captures.get(id));
}

/** Tell a thumbnail its capture changed (kind, file, busy state). */
function refreshThumb(capture) {
  if (capture.thumb && !capture.thumb.isDestroyed()) capture.thumb.webContents.send('thumb:refresh', thumbInfo(capture));
}

function thumbInfo(capture) {
  return {
    dataUrl: dataUrl(capture),
    scale: capture.scale,
    kind: capture.kind,
    duration: capture.duration,
    busy: capture.busy || null,
  };
}

/**
 * Drag a thumbnail into another app. Dropped somewhere outside PinShot, it
 * has done its job: it leaves the corner (it's still in Capture History).
 */
async function dragThumbOut(capture, sender) {
  const win = capture.thumb;
  const icon = capture.image.isEmpty() ? nativeImage.createEmpty() : capture.image.resize({ width: 96 });
  sender.startDrag({ file: ensureFile(capture), icon });
  await mouseReleased();
  if (!win || win.isDestroyed() || capture.thumb !== win) return;
  const dropped = !overOwnWindow(screen.getCursorScreenPoint());
  if (process.env.PINSHOT_TEST) global.pinshotTest.drags.push({ id: capture.id, dropped });
  if (dropped) sendToHistory(capture);
}

/**
 * Resolves once the drag is over. On Windows and Linux startDrag() runs the
 * whole drag before returning; macOS may hand it to the event loop, so wait
 * for the mouse button to come up.
 */
function mouseReleased() {
  if (!isMac) return Promise.resolve();
  const script = "ObjC.import('AppKit'); for (let i = 0; i < 3000 && ($.NSEvent.pressedMouseButtons & 1); i++) delay(0.02);";
  return new Promise((resolve) => {
    const child = spawn('osascript', ['-l', 'JavaScript', '-e', script], { stdio: 'ignore' });
    child.on('exit', resolve);
    child.on('error', resolve);
  });
}

/** Released over one of PinShot's own windows (e.g. back on the thumbnail): the drag was called off. */
function overOwnWindow(p) {
  return BrowserWindow.getAllWindows().some((w) => {
    if (w.isDestroyed() || !w.isVisible()) return false;
    const b = w.getBounds();
    return p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;
  });
}

/** Fade a thumbnail out of the corner; its capture lives on in the history. */
function sendToHistory(capture) {
  const win = capture.thumb;
  if (!win || win.isDestroyed()) return;
  trace('thumb to history');
  if (win.animation) clearInterval(win.animation);
  const start = Date.now();
  win.animation = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(win.animation);
    const t = Math.min(1, (Date.now() - start) / 180);
    win.setOpacity(1 - t);
    if (t >= 1) closeThumb(capture);
  }, 1000 / 60);
}

// ---------------------------------------------------------------------------
// Capture History
// ---------------------------------------------------------------------------

/** A small PNG for the History window. */
function previewPng(image) {
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const k = Math.min(1, 480 / width, 320 / height);
  return (k < 1 ? image.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'good' }) : image).toPNG();
}

/** Add a new capture to the history. Screenshots that weren't auto-saved get a copy there. */
function rememberCapture(capture) {
  try {
    let file = capture.filePath;
    if (!file) {
      file = history.pathFor(captureFileName());
      fs.writeFileSync(file, capture.png);
      capture.historyFile = file;
    }
    const { width, height } = capture.image.getSize();
    const entry = history.add({
      file,
      kind: capture.kind,
      width,
      height,
      scale: capture.scale,
      duration: capture.duration || 0,
      preview: previewPng(capture.image),
    });
    capture.historyId = entry.id;
    historyChanged();
  } catch (err) {
    console.error('PinShot: could not add to history', err);
  }
}

function historyChanged() {
  if (historyWindow && !historyWindow.isDestroyed()) historyWindow.webContents.send('history:changed');
}

function historyList() {
  return history.list().map((e) => ({
    id: e.id,
    kind: e.kind,
    name: path.basename(e.file),
    createdAt: e.createdAt,
    width: e.width,
    height: e.height,
    scale: e.scale,
    duration: e.duration,
    preview: e.preview && fs.existsSync(e.preview) ? `${pathToFileURL(e.preview).href}?v=${fs.statSync(e.preview).mtimeMs}` : null,
  }));
}

/** The live capture for a history entry, bringing it back if it has gone. */
function captureFromHistory(id) {
  const entry = history.get(id);
  if (!entry || !fs.existsSync(entry.file)) return null;
  const existing = [...captures.values()].find((c) => c.historyId === id);
  if (existing) return existing;
  const isImage = entry.kind === 'image';
  const image = nativeImage.createFromPath(isImage ? entry.file : entry.preview || '');
  if (isImage && image.isEmpty()) return null;
  // Videos only have a small poster, shown at 1×.
  const scale = isImage ? entry.scale || 1 : 1;
  const display = displayUnderCursor();
  const wa = display.workArea;
  const { width, height } = image.isEmpty() ? { width: 480, height: 300 } : image.getSize();
  const size = fitPinSize(width, height, scale, wa, 0.6);
  const owned = history.owns(entry.file);
  return newCapture({
    kind: entry.kind,
    image,
    png: image.toPNG(),
    scale,
    duration: entry.duration,
    filePath: owned ? null : entry.file,
    historyFile: owned ? entry.file : null,
    historyId: id,
    origin: { x: Math.round(wa.x + (wa.width - size.width) / 2), y: Math.round(wa.y + (wa.height - size.height) / 2), ...size },
    displayId: display.id,
  });
}

/** Do something with a history entry's capture, forgetting it again if nothing ends up showing it. */
function withHistoryCapture(id, fn) {
  const capture = captureFromHistory(id);
  if (!capture) {
    historyChanged();
    return;
  }
  fn(capture);
  releaseIfUnused(capture);
}

function openHistory() {
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.show();
    historyWindow.focus();
    return;
  }
  historyWindow = new BrowserWindow({
    width: 860,
    height: 600,
    minWidth: 480,
    minHeight: 320,
    show: false,
    title: 'PinShot History',
    backgroundColor: '#1e1f22',
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  historyWindow.on('closed', () => {
    historyWindow = null;
  });
  historyWindow.loadFile(path.join(RENDERER, 'history.html'));
  historyWindow.once('ready-to-show', () => {
    if (isMac) app.focus({ steal: true });
    historyWindow.show();
  });
}

// ---------------------------------------------------------------------------
// Screen recording + scrolling capture (both stream the screen with getDisplayMedia)
// ---------------------------------------------------------------------------

/** Windows that must never appear in the recording itself. */
function excludeFromCapture(win) {
  win.setContentProtection(true); // macOS + Windows hide these from screen capture
  win.setAlwaysOnTop(true, 'screen-saver');
  showOnAllSpaces(win);
}

/**
 * A dashed frame around the captured area, made of four thin strips that sit
 * entirely outside it, so nothing ever covers what's being captured (even on
 * systems where transparent windows aren't actually transparent).
 */
function createOutline(region) {
  const t = 3; // strip thickness
  const { x, y, width: w, height: h } = region;
  const strips = [
    { x: x - t, y: y - t, width: w + 2 * t, height: t, side: 'h' },
    { x: x - t, y: y + h, width: w + 2 * t, height: t, side: 'h' },
    { x: x - t, y, width: t, height: h, side: 'v' },
    { x: x + w, y, width: t, height: h, side: 'v' },
  ];
  return strips.map(({ side, ...bounds }) => {
    const win = new BrowserWindow({
      ...bounds,
      frame: false,
      focusable: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      show: false,
      backgroundColor: '#ffffff',
      title: 'PinShot Recording Outline',
      webPreferences: { sandbox: true },
    });
    excludeFromCapture(win);
    win.setIgnoreMouseEvents(true);
    win.setBounds(bounds); // tiny windows can be padded by the OS at creation
    win.loadFile(path.join(RENDERER, 'outline.html'), { query: { side } });
    win.once('ready-to-show', () => win.showInactive());
    return win;
  });
}

/** A floating control bar that also runs the capture (recorder / stitcher) itself. */
function createControlBar(page, bounds, onClosed) {
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    show: false,
    title: 'PinShot Recording',
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  excludeFromCapture(win);
  win.on('closed', onClosed);
  win.loadFile(path.join(RENDERER, page));
  win.once('ready-to-show', () => win.showInactive());
  return win;
}

/** The getDisplayMedia source for a real display. */
async function screenSourceFor(display) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source) throw new Error('No screens available to capture');
  return source;
}

/** Map a global rect onto one real display: { display, region, crop|null }. */
function placeOnDisplay(rect, full) {
  const display = realDisplayFor(rect);
  const region = full ? { ...display.bounds } : intersect(rect, display.bounds) || { ...display.bounds };
  const crop =
    full || (region.width >= display.bounds.width && region.height >= display.bounds.height)
      ? null
      : { x: region.x - display.bounds.x, y: region.y - display.bounds.y, width: region.width, height: region.height };
  return { display, region, crop };
}

/** ⌘⇧5: pick an area (or a window, or Enter for the whole screen) — or stop the recording in progress. */
function toggleRecording() {
  if (recording) stopRecording();
  else startSelection('record');
}

async function startRecording(rect, { full = false } = {}) {
  const { display, region, crop } = placeOnDisplay(rect, full);
  if (crop && (crop.width < 8 || crop.height < 8)) return;
  let mic = settings.get('recordMicrophone');
  if (mic && isMac) mic = await systemPreferences.askForMediaAccess('microphone');
  const systemAudio = SYSTEM_AUDIO_SUPPORTED && settings.get('recordSystemAudio');

  recording = { display, crop, region, mic, systemAudio, bar: null, outline: [], file: null };
  try {
    mediaSource = { source: await screenSourceFor(display), audio: systemAudio };
  } catch (err) {
    recording = null;
    showError('Recording failed', err);
    return;
  }
  if (crop) recording.outline = createOutline(region);
  const bar = createControlBar('recorder.html', recordingBarBounds(region, display.workArea), () => {
    // Closing the bar any other way than Stop/Discard throws the recording away.
    if (recording && recording.bar === bar) finishRecording({ discard: true });
  });
  recording.bar = bar;
  refreshTrayMenu();
}

function stopRecording() {
  if (recording?.bar && !recording.bar.isDestroyed()) recording.bar.webContents.send('rec:stop');
}

function onRecordingStarted({ mimeType, poster, scale }) {
  if (!recording) return;
  const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  const dir = saveDirectory();
  fs.mkdirSync(dir, { recursive: true });
  recording.filePath = path.join(dir, recordingFileName(ext));
  recording.file = fs.createWriteStream(recording.filePath);
  recording.poster = poster;
  recording.scale = scale;
  recording.startedAt = Date.now();
}

/** The recorder has flushed its last chunk (or was discarded): wrap up. */
function finishRecording({ discard = false } = {}) {
  const rec = recording;
  if (!rec) return;
  recording = null;
  mediaSource = null;
  for (const win of [rec.bar, ...rec.outline]) if (win && !win.isDestroyed()) win.destroy();
  refreshTrayMenu();
  if (!rec.file) return;
  rec.file.end(() => {
    if (discard) {
      fs.rmSync(rec.filePath, { force: true });
      return;
    }
    playShutter();
    const image = rec.poster ? nativeImage.createFromDataURL(rec.poster) : nativeImage.createEmpty();
    const capture = newCapture({
      kind: 'video',
      duration: (Date.now() - rec.startedAt) / 1000,
      image,
      png: image.toPNG(),
      scale: rec.scale || rec.display.scaleFactor,
      filePath: rec.filePath,
      origin: rec.region,
      displayId: rec.display.id,
    });
    rememberCapture(capture);
    createThumb(capture);
    if (settings.get('recordingFormat') === 'gif') makeGif(capture, { replace: true });
  });
}

// --- Scrolling capture -------------------------------------------------------

/** Pick an area, then scroll it: frames are stitched into one tall screenshot. Press again to finish. */
function toggleScrollingCapture() {
  if (scrolling) {
    if (scrolling.bar && !scrolling.bar.isDestroyed()) scrolling.bar.webContents.send('scroll:finish');
  } else {
    startSelection('scroll');
  }
}

async function startScrollingCapture(rect) {
  const { display, region, crop } = placeOnDisplay(rect, false);
  if (crop && (crop.width < 16 || crop.height < 16)) return;
  scrolling = { display, region, crop: crop || { x: 0, y: 0, width: display.bounds.width, height: display.bounds.height } };
  try {
    mediaSource = { source: await screenSourceFor(display), audio: false };
  } catch (err) {
    scrolling = null;
    showError('Scrolling capture failed', err);
    return;
  }
  scrolling.outline = createOutline(region);
  const bounds = recordingBarBounds(region, display.workArea, { width: 340, height: 44 });
  const bar = createControlBar('scroll.html', bounds, () => {
    if (scrolling && scrolling.bar === bar) finishScrollingCapture(null);
  });
  scrolling.bar = bar;
  refreshTrayMenu();
}

function finishScrollingCapture(result) {
  const sc = scrolling;
  if (!sc) return;
  scrolling = null;
  mediaSource = null;
  for (const win of [sc.bar, ...(sc.outline || [])]) if (win && !win.isDestroyed()) win.destroy();
  refreshTrayMenu();
  if (!result) return;
  const image = nativeImage.createFromBuffer(Buffer.from(result.png));
  if (image.isEmpty()) return;
  const origin = { ...sc.region, height: Math.round(image.getSize().height / result.scale) };
  finishCapture(image, result.scale, origin, sc.display);
}

// --- GIF export --------------------------------------------------------------

const gifJobs = new Map(); // converter window id -> job

/** Convert a video file to an animated GIF in a hidden window. Resolves to the GIF's path. */
function convertToGif(videoPath, { fps = 12, maxWidth = 800, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show: false,
      title: 'PinShot GIF Export',
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    const gifPath = videoPath.replace(/\.[^.]+$/, '.gif');
    // Give up if the converter goes quiet (each progress report resets this).
    let watchdog;
    const kick = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => done(new Error('GIF export stopped responding')), 30000);
    };
    const done = (err) => {
      clearTimeout(watchdog);
      if (!gifJobs.has(win.id)) return;
      gifJobs.delete(win.id);
      if (!win.isDestroyed()) win.destroy();
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve(gifPath);
    };
    const progress = (p) => {
      kick();
      if (onProgress) onProgress(p);
    };
    gifJobs.set(win.id, { src: pathToFileURL(videoPath).href, fps, maxWidth, gifPath, onProgress: progress, done });
    kick();
    win.loadFile(path.join(RENDERER, 'convert.html'));
  });
}

/** GIF button on a recording's thumbnail, or automatic when "Record as GIF" is on. */
async function makeGif(capture, { replace = false } = {}) {
  if (capture.busy) return;
  capture.busy = 'Making GIF…';
  refreshThumb(capture);
  try {
    const gifPath = await convertToGif(capture.filePath, {
      onProgress: (p) => {
        capture.busy = `Making GIF… ${Math.round(p * 100)}%`;
        refreshThumb(capture);
      },
    });
    capture.busy = null;
    if (replace) {
      // "Record as GIF": the GIF replaces the video.
      fs.rmSync(capture.filePath, { force: true });
      capture.kind = 'gif';
      capture.filePath = gifPath;
      if (capture.historyId) history.update(capture.historyId, { file: gifPath, kind: 'gif' });
      historyChanged();
      refreshThumb(capture);
    } else {
      refreshThumb(capture);
      const { image, png, scale, duration, origin, displayId } = capture;
      const gif = newCapture({ kind: 'gif', image, png, scale, duration, origin, displayId, filePath: gifPath });
      rememberCapture(gif);
      createThumb(gif);
    }
  } catch (err) {
    capture.busy = null;
    refreshThumb(capture);
    showError('GIF export failed', err);
  }
}

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

function createPin(capture) {
  if (capture.pin && !capture.pin.isDestroyed()) {
    capture.pin.showInactive();
    return capture.pin;
  }
  const { width: pw, height: ph } = capture.image.getSize();
  const display = screen.getDisplayNearestPoint(capture.origin);
  const size = fitPinSize(pw, ph, capture.scale, display.workArea, 0.9);
  const bounds = clampIntoArea({ x: capture.origin.x, y: capture.origin.y, ...size }, display.workArea);

  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    show: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    alwaysOnTop: true,
    title: 'PinShot Pin',
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'floating');
  showOnAllSpaces(win);
  win.setAspectRatio(pw / ph);
  win.captureId = capture.id;
  capture.pin = win;
  capture.pinOpacity = 1;

  win.on('closed', () => {
    capture.pin = null;
    if (![...captures.values()].some((c) => c.pin)) pinsHidden = false;
    releaseIfUnused(capture);
  });
  win.loadFile(path.join(RENDERER, 'pin.html'));
  win.once('ready-to-show', () => {
    if (!pinsHidden) win.showInactive();
  });
  refreshTrayMenu();
  return win;
}

function toggleAllPins() {
  const pinned = [...captures.values()].filter((c) => c.pin);
  if (!pinned.length) return;
  pinsHidden = !pinsHidden;
  for (const c of pinned) {
    if (pinsHidden) c.pin.hide();
    else c.pin.showInactive();
  }
  refreshTrayMenu();
}

function closeAllPins() {
  for (const c of [...captures.values()]) if (c.pin) c.pin.close();
}

function setPinOpacity(capture, opacity) {
  capture.pinOpacity = Math.min(1, Math.max(0.15, opacity));
  capture.pin.setOpacity(capture.pinOpacity);
}

function pinMenuTemplate(capture) {
  const pct = Math.round(capture.pinOpacity * 100);
  return [
    { label: 'Annotate…', click: () => openEditor(capture) },
    { label: 'Copy', click: () => copyPng(capture.png) },
    { label: 'Copy Text', click: () => captureTextFrom(capture.image, capture.scale) },
    { label: 'Save As…', click: () => saveCaptureAs(capture, capture.pin) },
    {
      label: 'Show in Folder',
      enabled: !!capture.filePath,
      click: () => shell.showItemInFolder(capture.filePath),
    },
    { type: 'separator' },
    { label: 'Actual Size', click: () => resetPinSize(capture) },
    {
      label: `Opacity (${pct}%)`,
      submenu: [100, 80, 60, 40, 25].map((v) => ({
        label: `${v}%`,
        type: 'radio',
        checked: v === pct,
        click: () => setPinOpacity(capture, v / 100),
      })),
    },
    { type: 'separator' },
    { label: 'Close', click: () => capture.pin.close() },
    { label: 'Close All Pins', click: closeAllPins },
  ];
}

function showPinMenu(capture) {
  Menu.buildFromTemplate(pinMenuTemplate(capture)).popup({ window: capture.pin });
}

function resetPinSize(capture) {
  const { width, height } = capture.image.getSize();
  const b = capture.pin.getBounds();
  capture.pin.setBounds({
    x: b.x,
    y: b.y,
    width: Math.round(width / capture.scale),
    height: Math.round(height / capture.scale),
  });
}

/** Swap in an edited image everywhere the capture is shown. */
function replaceImage(capture, image) {
  const oldSize = capture.image.getSize();
  capture.image = image;
  capture.png = image.toPNG();
  const { width, height } = image.getSize();
  const url = dataUrl(capture);

  if (capture.pin && !capture.pin.isDestroyed()) {
    // Keep the pin's position and zoom level.
    const bounds = capture.pin.getBounds();
    const zoom = bounds.width / (oldSize.width / capture.scale);
    capture.pin.setAspectRatio(width / height);
    capture.pin.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: Math.max(1, Math.round((width / capture.scale) * zoom)),
      height: Math.max(1, Math.round((height / capture.scale) * zoom)),
    });
    capture.pin.webContents.send('image', url);
  }
  if (capture.thumb && !capture.thumb.isDestroyed()) {
    capture.thumb.webContents.send('image', url);
    layoutQuickStack();
  }

  if (capture.filePath) {
    try {
      fs.writeFileSync(capture.filePath, capture.png);
    } catch (err) {
      console.error('PinShot: could not update saved file', err);
    }
  }
  if (capture.historyId) {
    try {
      if (capture.historyFile) fs.writeFileSync(capture.historyFile, capture.png);
      history.update(capture.historyId, { width, height }, previewPng(image));
      historyChanged();
    } catch (err) {
      console.error('PinShot: could not update history', err);
    }
  }
  if (settings.get('copyToClipboard')) copyPng(capture.png);
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function openEditor(capture) {
  if (capture.kind !== 'image') return;
  if (capture.editor && !capture.editor.isDestroyed()) {
    capture.editor.show();
    capture.editor.focus();
    return;
  }
  const { width, height } = capture.image.getSize();
  const near = windowFor(capture);
  const display = near ? screen.getDisplayMatching(near.getBounds()) : displayUnderCursor();
  const wa = display.workArea;
  const chrome = { w: 48, h: 120 }; // toolbars + padding around the canvas
  const fit = fitPinSize(width, height, capture.scale, { width: wa.width - chrome.w, height: wa.height - chrome.h }, 0.9);
  const w = Math.min(Math.max(760, fit.width + chrome.w), wa.width);
  const h = Math.min(Math.max(480, fit.height + chrome.h), wa.height);

  const editor = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(wa.x + (wa.width - w) / 2),
    y: Math.round(wa.y + (wa.height - h) / 2),
    minWidth: 640,
    minHeight: 400,
    show: false,
    title: 'PinShot — Annotate',
    backgroundColor: '#1e1f22',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  editor.captureId = capture.id;
  capture.editor = editor;
  editor.on('closed', () => {
    if (capture.editor === editor) capture.editor = null;
    releaseIfUnused(capture);
  });
  editor.loadFile(path.join(RENDERER, 'editor.html'), { query: { platform: process.platform } });
  editor.once('ready-to-show', () => {
    if (isMac) app.focus({ steal: true });
    editor.show();
    editor.focus();
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function captureFrom(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  return (win && captures.get(win.captureId)) || null;
}

/** Register a fire-and-forget handler that receives the sender's capture. */
function onCapture(channel, fn) {
  ipcMain.on(channel, (event, ...args) => {
    const capture = captureFrom(event);
    if (capture) fn(capture, event, ...args);
  });
}

function registerIpc() {
  // Selector
  ipcMain.on('overlay:ready', (event) => onOverlayReady(BrowserWindow.fromWebContents(event.sender)));
  ipcMain.on('overlay:select', (_e, payload) => onOverlaySelect(payload));
  ipcMain.on('overlay:cancel', closeSelection);
  ipcMain.on('overlay:drag', (event, payload) => relayToOtherOverlays(event.sender, 'overlay:remote', payload));
  ipcMain.on('overlay:window-mode', (event, on) => {
    trace(`window-mode ${on}`);
    relayToOtherOverlays(event.sender, 'overlay:window-mode', on);
    setTimeout(nudgeCursor, 0); // show the camera cursor without waiting for a mouse move
  });

  // Shared by thumbnails, pins and the editor.
  ipcMain.handle('capture:init', (event) => {
    const capture = captureFrom(event);
    return capture ? thumbInfo(capture) : null;
  });

  // Quick-access thumbnails
  onCapture('thumb:ready', (capture) => launchThumb(capture));
  onCapture('thumb:close', (capture) => closeThumb(capture));
  onCapture('thumb:copy', (capture) => {
    copyPng(capture.png);
    closeThumb(capture);
  });
  onCapture('thumb:save', async (capture) => {
    const saved = capture.kind === 'image' ? await saveCaptureAs(capture, null) : await saveFileAs(capture);
    if (saved) closeThumb(capture);
  });
  onCapture('thumb:open', (capture) => shell.openPath(capture.filePath));
  onCapture('thumb:reveal', (capture) => shell.showItemInFolder(capture.filePath));
  onCapture('thumb:edit', (capture) => openEditor(capture));
  onCapture('thumb:text', (capture) => captureTextFrom(capture.image, capture.scale));
  onCapture('thumb:gif', (capture) => makeGif(capture));
  onCapture('thumb:pin', (capture) => {
    createPin(capture);
    closeThumb(capture);
  });
  onCapture('thumb:drag', (capture, event) => dragThumbOut(capture, event.sender));

  // Capture History
  ipcMain.handle('history:list', () => historyList());
  const onEntry = (channel, fn) => ipcMain.on(channel, (event, id) => fn(id, event));
  const entryFile = (id) => {
    const entry = history.get(id);
    return entry && fs.existsSync(entry.file) ? entry : null;
  };
  onEntry('history:restore', (id) => withHistoryCapture(id, (c) => (c.thumb ? c.thumb.showInactive() : createThumb(c))));
  onEntry('history:edit', (id) => withHistoryCapture(id, openEditor));
  onEntry('history:pin', (id) => withHistoryCapture(id, (c) => c.kind === 'image' && createPin(c)));
  onEntry('history:copy', (id) => {
    const entry = entryFile(id);
    if (entry?.kind !== 'image') return;
    copyPng(nativeImage.createFromPath(entry.file).toPNG());
    showHud('Copied to clipboard');
  });
  onEntry('history:open', (id) => entryFile(id) && shell.openPath(history.get(id).file));
  onEntry('history:reveal', (id) => entryFile(id) && shell.showItemInFolder(history.get(id).file));
  onEntry('history:drag', (id, event) => {
    const entry = entryFile(id);
    if (!entry) return;
    const preview = entry.preview ? nativeImage.createFromPath(entry.preview) : nativeImage.createEmpty();
    event.sender.startDrag({ file: entry.file, icon: preview.isEmpty() ? preview : preview.resize({ width: 96 }) });
  });
  onEntry('history:delete', (id) => {
    for (const c of captures.values()) if (c.historyId === id) c.historyId = c.historyFile = null;
    history.remove(id);
    historyChanged();
  });
  ipcMain.on('history:clear', async (event) => {
    const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
      type: 'warning',
      buttons: ['Clear History', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Clear the capture history?',
      detail: 'Screenshots you saved stay in your save folder. Ones that were only kept in the history are deleted.',
    });
    if (response !== 0) return;
    for (const c of captures.values()) c.historyId = c.historyFile = null;
    history.clear();
    historyChanged();
  });
  ipcMain.on('history:open-folder', openSaveFolder);

  // Screen recording (the recording bar also does the recording)
  ipcMain.handle('rec:init', () =>
    recording
      ? {
          crop: recording.crop,
          display: recording.display.bounds,
          mic: recording.mic,
          systemAudio: recording.systemAudio,
          fps: 30,
        }
      : null,
  );
  ipcMain.on('rec:started', (_e, info) => onRecordingStarted(info));
  ipcMain.on('rec:chunk', (_e, chunk) => recording?.file?.write(Buffer.from(chunk)));
  ipcMain.on('rec:stopped', () => finishRecording());
  ipcMain.on('rec:cancel', () => finishRecording({ discard: true }));
  ipcMain.on('rec:error', (_e, message) => {
    finishRecording({ discard: true });
    showError('Recording failed', message);
  });

  // Scrolling capture (the bar also does the stitching)
  ipcMain.handle('scroll:init', () =>
    scrolling ? { crop: scrolling.crop, display: scrolling.display.bounds, fps: 30 } : null,
  );
  ipcMain.on('scroll:done', (_e, result) => finishScrollingCapture(result));
  ipcMain.on('scroll:cancel', () => finishScrollingCapture(null));
  ipcMain.on('scroll:error', (_e, message) => {
    finishScrollingCapture(null);
    showError('Scrolling capture failed', message);
  });

  // GIF export
  ipcMain.handle('gif:init', (event) => {
    const job = gifJobs.get(BrowserWindow.fromWebContents(event.sender)?.id);
    return job ? { src: job.src, fps: job.fps, maxWidth: job.maxWidth } : null;
  });
  ipcMain.on('gif:progress', (event, p) => gifJobs.get(BrowserWindow.fromWebContents(event.sender)?.id)?.onProgress?.(p));
  ipcMain.on('gif:done', (event, bytes) => {
    const job = gifJobs.get(BrowserWindow.fromWebContents(event.sender)?.id);
    if (!job) return;
    try {
      fs.writeFileSync(job.gifPath, Buffer.from(bytes));
      job.done();
    } catch (err) {
      job.done(err);
    }
  });
  ipcMain.on('gif:error', (event, message) => gifJobs.get(BrowserWindow.fromWebContents(event.sender)?.id)?.done(message));

  // Pins
  onCapture('pin:drag', (capture, _e, phase) => {
    const pin = capture.pin;
    const cursor = screen.getCursorScreenPoint();
    if (phase === 'start') {
      const [x, y] = pin.getPosition();
      pin.dragFrom = { cursor, x, y };
    } else if (phase === 'move' && pin.dragFrom) {
      const { cursor: c0, x, y } = pin.dragFrom;
      pin.setPosition(Math.round(x + cursor.x - c0.x), Math.round(y + cursor.y - c0.y));
    } else {
      pin.dragFrom = null;
    }
  });
  onCapture('pin:zoom', (capture, _e, factor) => {
    const { width, height } = capture.image.getSize();
    capture.pin.setBounds(zoomBounds(capture.pin.getBounds(), factor, width / height));
  });
  onCapture('pin:opacity-by', (capture, _e, delta) => setPinOpacity(capture, capture.pinOpacity + delta));
  onCapture('pin:actual-size', (capture) => resetPinSize(capture));
  onCapture('pin:close', (capture) => capture.pin.close());
  onCapture('pin:copy', (capture) => copyPng(capture.png));
  onCapture('pin:save', (capture) => saveCaptureAs(capture, capture.pin));
  onCapture('pin:edit', (capture) => openEditor(capture));
  onCapture('pin:menu', (capture) => showPinMenu(capture));

  // Editor
  ipcMain.on('editor:done', (event, url) => {
    const capture = captureFrom(event);
    if (capture && url) replaceImage(capture, nativeImage.createFromDataURL(url));
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.on('editor:cancel', (event) => BrowserWindow.fromWebContents(event.sender)?.close());
  ipcMain.handle('editor:confirm-discard', async (event) => {
    const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
      type: 'question',
      message: 'Discard your annotations?',
      detail: 'The screenshot stays as it was before you started editing.',
      buttons: ['Discard', 'Keep Editing'],
      defaultId: 1,
      cancelId: 1,
    });
    return response === 0;
  });
  ipcMain.on('editor:copy', (_event, url) => copyPng(nativeImage.createFromDataURL(url).toPNG()));
  ipcMain.handle('editor:save-as', async (event, url) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const capture = captureFrom(event);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save Annotated Screenshot',
      defaultPath: capture?.filePath || path.join(saveDirectory(), captureFileName()),
      filters: [
        { name: 'PNG Image', extensions: ['png'] },
        { name: 'JPEG Image', extensions: ['jpg', 'jpeg'] },
      ],
    });
    if (canceled || !filePath) return false;
    const image = nativeImage.createFromDataURL(url);
    fs.writeFileSync(filePath, /\.jpe?g$/i.test(filePath) ? image.toJPEG(92) : image.toPNG());
    return true;
  });

  // Preferences
  ipcMain.handle('prefs:get', () => preferencesState());
  ipcMain.handle('prefs:set', (_e, key, value) => {
    const result = setPreference(key, value);
    return { ...result, state: preferencesState() };
  });
  ipcMain.handle('prefs:choose-folder', (event) => chooseSaveFolder(BrowserWindow.fromWebContents(event.sender)));
  ipcMain.on('prefs:open-folder', openSaveFolder);
  ipcMain.on('prefs:shortcut-tip', showShortcutTip);
  // While a shortcut field is recording keys, don't let the current shortcuts fire.
  ipcMain.on('prefs:pause-shortcuts', (_e, paused) => (paused ? globalShortcut.unregisterAll() : registerShortcuts()));
}

function showError(title, err) {
  console.error(`PinShot: ${title}`, err);
  if (process.env.PINSHOT_TEST) {
    global.pinshotTest.errors.push(`${title}: ${err && err.message ? err.message : err}`);
    return;
  }
  dialog.showErrorBox(title, String(err && err.message ? err.message : err));
}

// Hooks for the automated UI tests (test/*.mjs); never set in normal use.
if (process.env.PINSHOT_TEST) {
  app.on('before-quit', () => console.error('PINSHOT before-quit\n' + new Error().stack));
  app.on('window-all-closed', () => console.error('PINSHOT window-all-closed'));
  process.on('exit', (code) => console.error(`PINSHOT process exit ${code}`));
  global.pinshotTest = {
    startSelection,
    startAreaCapture: () => startSelection('shot'),
    captureFullscreen,
    openEditor,
    openPreferences,
    setPreference,
    toggleRecording,
    toggleScrollingCapture,
    captureTextFrom,
    convertToGif,
    trayTemplate,
    pinMenuTemplate,
    settings: () => settings,
    captures,
    quickStack,
    trace,
    closeThumb,
    openHistory,
    historyList,
    history: () => history,
    drags: [],
    historyWindow: () => historyWindow,
    errors: [],
    isRecording: () => !!recording,
    isScrolling: () => !!scrolling,
    hud: () => (hudWindow && !hudWindow.isDestroyed() ? { message: hudWindow.lastMessage, visible: hudWindow.isVisible() } : null),
  };
}
