'use strict';

// A stand-in for "some other app" in the UI tests: opens windows with given
// HTML at given bounds, and runs JS in them on request. Talks JSON lines over
// stdin/stdout so the test can drive it.

const { app, BrowserWindow } = require('electron');
const readline = require('readline');

const wins = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handle(msg) {
  switch (msg.cmd) {
    case 'open': {
      const w = new BrowserWindow({ ...msg.bounds, frame: false, title: msg.name, show: true });
      wins.set(msg.name, w);
      await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<title>${msg.name}</title>${msg.html}`)}`);
      await sleep(400);
      return w.getBounds();
    }
    case 'eval':
      return wins.get(msg.name).webContents.executeJavaScript(msg.js);
    case 'close':
      wins.get(msg.name)?.destroy();
      wins.delete(msg.name);
      return true;
    default:
      throw new Error(`Unknown command ${msg.cmd}`);
  }
}

app.whenReady().then(() => {
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    const msg = JSON.parse(line);
    let reply;
    try {
      reply = { id: msg.id, result: await handle(msg) };
    } catch (err) {
      reply = { id: msg.id, error: err.message };
    }
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
  process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
});
app.on('window-all-closed', () => {});
