'use strict';

// Capture History: every screenshot and recording, grouped by day. Hover a
// capture for its actions, drag it into another app, or double-click it to
// bring it back to the corner.

const api = window.pinshot;
const list = document.getElementById('list');
const empty = document.getElementById('empty');
const template = document.getElementById('card');
const mac = api.platform === 'darwin';
let entries = [];
let filter = 'all';

const pad = (n) => String(n).padStart(2, '0');
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function dayLabel(d) {
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: days > 300 ? 'numeric' : undefined });
}

function duration(secs) {
  const s = Math.round(secs || 0);
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

function card(e) {
  const el = template.content.firstElementChild.cloneNode(true);
  el.dataset.id = e.id;
  el.classList.add(e.kind);
  el.title = e.name;
  const img = el.querySelector('img');
  if (e.preview) img.src = e.preview;
  if (e.kind !== 'image') {
    const badge = el.querySelector('.badge');
    badge.textContent = e.kind === 'gif' ? `GIF · ${duration(e.duration)}` : `▶ ${duration(e.duration)}`;
    badge.hidden = false;
  }
  el.querySelector('.time').textContent = clock(new Date(e.createdAt));
  if (e.kind === 'image' && e.width) {
    el.querySelector('.size').textContent = `${Math.round(e.width / (e.scale || 1))} × ${Math.round(e.height / (e.scale || 1))}`;
  }
  return el;
}

function render() {
  const shown = entries.filter((e) => filter === 'all' || (filter === 'image' ? e.kind === 'image' : e.kind !== 'image'));
  const focused = document.activeElement?.closest?.('.card')?.dataset.id;
  list.textContent = '';
  let group = null;
  let label = null;
  for (const e of shown) {
    const day = dayLabel(new Date(e.createdAt));
    if (day !== label) {
      label = day;
      const h = document.createElement('h2');
      h.textContent = day;
      group = document.createElement('div');
      group.className = 'grid';
      list.append(h, group);
    }
    group.append(card(e));
  }
  empty.hidden = shown.length > 0;
  list.hidden = shown.length === 0;
  if (focused) list.querySelector(`[data-id="${focused}"]`)?.focus();
}

async function load() {
  entries = await api.invoke('history:list');
  render();
}

const idOf = (target) => target.closest?.('.card')?.dataset.id;

list.addEventListener('click', (e) => {
  const button = e.target.closest('button');
  const id = idOf(e.target);
  if (button && id) api.send(`history:${button.dataset.action}`, id);
});
list.addEventListener('dblclick', (e) => {
  const id = idOf(e.target);
  if (id && !e.target.closest('button')) api.send('history:restore', id);
});
// Drag a capture into Finder, Slack, Mail, a browser…
list.addEventListener('dragstart', (e) => {
  const id = idOf(e.target);
  e.preventDefault();
  if (id) api.send('history:drag', id);
});
list.addEventListener('keydown', (e) => {
  const id = idOf(e.target);
  if (!id || e.target.closest('button')) return;
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const next = e.target.nextElementSibling || e.target.previousElementSibling;
    api.send('history:delete', id);
    next?.focus();
  } else if (e.key === 'Enter') api.send('history:restore', id);
  else if (mod && e.key.toLowerCase() === 'c') api.send('history:copy', id);
  else return;
  e.preventDefault();
});

document.getElementById('filter').addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (!button) return;
  filter = button.dataset.filter;
  for (const b of document.querySelectorAll('#filter button')) b.classList.toggle('on', b === button);
  render();
});
document.getElementById('open-folder').addEventListener('click', () => api.send('history:open-folder'));
document.getElementById('clear').addEventListener('click', () => api.send('history:clear'));

api.on('history:changed', load);
window.addEventListener('focus', load); // files may have changed while we were away
load();
