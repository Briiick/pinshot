'use strict';

// Capture History: every screenshot and recording, newest first, kept after
// its thumbnail is gone. Entries point at the capture's file. Screenshots
// that weren't auto-saved get a copy in the history folder itself, so nothing
// you've taken is lost. Each entry also keeps a small preview image.

const fs = require('fs');
const path = require('path');

const LIMIT = 200;

class History {
  constructor(dir, { limit = LIMIT } = {}) {
    this.dir = dir;
    this.limit = limit;
    this.indexFile = path.join(dir, 'history.json');
    try {
      this.entries = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')).filter((e) => e && e.id && e.file);
    } catch {
      this.entries = [];
    }
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.entries, null, 2));
    fs.renameSync(tmp, this.indexFile);
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
    for (let n = 2; fs.existsSync(file); n++) file = path.join(this.dir, `${base} ${n}${ext}`);
    return file;
  }

  /**
   * Remember a capture. `preview` is a small PNG (Buffer) shown in the
   * History window. Returns the entry.
   */
  add({ file, kind = 'image', width = 0, height = 0, scale = 1, duration = 0, preview = null, createdAt = Date.now() }) {
    const id = `${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const entry = { id, file, kind, width, height, scale, duration, createdAt, preview: null };
    if (preview) {
      entry.preview = this.pathFor(`${id}.preview.png`);
      fs.writeFileSync(entry.preview, preview);
    }
    this.entries.unshift(entry);
    for (const old of this.entries.splice(this.limit)) this.discardFiles(old);
    this.save();
    return entry;
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
    if (preview) {
      entry.preview = entry.preview || this.pathFor(`${id}.preview.png`);
      fs.writeFileSync(entry.preview, preview);
    }
    this.save();
    return entry;
  }

  /** Entries whose file still exists (the user may have deleted or moved some). */
  list() {
    const live = this.entries.filter((e) => fs.existsSync(e.file));
    if (live.length !== this.entries.length) {
      for (const gone of this.entries.filter((e) => !live.includes(e))) this.discardFiles(gone);
      this.entries = live;
      this.save();
    }
    return this.entries;
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
    if (entry.preview) fs.rmSync(entry.preview, { force: true });
    if (this.owns(entry.file)) fs.rmSync(entry.file, { force: true });
  }
}

module.exports = { History };
