'use strict';

// Turns a recording into an animated GIF: steps through the video at the
// target frame rate, quantises each frame to a 256-colour palette and encodes
// it with gifenc. Runs in a hidden window; the main process writes the file.

const api = window.pinshot;
// gifenc's file also declares its functions globally, so use them via its exports object.
const gifenc = window.exports;

const once = (target, event, ms = 10000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), ms);
    target.addEventListener(event, () => (clearTimeout(timer), resolve()), { once: true });
    target.addEventListener('error', () => (clearTimeout(timer), reject(new Error('Could not read the video'))), { once: true });
  });

async function convert() {
  const job = await api.invoke('gif:init');
  if (!job) return;
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = job.src;
  await once(video, 'loadedmetadata');
  // MediaRecorder files may not know their length until we seek to the end.
  if (!Number.isFinite(video.duration)) {
    video.currentTime = 1e9;
    await once(video, 'timeupdate');
  }
  const duration = video.duration;
  const k = Math.min(1, job.maxWidth / video.videoWidth);
  const width = Math.max(2, Math.round(video.videoWidth * k));
  const height = Math.max(2, Math.round(video.videoHeight * k));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const gif = gifenc.GIFEncoder();
  const step = 1 / job.fps;
  const delay = Math.round(1000 / job.fps);
  const frames = Math.max(1, Math.ceil(duration / step));
  for (let i = 0; i < frames; i++) {
    video.currentTime = Math.min(i * step, Math.max(0, duration - 0.001));
    await once(video, 'seeked');
    ctx.drawImage(video, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    const palette = gifenc.quantize(data, 256);
    gif.writeFrame(gifenc.applyPalette(data, palette), width, height, { palette, delay });
    if (i % 4 === 0) api.send('gif:progress', (i + 1) / frames);
  }
  gif.finish();
  api.send('gif:done', gif.bytes());
}

convert().catch((err) => api.send('gif:error', String(err && err.message ? err.message : err)));
