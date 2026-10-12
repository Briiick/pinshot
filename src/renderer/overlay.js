'use strict';

// One of these runs per display. Everything is tracked in global screen
// points so a selection can start on one display and end on another: the
// selector you drag in relays the rectangle to the others, which draw their
// part of it.

const api = window.pinshot;
const $ = (id) => document.getElementById(id);
const backdrop = $('backdrop');
const selection = $('selection');
const readout = $('readout');
const hint = $('hint');
const highlight = $('window-highlight');

const HINTS = {
  shot: '',
  text: 'Drag over the text to copy · <b>Space</b> for a window · <b>Esc</b> to cancel',
  record: 'Drag to record an area · <b>Space</b> for a window · <b>Enter</b> for the full screen · <b>Esc</b> to cancel',
  scroll: 'Select the area you will scroll · <b>Esc</b> to cancel',
};

let display = null; // this display's bounds, in global points
let offset = { x: 0, y: 0 }; // where the display's top-left sits in this window
let alignLoop = 0;
let mode = 'shot';
let windows = []; // on-screen windows, topmost first (global bounds)
let windowMode = false;
let windowsLoaded = false; // live mode: the window list is only fetched once Space is pressed
let wantWindowMode = false; // Space was pressed before it arrived
let pendingWindowClick = null; // …and a window was clicked before it arrived
let hoveredWindow = null;
let start = null; // drag start (global) — only in the selector the drag began in
let pointer = null; // last pointer position (global)
let shift = false; // keep it square
let alt = false; // grow from the centre
let done = false;

const toGlobal = (cx, cy) => ({ x: cx - offset.x + display.x, y: cy - offset.y + display.y });
const toLocal = (gx, gy) => ({ x: gx - display.x + offset.x, y: gy - display.y + offset.y });
const onThisDisplay = (p) =>
  p && p.x >= display.x && p.y >= display.y && p.x < display.x + display.width && p.y < display.y + display.height;

/**
 * Keep the frozen screenshot lined up with the real screen. The OS may place
 * or size this window a little differently from what was asked (macOS keeps
 * windows below the menu bar), so measure where the window really is.
 * Returns whether anything moved.
 */
function align() {
  if (!display) return false;
  const x = display.x - window.screenX;
  const y = display.y - window.screenY;
  if (x === offset.x && y === offset.y && backdrop.style.width) return false;
  offset = { x, y };
  Object.assign(backdrop.style, {
    left: `${x}px`,
    top: `${y}px`,
    width: `${display.width}px`,
    height: `${display.height}px`,
  });
  return true;
}

/**
 * Re-measure every frame while the window may still be settling (being
 * shown, moved back below the menu bar…), until it has stayed put for
 * STABLE_FRAMES. It starts again when the window is shown or resized.
 */
const STABLE_FRAMES = 30; // ~0.5s
function alignWhileVisible() {
  cancelAnimationFrame(alignLoop);
  let still = 0;
  const tick = () => {
    still = align() ? 0 : still + 1;
    alignLoop = still < STABLE_FRAMES ? requestAnimationFrame(tick) : 0;
  };
  tick();
}

// The main process has put this window on screen (where the OS may have nudged it).
api.on('overlay:shown', () => {
  if (document.body.dataset.ready) alignWhileVisible();
});
window.addEventListener('resize', () => {
  if (document.body.dataset.ready) alignWhileVisible();
});

// The window is reused between captures: start each one from a clean slate.
function reset() {
  start = null;
  pointer = null;
  done = false;
  windowMode = false;
  wantWindowMode = false;
  pendingWindowClick = null;
  hoveredWindow = null;
  selection.hidden = true;
  readout.hidden = true;
  highlight.hidden = true;
  hint.hidden = true;
  document.body.classList.remove('window-mode');
}

api.on('overlay:image', ({ width, height, bitmap, bgra, display: bounds, mode: m, windows: wins }) => {
  reset();
  display = bounds;
  mode = m || 'shot';
  windows = wins || [];
  windowsLoaded = true;
  document.body.classList.remove('live');
  hint.innerHTML = HINTS[mode] || '';
  hint.hidden = !HINTS[mode];
  backdrop.style.width = '';
  align();
  // Paint the raw screenshot pixels 1:1 — no compression, so the frozen copy
  // is indistinguishable from the live screen it replaces.
  backdrop.width = width;
  backdrop.height = height;
  const pixels = new Uint8ClampedArray(bitmap.buffer, bitmap.byteOffset, width * height * 4);
  if (bgra) {
    const words = new Uint32Array(pixels.buffer, pixels.byteOffset, width * height);
    for (let i = 0; i < words.length; i++) {
      const v = words[i];
      words[i] = (v & 0xff00ff00) | ((v & 0xff) << 16) | ((v >>> 16) & 0xff);
    }
  }
  backdrop.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
  // Only appear once that frame has actually been painted, so the window
  // never flashes blank or shows the previous capture.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      align();
      document.body.dataset.ready = '1';
      api.send('overlay:ready');
      alignWhileVisible();
    }),
  );
});

/**
 * Live mode (the default on macOS/Windows): no frozen copy, just the
 * crosshair and selection over the real screen, like macOS's own ⌘⇧4.
 * The screen is grabbed after you let go.
 */
api.on('overlay:start', ({ display: bounds, mode: m }) => {
  reset();
  display = bounds;
  mode = m || 'shot';
  windows = [];
  windowsLoaded = mode === 'scroll';
  document.body.classList.add('live');
  hint.innerHTML = HINTS[mode] || '';
  hint.hidden = !HINTS[mode];
  backdrop.width = backdrop.height = 1;
  align();
  requestAnimationFrame(() => {
    align();
    document.body.dataset.ready = '1';
    api.send('overlay:ready');
    alignWhileVisible();
  });
});

api.on('overlay:windows', (list) => {
  windows = list || [];
  windowsLoaded = true;
  if (!wantWindowMode) return;
  wantWindowMode = false;
  document.body.classList.remove('window-mode');
  toggleWindowMode();
  // A click that came in while we were still finding windows.
  if (windowMode && pendingWindowClick) {
    const w = windowAt(pendingWindowClick);
    pendingWindowClick = null;
    if (w) finish({ windowId: w.id });
  }
});

api.on('overlay:reset', () => {
  reset();
  delete document.body.dataset.ready;
  cancelAnimationFrame(alignLoop);
  backdrop.width = backdrop.height = 1; // free the big bitmap while hidden
});

// --- Drawing -------------------------------------------------------------------

function currentRect() {
  let w = pointer.x - start.x;
  let h = pointer.y - start.y;
  if (shift) {
    const side = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * side;
    h = Math.sign(h || 1) * side;
  }
  const x0 = alt ? start.x - w : start.x;
  const y0 = alt ? start.y - h : start.y;
  const x1 = start.x + w;
  const y1 = start.y + h;
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

/** Draw a selection (global rect, or null) and the readout next to the cursor (global). */
function draw(rect, cursor) {
  if (rect) {
    const p = toLocal(rect.x, rect.y);
    Object.assign(selection.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    selection.hidden = false;
  } else {
    selection.hidden = true;
  }
  // The readout follows the cursor, on whichever display it's on.
  if (!cursor || !onThisDisplay(cursor) || windowMode) {
    readout.hidden = true;
    return;
  }
  const a = rect ? rect.width : cursor.x - display.x;
  const b = rect ? rect.height : cursor.y - display.y;
  $('r1').textContent = Math.round(a);
  $('r2').textContent = Math.round(b);
  readout.hidden = false;
  // Bottom-right of the crosshair, flipped near the screen edges.
  const c = toLocal(cursor.x, cursor.y);
  const w = readout.offsetWidth;
  const h = readout.offsetHeight;
  readout.style.left = `${c.x + 6 + w > window.innerWidth ? c.x - 6 - w : c.x + 6}px`;
  readout.style.top = `${c.y + 8 + h > window.innerHeight ? c.y - 8 - h : c.y + 8}px`;
}

function render() {
  if (!pointer || !display) return;
  const rect = start ? currentRect() : null;
  draw(rect, pointer);
  if (start) api.send('overlay:drag', { rect, cursor: pointer });
}

// A drag that started on another display.
api.on('overlay:remote', ({ rect, cursor }) => {
  if (!display || start) return;
  draw(rect, cursor);
});

// --- Window mode ---------------------------------------------------------------

function windowAt(p) {
  return windows.find(
    (w) => p.x >= w.bounds.x && p.y >= w.bounds.y && p.x < w.bounds.x + w.bounds.width && p.y < w.bounds.y + w.bounds.height,
  );
}

function showWindowHighlight() {
  hoveredWindow = pointer && onThisDisplay(pointer) ? windowAt(pointer) : null;
  if (!hoveredWindow) {
    highlight.hidden = true;
    return;
  }
  const b = hoveredWindow.bounds;
  const p = toLocal(b.x, b.y);
  Object.assign(highlight.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${b.width}px`, height: `${b.height}px` });
  highlight.hidden = false;
}

function setWindowMode(on) {
  windowMode = on && windows.length > 0;
  start = null;
  document.body.classList.toggle('window-mode', windowMode);
  selection.hidden = true;
  readout.hidden = true;
  if (windowMode) showWindowHighlight();
  else highlight.hidden = true;
}

api.on('overlay:window-mode', (on) => setWindowMode(on));

function toggleWindowMode() {
  if (!windowsLoaded) {
    // Switch on as soon as the window list arrives; show the camera cursor now.
    wantWindowMode = !wantWindowMode;
    if (wantWindowMode) api.send('overlay:need-windows'); // main fetches it once per selection
    pendingWindowClick = null;
    document.body.classList.toggle('window-mode', wantWindowMode);
    selection.hidden = true;
    readout.hidden = true;
    return;
  }
  if (!windows.length) {
    hint.innerHTML = 'Window capture isn’t available on this system';
    hint.hidden = false;
    return;
  }
  setWindowMode(!windowMode);
  api.send('overlay:window-mode', windowMode);
}

// --- Input -----------------------------------------------------------------------

function cancel() {
  if (done) return;
  done = true;
  api.send('overlay:cancel');
}

function finish(payload) {
  if (done) return;
  done = true;
  api.send('overlay:select', payload);
}

function track(e) {
  if (!display) return;
  pointer = toGlobal(e.clientX, e.clientY);
  shift = e.shiftKey;
  alt = e.altKey;
}

window.addEventListener('pointermove', (e) => {
  // A move with no button held while dragging is the cursor "nudge" sent when
  // the selector opens — not the user. Don't let it bend the selection.
  if (start && e.buttons === 0) return;
  track(e);
  if (windowMode) showWindowHighlight();
  else if (!wantWindowMode) render();
});

window.addEventListener('pointerleave', () => {
  if (windowMode) highlight.hidden = true;
  if (!start) readout.hidden = true; // the cursor moved to another display
});

window.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return cancel();
  track(e);
  if (windowMode) {
    const w = windowAt(pointer);
    if (w) finish({ windowId: w.id });
    return;
  }
  if (wantWindowMode) {
    pendingWindowClick = { ...pointer }; // decided once the window list arrives
    return;
  }
  start = { ...pointer };
  hint.hidden = true;
  document.body.setPointerCapture?.(e.pointerId);
  render();
});

window.addEventListener('pointerup', (e) => {
  if (!start || e.button !== 0 || done) return;
  track(e);
  const rect = currentRect();
  if (rect.width < 2 || rect.height < 2) {
    // Like macOS, a click without a drag just keeps waiting.
    start = null;
    draw(null, pointer);
    api.send('overlay:drag', { rect: null, cursor: pointer });
    return;
  }
  finish({ rect });
});

for (const type of ['keydown', 'keyup']) {
  window.addEventListener(type, (e) => {
    if (type === 'keydown') {
      if (e.key === 'Escape') return cancel();
      if (e.key === ' ' && mode !== 'scroll' && !start) {
        e.preventDefault();
        return toggleWindowMode();
      }
      if (e.key === 'Enter' && mode === 'record') return finish({ rect: { ...display }, full: true });
    }
    shift = e.shiftKey;
    alt = e.altKey;
    if (!windowMode) render();
  });
}
window.addEventListener('contextmenu', (e) => e.preventDefault());
