'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Only these channels are reachable from the renderers.
const SEND = new Set([
  'overlay:ready', 'overlay:select', 'overlay:cancel', 'overlay:drag', 'overlay:window-mode', 'overlay:need-windows',
  'thumb:ready', 'thumb:close', 'thumb:copy', 'thumb:save', 'thumb:edit', 'thumb:pin', 'thumb:drag',
  'thumb:open', 'thumb:reveal', 'thumb:text', 'thumb:gif',
  'scroll:done', 'scroll:cancel', 'scroll:error',
  'gif:progress', 'gif:done', 'gif:error',
  'prefs:open-folder', 'prefs:shortcut-tip', 'prefs:pause-shortcuts',
  'rec:started', 'rec:chunk', 'rec:stopped', 'rec:cancel', 'rec:error',
  'pin:drag', 'pin:zoom', 'pin:opacity-by', 'pin:actual-size', 'pin:close',
  'pin:copy', 'pin:save', 'pin:edit', 'pin:menu',
  'editor:done', 'editor:cancel', 'editor:copy',
  'history:restore', 'history:edit', 'history:pin', 'history:copy', 'history:open', 'history:reveal',
  'history:drag', 'history:delete', 'history:clear', 'history:open-folder',
]);
const INVOKE = new Set([
  'capture:init', 'editor:save-as', 'editor:confirm-discard', 'rec:init', 'scroll:init', 'gif:init',
  'prefs:get', 'prefs:set', 'prefs:choose-folder', 'history:list',
]);
const RECEIVE = new Set([
  'overlay:image', 'overlay:start', 'overlay:windows', 'overlay:reset', 'overlay:remote', 'overlay:window-mode', 'overlay:shown',
  'image', 'thumb:landed', 'thumb:refresh', 'rec:stop', 'scroll:finish', 'hud:message', 'history:changed',
]);

contextBridge.exposeInMainWorld('pinshot', {
  platform: process.platform,
  send(channel, ...args) {
    if (SEND.has(channel)) ipcRenderer.send(channel, ...args);
  },
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`Blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, fn) {
    if (RECEIVE.has(channel)) ipcRenderer.on(channel, (_event, ...args) => fn(...args));
  },
});
