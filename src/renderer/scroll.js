'use strict';

// Scrolling capture: watches the selected area while the user scrolls and
// stitches the frames into one tall image (see stitch.js).

const api = window.pinshot;
const video = document.getElementById('video');
const status = document.getElementById('status');

let stream = null;
let stitcher = null;
let scale = 1;
let finished = false;

function fail(err) {
  console.error(err);
  api.send('scroll:error', String(err && err.message ? err.message : err));
}

async function start() {
  const cfg = await api.invoke('scroll:init');
  if (!cfg) return;
  stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: cfg.fps }, audio: false });
  video.srcObject = stream;
  await video.play();
  scale = video.videoWidth / cfg.display.width;
  const sx = Math.round(cfg.crop.x * scale);
  const sy = Math.round(cfg.crop.y * scale);
  const sw = Math.round(cfg.crop.width * scale);
  const sh = Math.round(cfg.crop.height * scale);
  const { Stitcher, signatures, SAMPLES } = window.PinShotStitch;
  stitcher = new Stitcher({ maxHeight: 30000 }); // canvas height limit is 32767

  // Row signatures come from the area squeezed to SAMPLES columns: the GPU does
  // the scaling and only that thin strip is read back. Full-resolution pixels
  // are read only for rows the stitcher keeps. (Explicitly GPU-backed canvases:
  // both draw straight from the video frame.)
  const sigCanvas = document.createElement('canvas');
  sigCanvas.width = SAMPLES;
  sigCanvas.height = sh;
  const sigCtx = sigCanvas.getContext('2d', { willReadFrequently: false });
  sigCtx.imageSmoothingQuality = 'low'; // plain bilinear: rows stay independent
  const rowCanvas = document.createElement('canvas');
  rowCanvas.width = sw;
  rowCanvas.height = sh;
  const rowCtx = rowCanvas.getContext('2d', { willReadFrequently: false });
  const rows = (y, count) => {
    rowCtx.drawImage(video, sx, sy + y, sw, count, 0, 0, sw, count);
    return rowCtx.getImageData(0, 0, sw, count).data;
  };
  let sig = null;
  let shown = '';
  let lost = false;

  const onFrame = () => {
    if (finished) return;
    if (!stitcher.full) {
      sigCtx.drawImage(video, sx, sy, sw, sh, 0, 0, SAMPLES, sh);
      sig = signatures(sigCtx.getImageData(0, 0, SAMPLES, sh), sig);
      const r = stitcher.addSignatures(sig, sw, sh, rows);
      // Only touch the DOM when something visible changed.
      if (shown === '') document.body.classList.remove('starting'); // first frame
      if (!!r.lost !== lost) document.body.classList.toggle('lost', (lost = !!r.lost));
      const text = r.lost ? 'Too fast — scroll back a little' : `${Math.round(r.height / scale).toLocaleString()} px · keep scrolling`;
      if (text !== shown) status.textContent = shown = text;
    }
    if (stitcher.full) {
      // Nothing more fits: stop capturing and wait for Done.
      status.textContent = shown = 'Maximum height reached';
      document.body.classList.remove('lost');
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
  document.body.dataset.ready = '1';
}

async function finish() {
  if (finished) return;
  finished = true;
  for (const t of stream ? stream.getTracks() : []) t.stop();
  if (!stitcher || !stitcher.height) return api.send('scroll:cancel');
  status.textContent = 'Saving…';
  const img = stitcher.result();
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  api.send('scroll:done', { png: new Uint8Array(await blob.arrayBuffer()), scale });
}

function cancel() {
  finished = true;
  for (const t of stream ? stream.getTracks() : []) t.stop();
  api.send('scroll:cancel');
}

document.getElementById('stop').addEventListener('click', finish);
document.getElementById('discard').addEventListener('click', cancel);
api.on('scroll:finish', finish);
start().catch(fail);
