'use strict';

// Capture History: every screenshot and recording, newest first, kept after
// its thumbnail is gone. Entries point at the capture's file. Screenshots
// that weren't auto-saved get a copy in the history folder itself, so nothing
// you've taken is lost. Each entry also keeps a small preview image.
//
// Disk work stays off the critical path of taking a screenshot: files are
// written asynchronously and the index is saved a moment later (several
// changes at once), or straight away by flush() when the app quits.

const fs = require('fs');
const path = require('path');

const LIMIT = 200;
const SAVE_DELAY = 200; // ms to wait for more changes before writing the index

class History {
  constructor(dir, { limit = LIMIT, saveDelay = SAVE_DELAY } = {}) {
    this.dir = dir;
    this.limit = limit;
    this.saveDelay = saveDelay;
    this.indexFile = path.join(dir, 'history.json');
    this.saveTimer = null;
    this.generation = 0; // bumped per index write, so an older write never lands over a newer one
    this.landed = 0; // the generation on disk
    this.writes = new Map(); // file -> its latest write still in flight
    this.pending = new Set(); // all disk work still in flight
    this.pruning = null;
    try {
      this.entries = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')).filter((e) => e && e.id && e.file);
    } catch {
      this.entries = [];
    }
  }

  /** Save the index soon; a burst of changes is written once. */
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.writeIndex(), this.saveDelay);
    this.saveTimer.unref?.();
  }

  writeIndex() {
    this.saveTimer = null;
    const generation = ++this.generation;
    const tmp = `${this.indexFile}.${generation}.tmp`;
    const json = JSON.stringify(this.entries);
    return this.track(
      (async () => {
        try {
          await fs.promises.mkdir(this.dir, { recursive: true });
          await fs.promises.writeFile(tmp, json);
          if (generation !== this.generation) return fs.promises.rm(tmp, { force: true });
          await fs.promises.rename(tmp, this.indexFile);
          this.landed = generation;
        } catch (err) {
          console.error('PinShot: could not save the history', err);
        }
      })(),
    );
  }

  /** Write the index now if a change hasn't reached the disk yet (on quit). */
  flush() {
    if (!this.saveTimer && this.landed === this.generation) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const generation = ++this.generation;
    const tmp = `${this.indexFile}.${generation}.tmp`;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.entries));
    fs.renameSync(tmp, this.indexFile);
    this.landed = generation;
  }

  /** Keep track of some disk work, so list() and idle() wait for it. Never rejects. */
  track(promise) {
    const p = Promise.resolve(promise).catch(() => {});
    this.pending.add(p);
    p.then(() => this.pending.delete(p));
    return p;
  }

  /** Resolves once all disk work started so far has finished. */
  async idle() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  /** Write a file without blocking; writes to one file land in order. Rejects on failure. */
  write(file, data) {
    const previous = this.writes.get(file) || Promise.resolve();
    const p = previous.then(() => fs.promises.writeFile(file, data));
    const settled = this.track(p);
    this.writes.set(file, settled);
    settled.then(() => this.writes.get(file) === settled && this.writes.delete(file));
    return p;
  }

  /** Files PinShot made just for the history (not the user's saved captures). */
  owns(file) {
    return !!file && path.dirname(path.resolve(file)) === path.resolve(this.dir);
  }

  /** A path inside the history folder for a new file ("name 2.png" if taken). */
  pathFor(name) {
    fs.mkdirSync(this.dir, { recursive: true });
    const { name: base, ext } = path.parse(name);
    let file = path.join(this.dir, name);
    for (let n = 2; fs.existsSync(file) || this.writes.has(file); n++) file = path.join(this.dir, `${base} ${n}${ext}`);
    return file;
  }

  /**
   * Remember a capture. `preview` is a small PNG (Buffer) shown in the
   * History window, written in the background. Returns the entry.
   */
  add({ file, kind = 'image', width = 0, height = 0, scale = 1, duration = 0, preview = null, createdAt = Date.now() }) {
    const id = `${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const entry = { id, file, kind, width, height, scale, duration, createdAt, preview: null };
    if (preview) this.writePreview(entry, preview);
    this.entries.unshift(entry);
    for (const old of this.entries.splice(this.limit)) this.discardFiles(old);
    this.save();
    return entry;
  }

  writePreview(entry, preview) {
    entry.preview = entry.preview || this.pathFor(`${entry.id}.preview.png`);
    entry.previewVersion = Date.now(); // so the History window doesn't show a cached old one
    this.write(entry.preview, preview).catch((err) => console.error('PinShot: could not save a history preview', err));
  }

  get(id) {
    return this.entries.find((e) => e.id === id) || null;
  }

  /** Change an entry (e.g. it was annotated, or became a GIF). */
  update(id, fields, preview = null) {
    const entry = this.get(id);
    if (!entry) return null;
    if (fields.file && fields.file !== entry.file && this.owns(entry.file)) fs.rmSync(entry.file, { force: true });
    Object.assign(entry, fields);
    if (preview) this.writePreview(entry, preview);
    this.save();
    return entry;
  }

  /**
   * Entries whose file still exists (the user may have deleted or moved some).
   * Waits for files still being written, then checks without blocking.
   */
  async list() {
    await this.idle();
    if (!this.pruning) this.pruning = this.prune().finally(() => (this.pruning = null));
    await this.pruning;
    return this.entries;
  }

  /** Drop entries whose file is gone, and previews that went missing. */
  async prune() {
    const exists = (file) => fs.promises.access(file).then(() => true, () => false);
    const entries = this.entries.slice(); // add/remove may change this.entries while we wait
    const found = await Promise.all(entries.map((e) => Promise.all([exists(e.file), !!e.preview && exists(e.preview)])));
    let changed = false;
    const gone = new Set();
    entries.forEach((e, i) => {
      const [file, preview] = found[i];
      if (!file && !this.writes.has(e.file)) gone.add(e);
      else if (e.preview && !preview && !this.writes.has(e.preview)) {
        e.preview = null;
        changed = true;
      }
    });
    if (gone.size) {
      for (const e of gone) this.discardFiles(e);
      this.entries = this.entries.filter((e) => !gone.has(e));
      changed = true;
    }
    if (changed) this.save();
  }

  /** Forget an entry. The user's own saved file stays; PinShot's copy goes. */
  remove(id) {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i < 0) return false;
    const [entry] = this.entries.splice(i, 1);
    this.discardFiles(entry);
    this.save();
    return true;
  }

  clear() {
    for (const entry of this.entries) this.discardFiles(entry);
    this.entries = [];
    this.save();
  }

  discardFiles(entry) {
    for (const file of [entry.preview, this.owns(entry.file) ? entry.file : null]) {
      if (!file) continue;
      fs.rmSync(file, { force: true });
      // Still being written: remove it again once that lands.
      const pending = this.writes.get(file);
      if (pending) this.track(pending.then(() => fs.promises.rm(file, { force: true })));
    }
  }
}

module.exports = { History };
