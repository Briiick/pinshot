'use strict';

// Lists the windows on screen (topmost first) with their bounds in global
// screen points, for window-capture mode. No native modules: macOS asks
// CoreGraphics through JavaScript for Automation, Linux/X11 uses xwininfo.

const { execFile } = require('child_process');

const run = (cmd, args, timeout = 3000) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

// CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID)
// returns on-screen windows front to back.
const MAC_SCRIPT = `
ObjC.import('CoreGraphics');
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
JSON.stringify(list.map((w) => ({
  id: w.kCGWindowNumber, pid: w.kCGWindowOwnerPID, layer: w.kCGWindowLayer, alpha: w.kCGWindowAlpha,
  owner: w.kCGWindowOwnerName || '', title: w.kCGWindowName || '', bounds: w.kCGWindowBounds,
})));
`;

/** Parse `xwininfo -root -children` output (children are listed topmost first). */
function parseXwininfoChildren(text) {
  const out = [];
  const re = /^\s+(0x[0-9a-f]+) (?:"((?:[^"\\]|\\.)*)"|\(has no name\)).*?\s(\d+)x(\d+)[+-]-?\d+[+-]-?\d+\s+\+(-?\d+)\+(-?\d+)\s*$/gim;
  let m;
  while ((m = re.exec(text))) {
    out.push({
      id: parseInt(m[1], 16),
      title: (m[2] || '').replace(/\\(.)/g, '$1'),
      bounds: { x: Number(m[5]), y: Number(m[6]), width: Number(m[3]), height: Number(m[4]) },
    });
  }
  return out;
}

const MIN_SIZE = 40; // ignore slivers, tooltips and helper windows

async function listMacWindows(ownPid) {
  const raw = JSON.parse(await run('osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT]));
  return raw
    .filter((w) => w.layer === 0 && w.alpha > 0 && w.pid !== ownPid && w.bounds)
    .map((w) => ({
      id: w.id,
      title: w.title || w.owner,
      owner: w.owner,
      bounds: { x: w.bounds.X, y: w.bounds.Y, width: w.bounds.Width, height: w.bounds.Height },
    }))
    .filter((w) => w.bounds.width >= MIN_SIZE && w.bounds.height >= MIN_SIZE);
}

async function listX11Windows(ownIds) {
  const children = parseXwininfoChildren(await run('xwininfo', ['-root', '-children']));
  const candidates = children.filter(
    (w) => !ownIds.has(w.id) && w.bounds.width >= MIN_SIZE && w.bounds.height >= MIN_SIZE,
  );
  // Keep only windows that are actually shown.
  const viewable = await Promise.all(
    candidates.map((w) =>
      run('xwininfo', ['-id', String(w.id)])
        .then((info) => /Map State:\s+IsViewable/.test(info))
        .catch(() => false),
    ),
  );
  return candidates.filter((_, i) => viewable[i]).map((w) => ({ ...w, owner: '' }));
}

/**
 * On-screen windows, topmost first: [{ id, title, owner, bounds }].
 * `own` excludes PinShot's windows: { pid, nativeIds: Set<number> }.
 * Resolves to [] where listing isn't supported (or fails).
 */
async function listWindows(own = {}) {
  try {
    if (process.platform === 'darwin') return await listMacWindows(own.pid);
    if (process.platform === 'linux' && process.env.DISPLAY) return await listX11Windows(own.nativeIds || new Set());
  } catch (err) {
    console.warn('PinShot: could not list windows', err.message);
  }
  return [];
}

module.exports = { listWindows, parseXwininfoChildren };
