'use strict';

// PinShot annotation editor.
//
// Annotations are kept as plain objects (not painted pixels) so they can be
// selected, moved, recoloured and undone. Everything is stored in image-pixel
// coordinates; the canvas backing store is 1:1 with the (cropped) image and
// CSS scales it to fit the window.

const api = window.pinshot;
const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const textEditor = $('textEditor');

const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#af52de', '#ffffff', '#1c1c1e'];
const SIZES = { 1: 2, 2: 4, 3: 8 }; // stroke width in points (multiplied by capture scale)
const TOOL_KEYS = { v: 'select', a: 'arrow', r: 'rect', o: 'ellipse', l: 'line', p: 'pen', h: 'highlighter', t: 'text', n: 'step', b: 'pixelate', c: 'crop' };

const image = new Image();
let scale = 1; // capture density (image pixels per point)

const state = {
  tool: 'arrow',
  color: COLORS[0],
  size: 2,
  doc: { crop: null, shapes: [] },
  selectedId: null,
  draft: null, // shape being drawn
  pendingCrop: null,
  drag: null,
};

let nextId = 1;
const history = { stack: [], index: -1 };

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

if (api.platform === 'darwin') document.body.classList.add('mac');

api.invoke('capture:init').then((data) => {
  if (!data) return;
  scale = data.scale || 1;
  image.onload = () => {
    state.doc.crop = { x: 0, y: 0, w: image.naturalWidth, h: image.naturalHeight };
    commit();
    layout();
  };
  image.src = data.dataUrl;
});

buildColorPicker();
setColor(COLORS[0]);
setTool('arrow');
setSize(2);
window.addEventListener('resize', layout);

function buildColorPicker() {
  const wrap = $('colors');
  for (const color of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.color = color;
    b.title = color;
    b.innerHTML = `<i style="background:${color}"></i>`;
    wrap.appendChild(b);
  }
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.id = 'customColor';
  custom.title = 'Custom color';
  custom.addEventListener('input', () => setColor(custom.value));
  wrap.appendChild(custom);
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('.swatch');
    if (b) setColor(b.dataset.color);
  });
}

// ---------------------------------------------------------------------------
// Toolbar state
// ---------------------------------------------------------------------------

function setTool(tool) {
  commitText();
  if (state.pendingCrop && tool !== 'crop') cancelCrop();
  state.tool = tool;
  if (tool !== 'select') state.selectedId = null;
  for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
  canvas.className = tool === 'select' ? 'select' : '';
  $('cropBar').hidden = tool !== 'crop';
  render();
}

function setColor(color) {
  if (state.color === color && !selectedShape()) return markSwatch(color);
  state.color = color;
  markSwatch(color);
  const sel = selectedShape();
  if (sel && 'color' in sel && sel.color !== color) {
    sel.color = color;
    commit();
  }
  if (!textEditor.hidden) textEditor.style.color = color;
}

function markSwatch(color) {
  for (const b of document.querySelectorAll('.swatch')) b.classList.toggle('active', b.dataset.color === color);
}

function setSize(size) {
  state.size = size;
  for (const b of document.querySelectorAll('[data-size]')) b.classList.toggle('active', Number(b.dataset.size) === size);
  const sel = selectedShape();
  if (sel && 'size' in sel && sel.size !== size) {
    sel.size = size;
    if (sel.type === 'text') sel.fontSize = fontSizeFor(size);
    commit();
  }
}

document.getElementById('tools').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tool]');
  if (b) setTool(b.dataset.tool);
});
document.getElementById('sizes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-size]');
  if (b) setSize(Number(b.dataset.size));
});
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('copy').addEventListener('click', copyImage);
$('save').addEventListener('click', saveImage);
$('done').addEventListener('click', done);
$('cancel').addEventListener('click', cancel);
$('cropApply').addEventListener('click', applyCrop);
$('cropCancel').addEventListener('click', () => { cancelCrop(); setTool('select'); });

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function commit() {
  history.stack = history.stack.slice(0, history.index + 1);
  history.stack.push(JSON.stringify(state.doc));
  history.index = history.stack.length - 1;
  updateHistoryButtons();
  render();
}

function restore() {
  state.doc = JSON.parse(history.stack[history.index]);
  if (!selectedShape()) state.selectedId = null;
  updateHistoryButtons();
  render();
}

function undo() {
  commitText();
  if (history.index <= 0) return;
  history.index--;
  restore();
}

function redo() {
  if (history.index >= history.stack.length - 1) return;
  history.index++;
  restore();
}

function updateHistoryButtons() {
  $('undo').disabled = history.index <= 0;
  $('redo').disabled = history.index >= history.stack.length - 1;
}

function isDirty() {
  return history.index > 0;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function px(points) { return points * scale; }
function strokeWidth(size) { return px(SIZES[size] || 4); }
function fontSizeFor(size) { return px({ 1: 16, 2: 24, 3: 36 }[size] || 24); }
function stepRadius(size) { return px({ 1: 11, 2: 14, 3: 19 }[size] || 14); }

function normalize(r) {
  return {
    x: Math.min(r.x, r.x + r.w),
    y: Math.min(r.y, r.y + r.h),
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  };
}

/** Pointer event -> image pixel coordinates. */
function toImage(e) {
  const r = canvas.getBoundingClientRect();
  const crop = state.doc.crop;
  return {
    x: ((e.clientX - r.left) * canvas.width) / r.width + crop.x,
    y: ((e.clientY - r.top) * canvas.height) / r.height + crop.y,
  };
}

/** CSS pixels per image pixel at the current zoom. */
function cssPerPixel() {
  return canvas.getBoundingClientRect().width / canvas.width || 1;
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function textBounds(s) {
  ctx.save();
  ctx.font = textFont(s);
  const lines = s.text.split('\n');
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width), s.fontSize * 0.5);
  ctx.restore();
  return { x: s.x, y: s.y, w, h: lines.length * s.fontSize * 1.2 };
}

function bounds(s) {
  switch (s.type) {
    case 'arrow':
    case 'line':
      return normalize({ x: s.x1, y: s.y1, w: s.x2 - s.x1, h: s.y2 - s.y1 });
    case 'pen':
    case 'highlighter': {
      const xs = s.points.map((p) => p[0]);
      const ys = s.points.map((p) => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    case 'text':
      return textBounds(s);
    case 'step': {
      const r = stepRadius(s.size);
      return { x: s.x - r, y: s.y - r, w: r * 2, h: r * 2 };
    }
    default:
      return normalize(s);
  }
}

function hitTest(p) {
  const tol = Math.max(px(6), 6 / cssPerPixel());
  for (let i = state.doc.shapes.length - 1; i >= 0; i--) {
    const s = state.doc.shapes[i];
    if (s.type === 'arrow' || s.type === 'line') {
      if (distToSegment(p, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }) <= tol + strokeWidth(s.size)) return s;
      continue;
    }
    if (s.type === 'pen' || s.type === 'highlighter') {
      const w = strokeWidth(s.size) * (s.type === 'highlighter' ? 4 : 1);
      for (let j = 1; j < s.points.length; j++) {
        const a = { x: s.points[j - 1][0], y: s.points[j - 1][1] };
        const b = { x: s.points[j][0], y: s.points[j][1] };
        if (distToSegment(p, a, b) <= tol + w / 2) return s;
      }
      continue;
    }
    const b = bounds(s);
    if (p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol) return s;
  }
  return null;
}

function moveShape(s, dx, dy) {
  if ('x1' in s) {
    s.x1 += dx; s.y1 += dy; s.x2 += dx; s.y2 += dy;
  } else if (s.points) {
    for (const pt of s.points) { pt[0] += dx; pt[1] += dy; }
  } else {
    s.x += dx; s.y += dy;
  }
}

function selectedShape() {
  return state.doc.shapes.find((s) => s.id === state.selectedId) || null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function layout() {
  const crop = state.doc.crop;
  if (!crop) return;
  canvas.width = Math.round(crop.w);
  canvas.height = Math.round(crop.h);
  const stage = $('stage');
  const availW = stage.clientWidth - 40;
  const availH = stage.clientHeight - 40;
  // Show at real on-screen size when it fits, otherwise fit to the window.
  const natural = 1 / scale;
  const fit = Math.min(natural, availW / crop.w, availH / crop.h);
  canvas.style.width = `${Math.max(1, Math.floor(crop.w * fit))}px`;
  canvas.style.height = `${Math.max(1, Math.floor(crop.h * fit))}px`;
  render();
  positionTextEditor();
}

function render() {
  if (!state.doc.crop || !image.naturalWidth) return;
  if (canvas.width !== Math.round(state.doc.crop.w) || canvas.height !== Math.round(state.doc.crop.h)) {
    layout();
    return;
  }
  drawDocument(ctx, state.doc, { interactive: true });
}

function drawDocument(c, doc, { interactive }) {
  const { crop } = doc;
  c.save();
  c.clearRect(0, 0, c.canvas.width, c.canvas.height);
  c.translate(-crop.x, -crop.y);
  c.drawImage(image, 0, 0);

  const shapes = [...doc.shapes];
  if (interactive && state.draft) shapes.push(state.draft);
  // Redactions go first so they only ever cover the screenshot itself.
  for (const s of shapes) if (s.type === 'pixelate') drawShape(c, s);
  for (const s of shapes) if (s.type !== 'pixelate' && !(interactive && s.id === state.editingTextId)) drawShape(c, s);

  if (interactive) {
    const sel = selectedShape();
    if (sel) drawSelection(c, sel);
    if (state.pendingCrop) drawCropOverlay(c, normalize(state.pendingCrop));
  }
  c.restore();
}

function drawShape(c, s) {
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.strokeStyle = s.color;
  c.fillStyle = s.color;
  c.lineWidth = strokeWidth(s.size);
  switch (s.type) {
    case 'arrow': drawArrow(c, s); break;
    case 'line':
      c.beginPath(); c.moveTo(s.x1, s.y1); c.lineTo(s.x2, s.y2); c.stroke();
      break;
    case 'rect': {
      const r = normalize(s);
      const radius = Math.min(px(4), r.w / 2, r.h / 2);
      c.beginPath(); c.roundRect(r.x, r.y, r.w, r.h, radius); c.stroke();
      break;
    }
    case 'ellipse': {
      const r = normalize(s);
      c.beginPath();
      c.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      c.stroke();
      break;
    }
    case 'pen':
    case 'highlighter':
      if (s.type === 'highlighter') {
        c.globalAlpha = 0.4;
        c.globalCompositeOperation = 'multiply';
        c.lineWidth = strokeWidth(s.size) * 4;
        c.lineCap = 'butt';
      }
      drawPath(c, s.points);
      break;
    case 'text': drawText(c, s); break;
    case 'step': drawStep(c, s); break;
    case 'pixelate': drawPixelate(c, normalize(s)); break;
  }
  c.restore();
}

function drawPath(c, points) {
  if (!points.length) return;
  c.beginPath();
  c.moveTo(points[0][0], points[0][1]);
  if (points.length === 1) c.lineTo(points[0][0] + 0.01, points[0][1]);
  // Smooth through midpoints with quadratic curves.
  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i][0] + points[i + 1][0]) / 2;
    const my = (points[i][1] + points[i + 1][1]) / 2;
    c.quadraticCurveTo(points[i][0], points[i][1], mx, my);
  }
  if (points.length > 1) c.lineTo(points[points.length - 1][0], points[points.length - 1][1]);
  c.stroke();
}

function drawArrow(c, s) {
  const w = c.lineWidth;
  const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
  const length = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
  const head = Math.min(length * 0.6, w * 3.2 + px(8));
  const spread = Math.PI / 7;
  const baseX = s.x2 - Math.cos(angle) * head * 0.8;
  const baseY = s.y2 - Math.sin(angle) * head * 0.8;

  c.beginPath();
  c.moveTo(s.x1, s.y1);
  c.lineTo(baseX, baseY);
  c.stroke();

  c.beginPath();
  c.moveTo(s.x2, s.y2);
  c.lineTo(s.x2 - head * Math.cos(angle - spread), s.y2 - head * Math.sin(angle - spread));
  c.lineTo(baseX, baseY);
  c.lineTo(s.x2 - head * Math.cos(angle + spread), s.y2 - head * Math.sin(angle + spread));
  c.closePath();
  c.lineWidth = w * 0.5;
  c.fill();
  c.stroke();
}

function textFont(s) {
  return `600 ${s.fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
}

function isLight(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 160;
}

function drawText(c, s) {
  c.font = textFont(s);
  c.textBaseline = 'top';
  c.lineJoin = 'round';
  c.lineWidth = Math.max(2, s.fontSize * 0.16);
  c.strokeStyle = isLight(s.color) ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.9)';
  s.text.split('\n').forEach((line, i) => {
    const y = s.y + i * s.fontSize * 1.2;
    c.strokeText(line, s.x, y);
    c.fillText(line, s.x, y);
  });
}

function drawStep(c, s) {
  const r = stepRadius(s.size);
  c.beginPath();
  c.arc(s.x, s.y, r, 0, Math.PI * 2);
  c.shadowColor = 'rgba(0,0,0,0.3)';
  c.shadowBlur = px(3);
  c.fill();
  c.shadowColor = 'transparent';
  c.lineWidth = px(1.5);
  c.strokeStyle = '#fff';
  c.stroke();
  c.fillStyle = isLight(s.color) ? '#1c1c1e' : '#fff';
  c.font = `700 ${r * 1.15}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(String(s.n), s.x, s.y + r * 0.05);
}

const pixelCanvas = document.createElement('canvas');
function drawPixelate(c, r) {
  if (r.w < 1 || r.h < 1) return;
  const block = Math.max(6, Math.round(px(7)));
  const w = Math.max(1, Math.ceil(r.w / block));
  const h = Math.max(1, Math.ceil(r.h / block));
  pixelCanvas.width = w;
  pixelCanvas.height = h;
  const pc = pixelCanvas.getContext('2d');
  pc.imageSmoothingEnabled = true;
  pc.drawImage(image, r.x, r.y, r.w, r.h, 0, 0, w, h);
  c.imageSmoothingEnabled = false;
  c.drawImage(pixelCanvas, 0, 0, w, h, r.x, r.y, r.w, r.h);
}

function drawSelection(c, s) {
  const b = bounds(s);
  const pad = px(4);
  const unit = 1 / cssPerPixel();
  c.save();
  c.setLineDash([4 * unit, 3 * unit]);
  c.lineWidth = 1.5 * unit;
  c.strokeStyle = '#0a84ff';
  c.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  c.restore();
}

function drawCropOverlay(c, r) {
  const crop = state.doc.crop;
  const unit = 1 / cssPerPixel();
  c.save();
  c.fillStyle = 'rgba(0,0,0,0.5)';
  c.beginPath();
  c.rect(crop.x, crop.y, crop.w, crop.h);
  c.rect(r.x, r.y, r.w, r.h);
  c.fill('evenodd');
  c.strokeStyle = '#fff';
  c.lineWidth = 1.5 * unit;
  c.strokeRect(r.x, r.y, r.w, r.h);
  // Rule-of-thirds guides.
  c.globalAlpha = 0.5;
  c.lineWidth = unit;
  c.beginPath();
  for (let i = 1; i < 3; i++) {
    c.moveTo(r.x + (r.w * i) / 3, r.y); c.lineTo(r.x + (r.w * i) / 3, r.y + r.h);
    c.moveTo(r.x, r.y + (r.h * i) / 3); c.lineTo(r.x + r.w, r.y + (r.h * i) / 3);
  }
  c.stroke();
  c.restore();
}

// ---------------------------------------------------------------------------
// Pointer interaction
// ---------------------------------------------------------------------------

function clampToCrop(p) {
  const c = state.doc.crop;
  return { x: Math.min(c.x + c.w, Math.max(c.x, p.x)), y: Math.min(c.y + c.h, Math.max(c.y, p.y)) };
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !state.doc.crop) return;
  const p = toImage(e);
  if (!textEditor.hidden) { commitText(); return; }
  canvas.setPointerCapture(e.pointerId);

  const base = { id: nextId++, color: state.color, size: state.size };
  switch (state.tool) {
    case 'select': {
      const hit = hitTest(p);
      state.selectedId = hit ? hit.id : null;
      if (hit) {
        state.drag = { last: p, moved: false };
        canvas.classList.add('moving');
      }
      render();
      return;
    }
    case 'arrow':
    case 'line':
      state.draft = { ...base, type: state.tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      break;
    case 'rect':
    case 'ellipse':
      state.draft = { ...base, type: state.tool, x: p.x, y: p.y, w: 0, h: 0 };
      break;
    case 'pixelate': {
      const q = clampToCrop(p);
      state.draft = { id: base.id, type: 'pixelate', x: q.x, y: q.y, w: 0, h: 0 };
      break;
    }
    case 'pen':
    case 'highlighter':
      state.draft = { ...base, type: state.tool, points: [[p.x, p.y]] };
      break;
    case 'step': {
      const n = state.doc.shapes.filter((s) => s.type === 'step').reduce((m, s) => Math.max(m, s.n), 0) + 1;
      state.doc.shapes.push({ ...base, type: 'step', x: p.x, y: p.y, n });
      commit();
      return;
    }
    case 'text': {
      const hit = hitTest(p);
      if (hit && hit.type === 'text') startTextEdit(hit);
      else startTextEdit({ ...base, type: 'text', x: p.x, y: p.y - fontSizeFor(state.size) * 0.6, text: '', fontSize: fontSizeFor(state.size) }, true);
      return;
    }
    case 'crop': {
      const q = clampToCrop(p);
      state.pendingCrop = { x: q.x, y: q.y, w: 0, h: 0 };
      state.drag = { crop: true };
      break;
    }
  }
  render();
});

canvas.addEventListener('pointermove', (e) => {
  if (!state.doc.crop) return;
  let p = toImage(e);

  if (state.tool === 'select' && !state.drag) {
    canvas.classList.toggle('moving', !!hitTest(p));
    return;
  }
  if (state.drag && state.drag.last) {
    const sel = selectedShape();
    if (sel) {
      moveShape(sel, p.x - state.drag.last.x, p.y - state.drag.last.y);
      state.drag.last = p;
      state.drag.moved = true;
      render();
    }
    return;
  }
  if (state.drag && state.drag.crop) {
    p = clampToCrop(p);
    state.pendingCrop.w = p.x - state.pendingCrop.x;
    state.pendingCrop.h = p.y - state.pendingCrop.y;
    render();
    return;
  }

  const d = state.draft;
  if (!d) return;
  if (d.type === 'arrow' || d.type === 'line') {
    if (e.shiftKey) p = snapAngle({ x: d.x1, y: d.y1 }, p);
    d.x2 = p.x;
    d.y2 = p.y;
  } else if (d.points) {
    const last = d.points[d.points.length - 1];
    if (Math.hypot(p.x - last[0], p.y - last[1]) >= px(1.5)) d.points.push([p.x, p.y]);
  } else {
    if (d.type === 'pixelate') p = clampToCrop(p);
    d.w = p.x - d.x;
    d.h = p.y - d.y;
    if (e.shiftKey && d.type !== 'pixelate') {
      const side = Math.max(Math.abs(d.w), Math.abs(d.h));
      d.w = Math.sign(d.w || 1) * side;
      d.h = Math.sign(d.h || 1) * side;
    }
  }
  render();
});

function snapAngle(origin, p) {
  const angle = Math.atan2(p.y - origin.y, p.x - origin.x);
  const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(p.x - origin.x, p.y - origin.y);
  return { x: origin.x + Math.cos(snapped) * len, y: origin.y + Math.sin(snapped) * len };
}

canvas.addEventListener('pointerup', () => {
  if (state.drag) {
    const moved = state.drag.moved;
    state.drag = null;
    canvas.classList.remove('moving');
    if (moved) commit();
    return;
  }
  const d = state.draft;
  if (!d) return;
  state.draft = null;
  const minSize = px(3);
  let keep = true;
  if (d.type === 'arrow' || d.type === 'line') keep = Math.hypot(d.x2 - d.x1, d.y2 - d.y1) >= minSize;
  else if (!d.points) {
    Object.assign(d, normalize(d));
    keep = d.w >= minSize && d.h >= minSize;
  }
  if (keep) {
    state.doc.shapes.push(d);
    commit();
  } else {
    render();
  }
});

// Keep focus in the text box when a click on the canvas opens it.
canvas.addEventListener('mousedown', (e) => e.preventDefault());

canvas.addEventListener('dblclick', (e) => {
  const hit = hitTest(toImage(e));
  if (hit && hit.type === 'text') startTextEdit(hit);
});

// ---------------------------------------------------------------------------
// Text editing
// ---------------------------------------------------------------------------

function startTextEdit(shape, isNew = false) {
  state.editing = { shape, isNew };
  state.editingTextId = shape.id;
  state.selectedId = null;
  textEditor.value = shape.text;
  textEditor.style.color = shape.color;
  textEditor.hidden = false;
  positionTextEditor();
  render();
  textEditor.focus();
  textEditor.select();
}

function positionTextEditor() {
  if (!state.editing) return;
  const s = state.editing.shape;
  const k = cssPerPixel();
  const crop = state.doc.crop;
  const fontPx = s.fontSize * k;
  textEditor.style.left = `${(s.x - crop.x) * k}px`;
  textEditor.style.top = `${(s.y - crop.y) * k}px`;
  textEditor.style.fontSize = `${fontPx}px`;
  const lines = textEditor.value.split('\n');
  textEditor.style.width = `${Math.max(2, ...lines.map((l) => l.length + 1)) * fontPx * 0.62}px`;
  textEditor.style.height = `${lines.length * fontPx * 1.2 + 4}px`;
}

textEditor.addEventListener('input', positionTextEditor);
textEditor.addEventListener('blur', () => commitText());
textEditor.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
    e.preventDefault();
    commitText();
  }
});

function commitText() {
  if (!state.editing) return;
  const { shape, isNew } = state.editing;
  state.editing = null;
  state.editingTextId = null;
  const text = textEditor.value.replace(/\s+$/, '');
  textEditor.hidden = true;
  const shapes = state.doc.shapes;
  if (!text) {
    if (!isNew) state.doc.shapes = shapes.filter((s) => s !== shape);
    if (!isNew) commit(); else render();
    return;
  }
  const changed = isNew || shape.text !== text;
  shape.text = text;
  if (isNew) shapes.push(shape);
  if (changed) commit(); else render();
}

// ---------------------------------------------------------------------------
// Crop
// ---------------------------------------------------------------------------

function applyCrop() {
  const r = state.pendingCrop && normalize(state.pendingCrop);
  if (!r || r.w < 4 || r.h < 4) {
    flash('Drag on the image to choose an area first');
    return;
  }
  state.doc.crop = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
  state.pendingCrop = null;
  commit();
  layout();
  setTool('select');
}

function cancelCrop() {
  state.pendingCrop = null;
  state.drag = null;
  render();
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportDataUrl() {
  commitText();
  const out = document.createElement('canvas');
  out.width = Math.round(state.doc.crop.w);
  out.height = Math.round(state.doc.crop.h);
  drawDocument(out.getContext('2d'), state.doc, { interactive: false });
  return out.toDataURL('image/png');
}

function copyImage() {
  api.send('editor:copy', exportDataUrl());
  flash('Copied to clipboard');
}

async function saveImage() {
  if (await api.invoke('editor:save-as', exportDataUrl())) flash('Saved');
}

function done() {
  if (state.pendingCrop) applyCrop();
  api.send('editor:done', isDirty() ? exportDataUrl() : null);
}

async function cancel() {
  if (isDirty() && !(await api.invoke('editor:confirm-discard'))) return;
  api.send('editor:cancel');
}

let toastTimer;
function flash(message) {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1400);
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();

  if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && key === 'y') { e.preventDefault(); redo(); return; }
  if (mod && key === 'c') { e.preventDefault(); copyImage(); return; }
  if (mod && key === 's') { e.preventDefault(); saveImage(); return; }
  if (mod && key === 'enter') { e.preventDefault(); done(); return; }
  if (mod) return;

  if (e.key === 'Enter') {
    if (state.tool === 'crop') applyCrop();
    else done();
    return;
  }
  if (e.key === 'Escape') {
    if (state.pendingCrop) { cancelCrop(); return; }
    if (state.selectedId) { state.selectedId = null; render(); return; }
    cancel();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId) {
    state.doc.shapes = state.doc.shapes.filter((s) => s.id !== state.selectedId);
    state.selectedId = null;
    commit();
    return;
  }
  if (['1', '2', '3'].includes(e.key)) { setSize(Number(e.key)); return; }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[e.key] && selectedShape()) {
    e.preventDefault();
    const step = px(e.shiftKey ? 10 : 1);
    moveShape(selectedShape(), arrows[e.key][0] * step, arrows[e.key][1] * step);
    commit();
    return;
  }
  if (TOOL_KEYS[key]) setTool(TOOL_KEYS[key]);
});

// Exposed for the automated UI smoke test.
window.__editorState = state;
