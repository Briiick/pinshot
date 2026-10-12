'use strict';

// Scrolling-capture stitcher. Feed it successive frames of the same screen
// area while the user scrolls down; it works out how far each frame scrolled
// and appends only the newly revealed rows, producing one tall image.
//
// Frames are { width, height, data } with RGBA bytes (ImageData-compatible).
// The renderer instead hands over each frame's row signatures (computed from a
// copy squeezed to a few columns wide) plus a way to fetch full-resolution rows,
// so it only reads the pixels it keeps. Unit-tested in Node.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PinShotStitch = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const SAMPLES = 48; // columns sampled per row signature

  /** Per-row luma signatures: rows × SAMPLES floats (written into `out` if given). */
  function signatures(frame, out) {
    const { width, height, data } = frame;
    const sig = out && out.length === height * SAMPLES ? out : new Float32Array(height * SAMPLES);
    // Average a few pixels around each sample column.
    const x0 = new Int32Array(SAMPLES);
    const x1 = new Int32Array(SAMPLES);
    for (let s = 0; s < SAMPLES; s++) {
      x0[s] = Math.floor(((s + 0.1) * width) / SAMPLES);
      x1[s] = Math.max(x0[s] + 1, Math.floor(((s + 0.9) * width) / SAMPLES));
    }
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let s = 0; s < SAMPLES; s++) {
        let sum = 0;
        for (let x = x0[s]; x < x1[s]; x++) {
          const i = (row + x) * 4;
          sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        }
        sig[y * SAMPLES + s] = sum / (x1[s] - x0[s]);
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

  /** 1 for each row with enough detail to match on, else 0. */
  function detailedRows(sig, height) {
    const rows = new Uint8Array(height);
    for (let r = 0; r < height; r++) rows[r] = rowDetail(sig, r) >= 2 ? 1 : 0;
    return rows;
  }

  /**
   * How far `next` scrolled relative to `prev` (in rows), or 0 if it didn't,
   * or -1 if no plausible offset was found (scrolled too far in one go).
   * Rows near the top and bottom are ignored so sticky headers/footers don't
   * confuse the match. `detail` (detailedRows of prevSig) and `hint` (a likely
   * offset, e.g. the last one) are optional speed-ups.
   */
  function findOffset(prevSig, nextSig, height, { margin = 0.08, maxShift = 0.85, tolerance = 6, detail, hint = -1 } = {}) {
    const m = Math.floor(height * margin);
    const limit = Math.floor(height * maxShift);
    const minRows = Math.max(12, height * 0.06);
    const detailed = detail || detailedRows(prevSig, height);
    let best = -1;
    let bestScore = Infinity;
    const score = (dy) => {
      // next row r shows what prev showed at row r + dy.
      const from = m;
      const to = height - dy - m;
      let total = 0;
      let counted = 0;
      const step = Math.max(1, Math.floor((to - from) / 160)); // sample rows for speed
      for (let r = from; r < to; r += step) {
        if (!detailed[r + dy]) continue;
        total += rowDiff(nextSig, r, prevSig, r + dy);
        counted++;
        if (total / Math.max(counted, 8) > bestScore) return Infinity; // can't win any more
      }
      return counted < 4 ? Infinity : total / counted;
    };
    const fits = (dy) => dy >= 0 && dy <= limit && height - dy - 2 * m >= minRows;
    const consider = (dy) => {
      const s = score(dy);
      // Ties go to the smaller offset.
      if (s < bestScore || (s === bestScore && (best < 0 || dy < best))) {
        bestScore = s;
        best = dy;
      }
    };
    // Most frames either didn't move or moved like the last one: try those first.
    if (fits(0)) {
      consider(0);
      if (best === 0 && bestScore === 0) return 0; // unchanged: nothing can beat it
    }
    if (hint > 0 && fits(hint)) consider(hint);
    for (let dy = 1; fits(dy); dy++) if (dy !== hint) consider(dy);
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
      this.prevDetail = null; // detailedRows(prevSig)
      this.lastDy = -1;
      this.lost = false;
    }

    /** True once the image reached maxHeight: further frames are ignored. */
    get full() {
      return !!this.prevSig && this.height >= this.maxHeight;
    }

    /** Add a frame of RGBA pixels. Returns { added, height, lost, full? }. */
    add(frame) {
      if (this.full) return { added: 0, height: this.height, lost: false, full: true };
      const rowBytes = frame.width * 4;
      return this.addSignatures(signatures(frame), frame.width, frame.height, (y, count) =>
        frame.data.slice(y * rowBytes, (y + count) * rowBytes),
      );
    }

    /**
     * Add a frame by its row signatures (see signatures()). `rows(y, count)`
     * returns that frame's RGBA bytes for `count` rows from row `y`; it's only
     * called when rows are kept, and the stitcher keeps what it returns.
     * `sig` isn't kept, so the caller can reuse it.
     */
    addSignatures(sig, width, height, rows) {
      if (!this.prevSig) {
        this.width = width;
        this.frameHeight = height;
        this.chunks.push(rows(0, height));
        this.height = height;
        this.adopt(sig);
        return { added: height, height: this.height, lost: false };
      }
      if (width !== this.width || height !== this.frameHeight) throw new Error('Frame size changed');
      if (this.full) return { added: 0, height: this.height, lost: false, full: true };

      const dy = findOffset(this.prevSig, sig, height, { detail: this.prevDetail, hint: this.lastDy });
      if (dy < 0) {
        this.lost = true; // scrolled too fast: wait for a frame we can match
        return { added: 0, height: this.height, lost: true };
      }
      this.lost = false;
      if (dy === 0) return { added: 0, height: this.height, lost: false };

      // Append the newly revealed rows from the bottom of this frame.
      const count = Math.min(dy, this.maxHeight - this.height);
      this.chunks.push(rows(height - dy, count));
      this.height += count;
      this.lastDy = dy;
      this.adopt(sig);
      return { added: count, height: this.height, lost: false };
    }

    adopt(sig) {
      if (!this.prevSig) this.prevSig = new Float32Array(sig.length);
      this.prevSig.set(sig);
      this.prevDetail = detailedRows(this.prevSig, this.frameHeight);
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

  return { Stitcher, findOffset, signatures, SAMPLES };
});
