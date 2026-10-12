// Shared helpers for the UI tests (run under xvfb-run on Linux).
import { _electron as electron } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const step = (name) => {
  lastStep = name;
  console.log(`- ${name}`);
};
let lastStep = '(start)';

/** Fail loudly (instead of hanging CI) if a test runs far longer than it should. */
export function watchdog(minutes, diagnose) {
  setTimeout(async () => {
    console.error(`FAILED: test hung for ${minutes} minutes during "${lastStep}"`);
    if (diagnose) await Promise.race([diagnose().catch((e) => console.error('diagnose failed', e.message)), sleep(10000)]);
    process.exit(1);
  }, minutes * 60_000).unref();
}
const electronPath = createRequire(import.meta.url)('electron');

/** Launch PinShot with a throwaway home folder. */
export async function launchPinShot(extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pinshot-home-'));
  const app = await electron.launch({
    args: [root, '--no-sandbox'],
    env: {
      ...process.env,
      PINSHOT_TEST: '1',
      HOME: home,
      // Settings and Capture History live here: a fresh one per run, even where the CI runner sets its own.
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_PICTURES_DIR: path.join(home, 'Pictures'),
      ...extraEnv,
    },
  });
  if (process.env.PINSHOT_LOG) {
    // Keep the app's own output (crashes, console errors) for debugging.
    const log = fs.createWriteStream(process.env.PINSHOT_LOG, { flags: 'a' });
    app.process().stdout?.pipe(log);
    app.process().stderr?.pipe(log);
    app.process().on('exit', (code, signal) => log.write(`\n[pinshot exited code=${code} signal=${signal}]\n`));
  }
  return { app, home, pictures: path.join(home, 'Pictures', 'PinShot') };
}

/** Find one of PinShot's windows by title (waits for it). */
export async function waitForTitle(app, title, { timeout = 10000, not = [] } = {}) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    for (const w of app.windows()) {
      if (w.isClosed() || not.includes(w)) continue;
      const t = await Promise.race([w.title().catch(() => ''), sleep(500).then(() => '')]);
      if (t === title) return w;
    }
    await sleep(100);
  }
  throw new Error(`No window titled "${title}"`);
}

export async function windowsTitled(app, title) {
  const out = [];
  for (const w of app.windows()) if (!w.isClosed() && (await w.title().catch(() => '')) === title) out.push(w);
  return out;
}

/**
 * Press a key that makes its own window disappear (Esc, Enter…). It's fired
 * inside the page rather than as real input: real input to a window that hides
 * itself is never acknowledged, which can stall later commands to it.
 */
export const closingKey = (page, key) =>
  page
    .evaluate((k) => {
      for (const type of ['keydown', 'keyup']) window.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true }));
    }, key)
    .catch(() => {});

/**
 * Real X pointer input (xdotool), in global screen coordinates. Selections
 * are driven this way rather than through Playwright, because the release
 * that finishes a selection hides the selector, and synthetic input to a
 * window that hides itself is never acknowledged.
 */
export const xdo = (...args) => execFileSync('xdotool', args.map(String)).toString();
export async function xmove(x, y, { steps = 1 } = {}) {
  const loc = /x:(-?\d+) y:(-?\d+)/.exec(xdo('getmouselocation'));
  const [x0, y0] = loc ? [Number(loc[1]), Number(loc[2])] : [x, y];
  for (let i = 1; i <= steps; i++) {
    xdo('mousemove', Math.round(x0 + ((x - x0) * i) / steps), Math.round(y0 + ((y - y0) * i) / steps));
    await sleep(steps > 1 ? 16 : 30);
  }
}
export const xdown = async () => (xdo('mousedown', 1), sleep(30));
export const xup = async () => (xdo('mouseup', 1), sleep(30));
export async function xdrag(from, to, { steps = 6 } = {}) {
  await xmove(...from);
  await xdown();
  await xmove(...to, { steps });
  await xup();
}
export async function xclick(x, y) {
  await xmove(x, y);
  xdo('click', 1);
  await sleep(30);
}

/** Poll until fn() returns something truthy. */
export async function until(fn, { timeout = 10000, every = 100, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(every);
  }
}

export const captureState = (app) =>
  app.evaluate(() =>
    [...globalThis.pinshotTest.captures.values()].map((c) => ({
      id: c.id,
      kind: c.kind,
      size: c.image.getSize(),
      scale: c.scale,
      filePath: c.filePath,
      busy: c.busy || null,
      thumb: c.thumb && !c.thumb.isDestroyed() ? c.thumb.getBounds() : null,
      pin: c.pin && !c.pin.isDestroyed() ? c.pin.getBounds() : null,
    })),
  );

/** Read pixels out of a capture's image in the main process: [[r,g,b,a], …] at pixel coords. */
export const capturePixels = (app, id, points) =>
  app.evaluate(
    ({ nativeImage }, { id, points }) => {
      const c = globalThis.pinshotTest.captures.get(id);
      const { width } = c.image.getSize();
      const bmp = c.image.toBitmap();
      const red = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
      ).toBitmap();
      const bgra = red[2] === 255;
      return points.map(([x, y]) => {
        const i = (y * width + x) * 4;
        return bgra ? [bmp[i + 2], bmp[i + 1], bmp[i], bmp[i + 3]] : [bmp[i], bmp[i + 1], bmp[i + 2], bmp[i + 3]];
      });
    },
    { id, points },
  );

/** Screenshot of the whole (virtual) desktop, including PinShot's floating windows. */
export async function snapDesktop(app, dir, name) {
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const b64 = await app.evaluate(async ({ desktopCapturer, screen }) => {
    const { width, height } = screen.getPrimaryDisplay().size;
    const [s] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    return s.thumbnail.toPNG().toString('base64');
  });
  fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(b64, 'base64'));
}

/** Replace a native dialog in PinShot's main process (dialogs can't be clicked in tests). */
export const stubDialog = (app, method, result) =>
  app.evaluate(({ dialog }, { method, result }) => {
    dialog[method] = async () => result;
  }, { method, result });

/** A separate "other app" process with windows the tests can capture, scroll and read. */
export class Fixture {
  static async start() {
    const f = new Fixture();
    f.proc = spawn(electronPath, [path.join(root, 'test', 'fixture'), '--no-sandbox'], { stdio: ['pipe', 'pipe', 'ignore'] });
    f.pending = new Map();
    f.nextId = 1;
    const ready = new Promise((resolve) => (f.onReady = resolve));
    readline.createInterface({ input: f.proc.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.ready) return f.onReady();
      const p = f.pending.get(msg.id);
      if (!p) return;
      f.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    });
    await ready;
    return f;
  }

  call(cmd, args = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
  }

  open(name, bounds, html) {
    return this.call('open', { name, bounds, html });
  }

  eval(name, js) {
    return this.call('eval', { name, js });
  }

  stop() {
    this.proc.kill();
  }
}

/** A colourful "document" page used as the thing being captured. */
export const REPORT_HTML = `<body style="margin:0;font:28px sans-serif;background:linear-gradient(135deg,#4f46e5,#06b6d4)">
<div style="position:absolute;left:300px;top:200px;width:560px;height:340px;background:#fff;border-radius:14px;padding:28px;box-shadow:0 20px 50px #0005">
<h2 style="margin:0 0 12px">Quarterly report</h2>
<p style="font-size:18px;color:#444">Revenue up 24%. Customer email: jane@example.com</p>
<div style="display:flex;gap:12px;margin-top:30px">${[60, 120, 90, 160, 140]
  .map((h) => `<div style="width:60px;height:${h}px;background:#6366f1;align-self:flex-end"></div>`)
  .join('')}</div></div></body>`;
