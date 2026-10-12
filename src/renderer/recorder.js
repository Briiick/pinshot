'use strict';

// Records the screen (or a cropped area of it) with MediaRecorder and streams
// the encoded chunks to the main process, which writes them to disk.

const api = window.pinshot;
const video = document.getElementById('video');
const timeLabel = document.getElementById('time');

// Best first: MP4/H.264 plays everywhere; WebM is the fallback.
const MIME_TYPES = [
  'video/mp4;codecs=avc1.640033',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

let recorder = null;
let streams = [];
let startedAt = 0;
let timer = 0;
let discarding = false;
let sending = Promise.resolve(); // keeps chunks in order

document.body.classList.add('starting');
document.getElementById('stop').addEventListener('click', () => stop());
document.getElementById('discard').addEventListener('click', () => stop(true));
api.on('rec:stop', () => stop());

const even = (n) => Math.max(2, Math.round(n / 2) * 2); // H.264 needs even sizes

function fail(err) {
  console.error(err);
  api.send('rec:error', String(err && err.message ? err.message : err));
}

async function start() {
  const cfg = await api.invoke('rec:init');
  if (!cfg) return;

  let screen;
  try {
    screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: cfg.fps }, audio: !!cfg.systemAudio });
  } catch (err) {
    if (!cfg.systemAudio) throw err;
    // System audio isn't available here (e.g. older macOS): record without it.
    console.warn('PinShot: system audio unavailable', err);
    screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: cfg.fps }, audio: false });
  }
  streams.push(screen);
  video.srcObject = screen;
  await video.play();
  // Pixels per point of the captured display.
  const k = video.videoWidth / cfg.display.width;

  let output;
  let posterSource;
  if (cfg.crop) {
    // Crop each frame onto a canvas and record that.
    const sx = Math.round(cfg.crop.x * k);
    const sy = Math.round(cfg.crop.y * k);
    const sw = even(cfg.crop.width * k);
    const sh = even(cfg.crop.height * k);
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d', { alpha: false });
    const draw = () => {
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
      video.requestVideoFrameCallback(draw);
    };
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    video.requestVideoFrameCallback(draw);
    output = canvas.captureStream(cfg.fps);
    posterSource = canvas;
  } else {
    output = new MediaStream(screen.getVideoTracks()); // audio is added below
    posterSource = document.createElement('canvas');
    posterSource.width = video.videoWidth;
    posterSource.height = video.videoHeight;
    posterSource.getContext('2d').drawImage(video, 0, 0);
  }

  // Audio: system sound (from the screen stream) and/or the microphone.
  // MediaRecorder only records one audio track, so mix them when there are two.
  const audioTracks = [...screen.getAudioTracks()];
  if (cfg.mic) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streams.push(mic);
      audioTracks.push(...mic.getAudioTracks());
    } catch (err) {
      console.warn('PinShot: microphone unavailable, recording without it', err);
    }
  }
  if (audioTracks.length === 1) {
    output.addTrack(audioTracks[0]);
  } else if (audioTracks.length > 1) {
    const ctx = new AudioContext();
    const mix = ctx.createMediaStreamDestination();
    for (const track of audioTracks) ctx.createMediaStreamSource(new MediaStream([track])).connect(mix);
    output.addTrack(mix.stream.getAudioTracks()[0]);
  }

  const hasAudio = output.getAudioTracks().length > 0;
  const candidates = hasAudio
    ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/webm;codecs=vp9,opus', ...MIME_TYPES]
    : MIME_TYPES;
  const mimeType = candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  recorder = new MediaRecorder(output, { mimeType, videoBitsPerSecond: 12_000_000 });
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    sending = sending.then(async () => api.send('rec:chunk', new Uint8Array(await e.data.arrayBuffer())));
  };
  recorder.onstop = async () => {
    await sending;
    for (const s of streams) for (const t of s.getTracks()) t.stop();
    api.send(discarding ? 'rec:cancel' : 'rec:stopped');
  };
  recorder.onerror = (e) => fail(e.error || 'Recorder error');

  api.send('rec:started', {
    mimeType: recorder.mimeType || mimeType || 'video/webm',
    poster: posterSource.toDataURL('image/png'),
    scale: k,
  });
  recorder.start(1000); // hand a chunk to the main process every second
  startedAt = Date.now();
  document.body.classList.remove('starting');
  timer = setInterval(tick, 250);
}

function tick() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  timeLabel.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function stop(discard = false) {
  discarding = discard;
  clearInterval(timer);
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  else api.send('rec:cancel');
}

start().catch(fail);
