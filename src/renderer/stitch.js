'use strict';

// Scrolling-capture stitcher. Feed it successive frames of the same screen
// area while the user scrolls down; it works out how far each frame scrolled
// and appends only the newly revealed rows, producing one tall image.
//
// Frames are { width, height, data } with RGBA bytes (ImageData-compatible).
// Used by the scrolling-capture bar in the renderer, and unit-tested in Node.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PinShotStitch = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const SAMPLES = 48; // columns sampled per row signature

  /** Per-row luma signatures: rows × SAMPLES floats. */
  function signatures(frame) {
    const { width, height, data } = frame;
    const sig = new Float32Array(height * SAMPLES);
    for (let y = 0; y < height; y++) {
      for (let s = 0; s < SAMPLES; s++) {
        // Average a few pixels around each sample column.
        const x0 = Math.floor(((s + 0.1) * width) / SAMPLES);
        const x1 = Math.max(x0 + 1, Math.floor(((s + 0.9) * width) / SAMPLES));
        let sum = 0;
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        }
        sig[y * SAMPLES + s] = sum / (x1 - x0);
      }
    }
    return sig;
  }

  /** Mean difference between row `a` of sigA and row `b` of sigB. */
  function rowDiff(sigA, a, sigB, b) {
    let d = 0;
    const ia = a * SAMPLES;
    const ib = b * SAMPLES;
    for (let s = 0; s < SAMPLES; s++) d += Math.abs(sigA[ia + s] - sigB[ib + s]);
    return d / SAMPLES;
  }

  /** Rows with almost no variation (blank space) say nothing about the offset. */
  function rowDetail(sig, r) {
    let min = Infinity;
    let max = -Infinity;
    for (let s = 0; s < SAMPLES; s++) {
      const v = sig[r * SAMPLES + s];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return max - min;
  }

  /**
   * How far `next` scrolled relative to `prev` (in rows), or 0 if it didn't,
   * or -1 if no plausible offset was found (scrolled too far in one go).
   * Rows near the top and bottom are ignored so sticky headers/footers don't
   * confuse the match.
   */
  function findOffset(prevSig, nextSig, height, { margin = 0.08, maxShift = 0.85, tolerance = 6 } = {}) {
    const m = Math.floor(height * margin);
    const limit = Math.floor(height * maxShift);
    let best = -1;
    let bestScore = Infinity;
    for (let dy = 0; dy <= limit; dy++) {
      // next row r shows what prev showed at row r + dy.
      const from = m;
      const to = height - dy - m;
      if (to - from < Math.max(12, height * 0.06)) break;
      let total = 0;
      let counted = 0;
      const step = Math.max(1, Math.floor((to - from) / 160)); // sample rows for speed
      for (let r = from; r < to; r += step) {
        if (rowDetail(prevSig, r + dy) < 2) continue;
        total += rowDiff(nextSig, r, prevSig, r + dy);
        counted++;
        if (total / Math.max(counted, 8) > bestScore) break; // can't win any more
      }
      if (counted < 4) continue;
      const score = total / counted;
      if (score < bestScore) {
        bestScore = score;
        best = dy;
      }
    }
    return bestScore <= tolerance ? best : -1;
  }

  class Stitcher {
    constructor({ maxHeight = 30000 } = {}) {
      this.maxHeight = maxHeight;
      this.width = 0;
      this.frameHeight = 0;
      this.chunks = []; // RGBA row blocks, top to bottom
      this.height = 0;
      this.prevSig = null;
      this.lost = false;
    }

    /** Add a frame. Returns { added, height, lost }. */
    add(frame) {
      const sig = signatures(frame);
      if (!this.prevSig) {
        this.width = frame.width;
        this.frameHeight = frame.height;
        this.chunks.push(frame.data.slice(0));
        this.height = frame.height;
        this.prevSig = sig;
        return { added: frame.height, height: this.height, lost: false };
      }
      if (frame.width !== this.width || frame.height !== this.frameHeight) throw new Error('Frame size changed');
      if (this.height >= this.maxHeight) return { added: 0, height: this.height, lost: false, full: true };

      const dy = findOffset(this.prevSig, sig, frame.height);
      if (dy < 0) {
        this.lost = true; // scrolled too fast: wait for a frame we can match
        return { added: 0, height: this.height, lost: true };
      }
      this.lost = false;
      if (dy === 0) return { added: 0, height: this.height, lost: false };

      // Append the newly revealed rows from the bottom of this frame.
      const rows = Math.min(dy, this.maxHeight - this.height);
      const rowBytes = frame.width * 4;
      const start = (frame.height - dy) * rowBytes;
      this.chunks.push(frame.data.slice(start, start + rows * rowBytes));
      this.height += rows;
      this.prevSig = sig;
      return { added: rows, height: this.height, lost: false };
    }

    /** The stitched image so far. */
    result() {
      const data = new Uint8ClampedArray(this.width * this.height * 4);
      let offset = 0;
      for (const chunk of this.chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      return { width: this.width, height: this.height, data };
    }
  }

  return { Stitcher, findOffset, signatures };
});
