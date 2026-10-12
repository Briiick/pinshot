'use strict';

const api = window.pinshot;
const isMac = api.platform === 'darwin';
let state = null;
let recordingField = null; // the shortcut button currently listening for keys

if (!isMac) for (const el of document.querySelectorAll('.mac-only')) el.hidden = true;

// --- Accelerators ----------------------------------------------------------------

const CODE_KEYS = {
  Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Backquote: '`', Space: 'Space', Enter: 'Enter', Tab: 'Tab',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
};

/** The Electron accelerator for a key press, an { error }, or null for a bare modifier. */
function acceleratorFor(e) {
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  if (!key) return null;
  const mods = [];
  if (isMac ? e.metaKey : e.ctrlKey) mods.push('CommandOrControl');
  if (isMac && e.ctrlKey) mods.push('Control');
  if (!isMac && e.metaKey) mods.push('Super');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (!mods.length && !/^F\d+$/.test(key)) return { error: isMac ? 'Add ⌘, ⌥, ⌃ or ⇧' : 'Add Ctrl, Alt or Shift' };
  return [...mods, key].join('+');
}

/** How an accelerator reads on this platform, e.g. ⌘⇧3 or Ctrl+Shift+3. */
function pretty(accel) {
  if (!accel) return 'Record shortcut';
  const parts = accel.split('+');
  const key = parts.pop();
  if (isMac) {
    const sym = { Control: '⌃', Alt: '⌥', Shift: '⇧', CommandOrControl: '⌘', Command: '⌘', Super: '⌘' };
    const order = ['Control', 'Alt', 'Shift', 'CommandOrControl', 'Command', 'Super'];
    const keys = { Space: 'Space', Up: '↑', Down: '↓', Left: '←', Right: '→', Enter: '↩', Tab: '⇥' };
    return order.filter((m) => parts.includes(m)).map((m) => sym[m]).join('') + (keys[key] || key);
  }
  const names = { CommandOrControl: 'Ctrl', Control: 'Ctrl', Super: 'Win' };
  return [...parts.map((m) => names[m] || m), key].join('+');
}

// --- Rendering --------------------------------------------------------------------

function renderShortcuts() {
  const wrap = document.getElementById('shortcuts');
  wrap.textContent = '';
  for (const [name, label] of Object.entries(state.actions)) {
    const accel = state.settings.shortcuts[name] || '';
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span></span><span class="shortcut-cell"><button class="shortcut"></button><span class="error" hidden></span></span>`;
    row.querySelector('span').textContent = label;
    const button = row.querySelector('.shortcut');
    button.dataset.name = name;
    button.textContent = pretty(accel);
    button.classList.toggle('empty', !accel);
    const error = row.querySelector('.error');
    if (state.shortcutErrors[name]) {
      error.textContent = state.shortcutErrors[name];
      error.hidden = false;
    }
    button.addEventListener('click', () => startRecording(button));
    wrap.appendChild(row);
  }
}

function render() {
  document.getElementById('version').textContent = `v${state.version}`;
  document.getElementById('folder').textContent = state.saveDirectory;
  document.getElementById('row-login').hidden = state.launchAtLogin === null;
  document.getElementById('row-system-audio').hidden = !state.systemAudioSupported;
  for (const input of document.querySelectorAll('input[data-pref]')) {
    const key = input.dataset.pref;
    input.checked = key === 'launchAtLogin' ? !!state.launchAtLogin : !!state.settings[key];
  }
  for (const group of document.querySelectorAll('.segmented[data-pref]')) {
    for (const b of group.querySelectorAll('button')) b.classList.toggle('on', state.settings[group.dataset.pref] === b.dataset.value);
  }
  renderShortcuts();
}

async function set(key, value) {
  const result = await api.invoke('prefs:set', key, value);
  state = result.state;
  render();
  return result;
}

// --- Shortcut recording -----------------------------------------------------------

function startRecording(button) {
  if (recordingField) stopRecording();
  recordingField = button;
  button.classList.add('recording');
  button.textContent = 'Type shortcut…';
  api.send('prefs:pause-shortcuts', true);
}

function stopRecording() {
  if (!recordingField) return;
  recordingField = null;
  api.send('prefs:pause-shortcuts', false);
  render();
}

function showError(name, message) {
  const button = document.querySelector(`.shortcut[data-name="${name}"]`);
  const error = button?.parentElement.querySelector('.error');
  if (!error) return;
  error.textContent = message;
  error.hidden = false;
}

window.addEventListener(
  'keydown',
  async (e) => {
    if (!recordingField) return;
    e.preventDefault();
    e.stopPropagation();
    const name = recordingField.dataset.name;
    if (e.key === 'Escape') return stopRecording();
    if (e.key === 'Backspace' || e.key === 'Delete') {
      recordingField = null;
      await set(`shortcut:${name}`, '');
      return;
    }
    const accel = acceleratorFor(e);
    if (!accel) return; // just a modifier so far
    if (accel.error) {
      recordingField.textContent = accel.error;
      return;
    }
    recordingField = null;
    const result = await set(`shortcut:${name}`, accel);
    if (!result.ok) showError(name, result.error);
  },
  true,
);
window.addEventListener('blur', stopRecording);
document.addEventListener('click', (e) => {
  if (recordingField && e.target !== recordingField) stopRecording();
});

// --- Other controls ---------------------------------------------------------------

for (const input of document.querySelectorAll('input[data-pref]')) {
  input.addEventListener('change', () => set(input.dataset.pref, input.checked));
}
for (const group of document.querySelectorAll('.segmented[data-pref]')) {
  group.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) set(group.dataset.pref, b.dataset.value);
  });
}
document.getElementById('choose-folder').addEventListener('click', async () => {
  await api.invoke('prefs:choose-folder');
  state = await api.invoke('prefs:get');
  render();
});
document.getElementById('open-folder').addEventListener('click', () => api.send('prefs:open-folder'));
document.getElementById('shortcut-tip').addEventListener('click', () => api.send('prefs:shortcut-tip'));

api.invoke('prefs:get').then((s) => {
  state = s;
  render();
  document.body.dataset.ready = '1';
});
