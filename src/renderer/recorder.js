'use strict';

// Records the screen (or a cropped area of it) with MediaRecorder and streams
// the encoded chunks to the main process, which writes them to disk.

const api = window.pinshot;
const video = document.getElementById('video');
const timeLabel = document.getElementById('time');
const dot = document.getElementById('dot');

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
let shownTime = '0:00';
let stopped = false;
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
  // The recorded area, in video pixels.
  const area = cfg.crop
    ? { x: Math.round(cfg.crop.x * k), y: Math.round(cfg.crop.y * k), width: even(cfg.crop.width * k), height: even(cfg.crop.height * k) }
    : { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight };
  // GIF recordings come with a maxWidth: no point recording more pixels than the GIF keeps.
  const fit = cfg.maxWidth && area.width > cfg.maxWidth ? cfg.maxWidth / area.width : 1;

  // The poster (thumbnail and history image) is always full resolution.
  // PNG-encode it off the UI thread.
  const poster = document.createElement('canvas');
  poster.width = area.width;
  poster.height = area.height;
  poster.getContext('2d').drawImage(video, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
  const posterPng = new Promise((resolve) => poster.toBlob(resolve, 'image/png')).then(async (blob) =>
    blob ? new Uint8Array(await blob.arrayBuffer()) : null,
  );

  let output;
  if (cfg.crop || fit < 1) {
    // Crop (and/or scale) each frame onto a canvas and record that.
    const canvas = document.createElement('canvas');
    canvas.width = even(area.width * fit);
    canvas.height = even(area.height * fit);
    const ctx = canvas.getContext('2d', { alpha: false });
    const draw = () => {
      ctx.drawImage(video, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height);
      video.requestVideoFrameCallback(draw);
    };
    draw();
    output = canvas.captureStream(cfg.fps);
  } else {
    output = new MediaStream(screen.getVideoTracks()); // audio is added below
    // The video element was only needed for the poster: stop it rendering the stream.
    video.pause();
    video.srcObject = null;
  }

  // Audio: system sound (from the screen stream) and/or the microphone.
  // MediaRecorder only records one audio track, so mix them when there are two.
  const audioTracks = [...screen.getAudioTracks()];
  if (cfg.mic) {
    try {
      // Raw-ish voice: echo cancellation and auto gain cost CPU and pump the level.
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, autoGainControl: false },
        video: false,
      });
      streams.push(mic);
      audioTracks.push(...mic.getAudioTracks());
    } catch (err) {
      console.warn('PinShot: microphone unavailable, recording without it', err);
    }
  }
  let mixer = null;
  if (audioTracks.length === 1) {
    output.addTrack(audioTracks[0]);
  } else if (audioTracks.length > 1) {
    mixer = new AudioContext();
    const mix = mixer.createMediaStreamDestination();
    for (const track of audioTracks) mixer.createMediaStreamSource(new MediaStream([track])).connect(mix);
    output.addTrack(mix.stream.getAudioTracks()[0]);
  }

  const hasAudio = output.getAudioTracks().length > 0;
  const candidates = hasAudio
    ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/webm;codecs=vp9,opus', ...MIME_TYPES]
    : MIME_TYPES;
  const mimeType = candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  recorder = new MediaRecorder(output, {
    mimeType,
    videoBitsPerSecond: Math.round(12_000_000 * fit * fit), // same quality per pixel when scaled down
    videoKeyFrameIntervalDuration: 1000, // keyframe every second: cheap seeking for GIF export
  });
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    sending = sending.then(async () => api.send('rec:chunk', new Uint8Array(await e.data.arrayBuffer())));
  };
  recorder.onstop = async () => {
    await sending;
    for (const s of streams) for (const t of s.getTracks()) t.stop();
    if (mixer) mixer.close();
    api.send(discarding ? 'rec:cancel' : 'rec:stopped');
  };
  recorder.onerror = (e) => fail(e.error || 'Recorder error');

  const posterBytes = await posterPng;
  if (stopped) {
    // Stopped or discarded while the poster was encoding (stop() already cancelled).
    for (const s of streams) for (const t of s.getTracks()) t.stop();
    if (mixer) mixer.close();
    return;
  }
  api.send('rec:started', {
    mimeType: recorder.mimeType || mimeType || 'video/webm',
    poster: posterBytes,
    scale: k,
  });
  recorder.start(1000); // hand a chunk to the main process every second
  startedAt = Date.now();
  document.body.classList.remove('starting');
  timer = setTimeout(tick, 1000);
}

/** Once a second, on the second: update the time and blink the dot. */
function tick() {
  const elapsed = Date.now() - startedAt;
  const s = Math.floor(elapsed / 1000);
  const text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (text !== shownTime) timeLabel.textContent = shownTime = text;
  dot.classList.toggle('dim', s % 2 === 1);
  timer = setTimeout(tick, 1000 - (elapsed % 1000));
}

function stop(discard = false) {
  stopped = true;
  discarding = discard;
  clearTimeout(timer);
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  else api.send('rec:cancel');
}

start().catch(fail);
