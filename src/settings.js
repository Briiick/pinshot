'use strict';

const fs = require('fs');
const path = require('path');

// Old default shortcuts that should follow the new defaults if the user never changed them.
const RETIRED_SHORTCUTS = {
  captureArea: ['CommandOrControl+Shift+2', 'CommandOrControl+Shift+3'],
  captureScreen: ['CommandOrControl+Shift+1'],
};

const DEFAULTS = {
  copyToClipboard: true,
  autoSave: true,
  playSound: true,
  // Select over a still copy of the screen instead of the live one. Linux
  // defaults to it because see-through windows need a running compositor.
  freezeScreen: process.platform === 'linux',
  recordMicrophone: false,
  recordSystemAudio: false,
  recordingFormat: 'mp4', // or 'gif'
  seenShortcutTip: false,
  saveDirectory: null, // null = <Pictures>/PinShot
  shortcuts: {
    captureScreen: 'CommandOrControl+Shift+3',
    captureArea: 'CommandOrControl+Shift+4',
    captureText: 'CommandOrControl+Shift+2',
    recordScreen: 'CommandOrControl+Shift+5',
    scrollingCapture: 'CommandOrControl+Shift+6',
    toggleAllPins: 'CommandOrControl+Alt+Shift+H',
  },
};

class Settings {
  constructor(file) {
    this.file = file;
    this.data = structuredClone(DEFAULTS);
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { ...this.data, ...saved, shortcuts: { ...this.data.shortcuts, ...saved.shortcuts } };
      for (const [name, old] of Object.entries(RETIRED_SHORTCUTS)) {
        if (old.includes(this.data.shortcuts[name])) this.data.shortcuts[name] = DEFAULTS.shortcuts[name];
      }
      // Never leave two actions on one shortcut after a migration.
      const seen = new Set();
      for (const name of Object.keys(this.data.shortcuts)) {
        const accel = this.data.shortcuts[name];
        if (accel && seen.has(accel)) this.data.shortcuts[name] = '';
        else if (accel) seen.add(accel);
      }
    } catch {
      // Missing or corrupt settings file: fall back to defaults.
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

module.exports = { Settings, DEFAULTS };
