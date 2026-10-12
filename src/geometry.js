'use strict';

// Pure geometry helpers shared by the main process. Kept free of Electron
// imports so they can be unit-tested with plain Node.

/** Turn a drag (two corner points, any direction) into a positive rect. */
function normalizeRect(x1, y1, x2, y2) {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/**
 * Convert a rect in display points (CSS px) to a rect in image pixels,
 * rounded outward and clamped to the image bounds.
 */
function toPixelRect(rect, scale, imageWidth, imageHeight) {
  const x = Math.max(0, Math.floor(rect.x * scale));
  const y = Math.max(0, Math.floor(rect.y * scale));
  const right = Math.min(imageWidth, Math.ceil((rect.x + rect.width) * scale));
  const bottom = Math.min(imageHeight, Math.ceil((rect.y + rect.height) * scale));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/**
 * Size a pin window (in points) for an image of the given pixel size.
 * Pins open at their real on-screen size, shrunk to fit `maxFraction`
 * of the work area if the capture is very large.
 */
function fitPinSize(pixelWidth, pixelHeight, scale, workArea, maxFraction = 0.6) {
  let width = pixelWidth / scale;
  let height = pixelHeight / scale;
  const maxW = workArea.width * maxFraction;
  const maxH = workArea.height * maxFraction;
  const shrink = Math.min(1, maxW / width, maxH / height);
  width = Math.max(1, Math.round(width * shrink));
  height = Math.max(1, Math.round(height * shrink));
  return { width, height };
}

/** Keep a window rect fully inside a work area (moving it, not resizing). */
function clampIntoArea(rect, area) {
  const x = Math.min(Math.max(rect.x, area.x), area.x + area.width - rect.width);
  const y = Math.min(Math.max(rect.y, area.y), area.y + area.height - rect.height);
  return { ...rect, x: Math.round(Math.max(area.x, x)), y: Math.round(Math.max(area.y, y)) };
}

/** Scale a window size around its centre, keeping aspect ratio. */
function zoomBounds(bounds, factor, aspect, minSize = 40) {
  let width = bounds.width * factor;
  if (width < minSize) width = minSize;
  const height = width / aspect;
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  return {
    x: Math.round(cx - width / 2),
    y: Math.round(cy - height / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/** Fit a capture (in points) inside the quick-access thumbnail box, never upscaling. */
function thumbSize(width, height, maxW = 240, maxH = 170) {
  const k = Math.min(1, maxW / width, maxH / height);
  return { width: Math.max(24, Math.round(width * k)), height: Math.max(24, Math.round(height * k)) };
}

/**
 * Stack quick-access thumbnails in the bottom-left corner of a work area.
 * `sizes` is newest-first; the newest sits at the bottom and older ones
 * stack upwards. Anything that would run off the top is parked at the top.
 */
function stackLayout(sizes, workArea, margin = 16, gap = 12) {
  let bottom = workArea.y + workArea.height - margin;
  return sizes.map(({ width, height }) => {
    const y = Math.max(workArea.y + margin, bottom - height);
    bottom = y - gap;
    return { x: workArea.x + margin, y, width, height };
  });
}

/** Overlap of two rects, or null. */
function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/**
 * How to build one image of `rect` (global screen points) from per-display
 * screenshots. Output uses the highest pixel density among the displays it
 * touches; each piece says which part of which display (in display-local
 * points) lands where in the output (in output pixels).
 */
function compositePlan(rect, displays) {
  const touched = displays
    .map((d) => ({ d, overlap: intersect(rect, d.bounds) }))
    .filter((t) => t.overlap);
  if (!touched.length) return null;
  const scale = Math.max(...touched.map((t) => t.d.scale));
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));
  const pieces = touched.map(({ d, overlap }) => {
    const x = Math.round((overlap.x - rect.x) * scale);
    const y = Math.round((overlap.y - rect.y) * scale);
    return {
      id: d.id,
      src: { x: overlap.x - d.bounds.x, y: overlap.y - d.bounds.y, width: overlap.width, height: overlap.height },
      dest: {
        x,
        y,
        width: Math.min(width, Math.round((overlap.x + overlap.width - rect.x) * scale)) - x,
        height: Math.min(height, Math.round((overlap.y + overlap.height - rect.y) * scale)) - y,
      },
    };
  });
  return { scale, width, height, pieces };
}

/** The display a rect mostly sits on (for things that can only use one display, like recording). */
function dominantDisplay(rect, displays) {
  let best = null;
  let bestArea = 0;
  for (const d of displays) {
    const o = intersect(rect, d.bounds);
    const area = o ? o.width * o.height : 0;
    if (area > bestArea) {
      best = d;
      bestArea = area;
    }
  }
  return best;
}

function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  const time = `${p(date.getHours())}.${p(date.getMinutes())}.${p(date.getSeconds())}`;
  return `${day} at ${time}`;
}

/** Timestamped file name, e.g. "PinShot 2026-10-11 at 14.03.22.png". */
function captureFileName(date = new Date()) {
  return `PinShot ${stamp(date)}.png`;
}

/** e.g. "PinShot Recording 2026-10-11 at 14.03.22.mp4". */
function recordingFileName(ext, date = new Date()) {
  return `PinShot Recording ${stamp(date)}.${ext}`;
}

/**
 * Where the floating recording controls go: centred just below the recorded
 * area, else just above it, else inside its bottom edge (macOS and Windows
 * keep the bar out of the video either way).
 */
function recordingBarBounds(region, workArea, size = { width: 216, height: 44 }, gap = 12) {
  const x = Math.round(region.x + (region.width - size.width) / 2);
  const clampX = Math.min(Math.max(x, workArea.x + 8), workArea.x + workArea.width - size.width - 8);
  const below = region.y + region.height + gap;
  const above = region.y - gap - size.height;
  let y;
  if (below + size.height <= workArea.y + workArea.height) y = below;
  else if (above >= workArea.y) y = above;
  else y = region.y + region.height - size.height - gap;
  return { x: clampX, y, ...size };
}

module.exports = {
  normalizeRect, toPixelRect, fitPinSize, clampIntoArea, zoomBounds, thumbSize, stackLayout,
  captureFileName, recordingFileName, recordingBarBounds, intersect, compositePlan, dominantDisplay,
};
