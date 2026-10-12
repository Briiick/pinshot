'use strict';

// Turns a recording into an animated GIF: plays the video back faster than
// real time, grabs the frame showing at each tick of the target frame rate,
// maps it to a 256-colour palette and encodes it with gifenc. Runs in a hidden
// window; the main process writes the file.

const api = window.pinshot;
// gifenc's file also declares its functions globally, so use them via its exports object.
const gifenc = window.exports;

const PLAYBACK_RATE = 4; // halved (down to 1×) if playback keeps missing frames
const STALL_MS = 3000; // no new frame for this long: seek for the rest instead
const PALETTE_SAMPLES = 6; // frames the shared palette is built from
const NEW_COLOURS = 0.01; // share of pixels in colours the samples lacked that earns a frame its own palette

const once = (target, event, ms = 10000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), ms);
    target.addEventListener(event, () => (clearTimeout(timer), resolve()), { once: true });
    target.addEventListener('error', () => (clearTimeout(timer), reject(new Error('Could not read the video'))), { once: true });
  });

/** A pixel's colour at 4 bits per channel. */
const colourKey = (data, i) => ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);

async function convert() {
  const job = await api.invoke('gif:init');
  if (!job) return;
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  // In the document like any playing video, so frame callbacks fire.
  video.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.appendChild(video);
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
  // GPU-backed: drawn for every frame shown while playing, read back only for the frames used.
  const surface = () => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas.getContext('2d', { willReadFrequently: false });
  };
  let held = surface(); // the video frame GIF frames are being taken from
  let incoming = surface();
  const grab = (ctx = held) => ctx.drawImage(video, 0, 0, width, height);
  const pixels = () => held.getImageData(0, 0, width, height).data;
  const seek = async (t) => {
    video.currentTime = t;
    await once(video, 'seeked');
  };

  const step = 1 / job.fps;
  const delay = Math.round(1000 / job.fps);
  const frames = Math.max(1, Math.ceil(duration / step));
  // GIF frame i shows the video at this time.
  const timeOf = (i) => Math.min(i * step, Math.max(0, duration - 0.001));

  // One palette for the whole GIF, from frames spread across it (quantizing
  // every frame is the slow part). A frame with many colours those samples
  // lacked gets its own palette.
  const samples = Math.min(PALETTE_SAMPLES, frames);
  const frameBytes = width * height * 4;
  const sampled = new Uint8ClampedArray(frameBytes * samples);
  for (let j = 0; j < samples; j++) {
    await seek(timeOf(Math.round((j * (frames - 1)) / Math.max(1, samples - 1))));
    grab();
    sampled.set(pixels(), j * frameBytes);
  }
  const palette = gifenc.quantize(sampled, 256);
  const seen = new Uint8Array(4096);
  for (let i = 0; i < sampled.length; i += 4) seen[colourKey(sampled, i)] = 1;

  // Each GIF frame is encoded on its own, so they can be made out of order
  // and joined at the end.
  const encoder = gifenc.GIFEncoder({ auto: false });
  const encode = (i, data) => {
    let local = null;
    if (i > 0) {
      let unseen = 0;
      for (let p = 0; p < data.length; p += 4) unseen += 1 - seen[colourKey(data, p)];
      if (unseen > (data.length / 4) * NEW_COLOURS) local = gifenc.quantize(data, 256);
    }
    encoder.reset();
    // The first frame carries the GIF's global palette.
    const opts = i === 0 ? { first: true, palette, delay } : { palette: local, delay };
    encoder.writeFrame(gifenc.applyPalette(data, local || palette), width, height, opts);
    return encoder.bytes();
  };
  const chunks = new Array(frames).fill(null);
  let made = 0;
  let reported = -1;
  const done = (i, chunk) => {
    chunks[i] = chunk;
    made++;
    const percent = Math.floor((made / frames) * 100);
    if (percent !== reported) {
      reported = percent;
      api.send('gif:progress', made / frames);
    }
  };

  // Seeking to each GIF frame's time is exact, but every seek can decode from
  // a distant keyframe. So play the video instead (muted, faster than real
  // time), holding on to the latest frame shown: each GIF frame gets the last
  // video frame at or before its time, just as seeking there would show. GIF
  // frames whose video frame may have gone by unseen are seeked afterwards.
  await seek(0);
  grab();
  if ('requestVideoFrameCallback' in video) {
    let heldData = null; // pixels and encoding of the held frame, once needed
    let heldChunk = null;
    const take = (i) => {
      heldData = heldData || pixels();
      if (i === 0) return done(i, encode(i, heldData));
      heldChunk = heldChunk || encode(i, heldData);
      done(i, heldChunk); // a repeated frame reuses its encoding
    };
    await new Promise((resolve, reject) => {
      let next = 0; // the next GIF frame to place
      let shownAt = 0; // media time of the held frame (here: of the seek that showed it)
      let presented = -1; // presentedFrames at the last callback
      let dropped = video.getVideoPlaybackQuality().droppedVideoFrames;
      let misses = 0; // since the last slow-down
      let since = 0;
      let handle = 0;
      let watchdog = 0;
      const stop = () => {
        clearTimeout(watchdog);
        video.cancelVideoFrameCallback(handle);
        video.removeEventListener('ended', finish);
        video.removeEventListener('error', onError);
        video.pause();
      };
      const finish = () => (stop(), resolve()); // anything not placed yet is seeked
      const fail = (err) => (stop(), reject(err));
      const kick = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(finish, STALL_MS);
      };
      const onFrame = (_now, { mediaTime, presentedFrames }) => {
        try {
          if (mediaTime > shownAt) {
            grab(incoming); // first, before the video moves on
            while (next < frames && timeOf(next) <= shownAt) take(next++);
            // Frames shown between callbacks, or dropped, went by unseen: one of
            // them may belong to the GIF frames up to this one.
            const { droppedVideoFrames } = video.getVideoPlaybackQuality();
            const unseen = presented < 0 || presentedFrames - presented > 1 || droppedVideoFrames > dropped;
            dropped = droppedVideoFrames;
            if (unseen && next < frames && timeOf(next) < mediaTime) {
              while (next < frames && timeOf(next) < mediaTime) next++; // left for seeking
              // Missing more than the odd frame: playback isn't keeping up, slow down.
              if (++misses >= 8 && misses > (next - since) / 2 && video.playbackRate > 1) {
                video.playbackRate /= 2;
                misses = 0;
                since = next;
              }
            }
            while (next < frames && timeOf(next) < mediaTime) take(next++);
            [held, incoming] = [incoming, held];
            heldData = heldChunk = null;
            shownAt = mediaTime;
            kick();
          }
          presented = presentedFrames;
          if (next >= frames) return finish();
          handle = video.requestVideoFrameCallback(onFrame);
        } catch (err) {
          fail(err);
        }
      };
      const onError = () => fail(new Error('Could not read the video'));
      video.addEventListener('ended', finish);
      video.addEventListener('error', onError);
      handle = video.requestVideoFrameCallback(onFrame);
      video.playbackRate = PLAYBACK_RATE;
      kick();
      video.play().catch(finish);
    });
  }
  // Whatever playback missed (or couldn't do).
  for (let i = 0; i < frames; i++) {
    if (chunks[i]) continue;
    await seek(timeOf(i));
    grab();
    done(i, encode(i, pixels()));
  }

  const head = gifenc.GIFEncoder({ auto: false });
  head.writeHeader();
  const header = head.bytes();
  head.reset();
  head.finish();
  const trailer = head.bytes();
  const gif = new Uint8Array(header.length + chunks.reduce((n, c) => n + c.length, 0) + trailer.length);
  let offset = 0;
  for (const part of [header, ...chunks, trailer]) {
    gif.set(part, offset);
    offset += part.length;
  }
  api.send('gif:done', gif);
}

convert().catch((err) => api.send('gif:error', String(err && err.message ? err.message : err)));
