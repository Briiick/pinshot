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
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  stitcher = new window.PinShotStitch.Stitcher({ maxHeight: 30000 }); // canvas height limit is 32767

  const onFrame = () => {
    if (finished) return;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    const r = stitcher.add(ctx.getImageData(0, 0, sw, sh));
    document.body.classList.remove('starting');
    if (r.full) status.textContent = 'Maximum height reached';
    else if (r.lost) status.textContent = 'Too fast — scroll back a little';
    else status.textContent = `${Math.round(r.height / scale).toLocaleString()} px · keep scrolling`;
    document.body.classList.toggle('lost', !!r.lost);
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
