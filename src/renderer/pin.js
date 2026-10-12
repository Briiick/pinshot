'use strict';

const api = window.pinshot;
const shot = document.getElementById('shot');
const toast = document.getElementById('toast');

api.invoke('capture:init').then((data) => {
  if (data) shot.src = data.dataUrl;
});
api.on('image', (dataUrl) => {
  shot.src = dataUrl;
});

let toastTimer;
function flash(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 1100);
}

const actions = {
  close: () => api.send('pin:close'),
  edit: () => api.send('pin:edit'),
  copy: () => { api.send('pin:copy'); flash('Copied'); },
  save: () => api.send('pin:save'),
};

document.getElementById('toolbar').addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (button) actions[button.dataset.action]();
});

// --- Dragging -------------------------------------------------------------
// Done by hand rather than with -webkit-app-region so that double-click,
// right-click and wheel events still reach the page.
// The main process moves the window from the real cursor position, so the
// drag stays glued to the pointer however far the window has moved.
let drag = null;
window.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  drag = { x: e.screenX, y: e.screenY, moved: false };
  document.body.setPointerCapture(e.pointerId);
  api.send('pin:drag', 'start');
});
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.screenX - drag.x, e.screenY - drag.y) < 3) return;
  drag.moved = true;
  document.body.classList.add('dragging');
  api.send('pin:drag', 'move');
});
window.addEventListener('pointerup', () => {
  if (drag) api.send('pin:drag', 'end');
  drag = null;
  document.body.classList.remove('dragging');
});

window.addEventListener('dblclick', (e) => {
  if (!e.target.closest('button')) actions.edit();
});
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api.send('pin:menu');
});

// Scroll to zoom, Alt/Option+scroll to change opacity.
let wheelAccum = 0;
window.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.altKey) {
    api.send('pin:opacity-by', e.deltaY > 0 ? -0.05 : 0.05);
    return;
  }
  wheelAccum += e.deltaY;
  if (Math.abs(wheelAccum) < 4) return; // ignore trackpad jitter
  api.send('pin:zoom', wheelAccum < 0 ? 1.06 : 1 / 1.06);
  wheelAccum = 0;
}, { passive: false });

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape' || (mod && e.key === 'w')) actions.close();
  else if (mod && e.key === 'c') actions.copy();
  else if (mod && e.key === 's') { e.preventDefault(); actions.save(); }
  else if (mod && e.key === '0') api.send('pin:actual-size');
  else if (mod && (e.key === '=' || e.key === '+')) api.send('pin:zoom', 1.15);
  else if (mod && e.key === '-') api.send('pin:zoom', 1 / 1.15);
  else if (e.key === 'Enter' || e.key === 'e') actions.edit();
});

window.addEventListener('focus', () => document.body.classList.add('focused'));
window.addEventListener('blur', () => document.body.classList.remove('focused'));
const updateTiny = () => document.body.classList.toggle('tiny', window.innerWidth < 110 || window.innerHeight < 50);
window.addEventListener('resize', updateTiny);
updateTiny();
