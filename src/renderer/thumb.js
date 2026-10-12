'use strict';

const api = window.pinshot;
const shot = document.getElementById('shot');

/** Show what kind of capture this is and whether it's busy (e.g. making a GIF). */
function apply(data) {
  const moving = data.kind === 'video' || data.kind === 'gif';
  document.body.classList.toggle('video', moving);
  document.body.classList.toggle('gif', data.kind === 'gif');
  if (moving) {
    const secs = Math.round(data.duration || 0);
    const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    document.getElementById('duration').textContent = data.kind === 'gif' ? `GIF · ${time}` : time;
  }
  const busy = document.getElementById('busy');
  busy.textContent = data.busy || '';
  busy.hidden = !data.busy;
}

api.invoke('capture:init').then((data) => {
  if (!data) return;
  apply(data);
  // Only start the fly-in once the screenshot has painted at its original spot.
  shot.onload = () => {
    shot.onload = null;
    requestAnimationFrame(() => api.send('thumb:ready'));
  };
  shot.src = data.dataUrl;
});
api.on('thumb:refresh', apply);
api.on('image', (dataUrl) => {
  shot.src = dataUrl;
});
api.on('thumb:landed', () => document.body.classList.remove('flying'));

document.getElementById('hover').addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (button) api.send(`thumb:${button.dataset.action}`);
});
document.getElementById('hover').addEventListener('dblclick', (e) => {
  if (e.target.closest('button')) return;
  api.send(document.body.classList.contains('video') ? 'thumb:open' : 'thumb:edit');
});

// Drag the thumbnail into Finder, Slack, a browser… as a PNG file.
document.getElementById('hover').addEventListener('dragstart', (e) => {
  e.preventDefault();
  api.send('thumb:drag');
});
window.addEventListener('contextmenu', (e) => e.preventDefault());
