'use strict';

// Text recognition for "Capture Text". macOS uses Apple's Vision framework
// (the engine behind Live Text) via JavaScript for Automation, so there are no
// native modules; everywhere else, or if Vision fails, a bundled offline
// Tesseract model is used.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VISION_SCRIPT = `
ObjC.import('Vision');
ObjC.import('Foundation');
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $.NSDictionary.dictionary);
  const req = $.VNRecognizeTextRequest.alloc.init;
  req.setRecognitionLevel(0); // accurate
  req.setUsesLanguageCorrection(true);
  try { req.setAutomaticallyDetectsLanguage(true); } catch (e) {}
  if (!handler.performRequestsError($.NSArray.arrayWithObject(req), null)) throw new Error('Vision request failed');
  const results = req.results;
  const out = [];
  for (let i = 0; i < results.count; i++) {
    const obs = results.objectAtIndex(i);
    const box = obs.boundingBox;
    out.push({ text: obs.topCandidates(1).firstObject.string.js, x: box.origin.x, y: box.origin.y, h: box.size.height });
  }
  return JSON.stringify(out);
}
`;

/**
 * Join recognised fragments into lines, top to bottom then left to right.
 * Vision boxes are normalised with the origin at the bottom-left.
 */
function joinFragments(fragments) {
  const sorted = [...fragments].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const f of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - f.y) < Math.min(line.h, f.h) * 0.5) line.parts.push(f);
    else lines.push({ y: f.y, h: f.h, parts: [f] });
  }
  return lines
    .map((l) => l.parts.sort((a, b) => a.x - b.x).map((p) => p.text).join(' '))
    .join('\n');
}

function visionOcr(pngPath) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', VISION_SCRIPT, pngPath], { timeout: 20000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(joinFragments(JSON.parse(stdout)));
      } catch (e) {
        reject(e);
      }
    });
  });
}

let tesseractWorker = null;
async function tesseractOcr(png) {
  if (!tesseractWorker) {
    const { createWorker } = require('tesseract.js');
    const eng = require('@tesseract.js-data/eng');
    tesseractWorker = createWorker('eng', 1, {
      langPath: path.join(path.dirname(require.resolve('@tesseract.js-data/eng')), '4.0.0_best_int'),
      gzip: eng.gzip,
      cacheMethod: 'none',
    });
  }
  const worker = await tesseractWorker;
  const { data } = await worker.recognize(png);
  return data.text
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
}

/**
 * Recognise the text in a screenshot. `image` is an Electron NativeImage;
 * `scale` its pixel density. Small captures are upscaled first, which helps
 * both engines with UI-sized text.
 */
async function recognizeText(image, scale = 1) {
  const { width, height } = image.getSize();
  const factor = scale < 2 || height < 400 ? 2 : 1;
  const prepared = factor > 1 ? image.resize({ width: width * factor, height: height * factor, quality: 'best' }) : image;
  const png = prepared.toPNG();

  if (process.platform === 'darwin' && !process.env.PINSHOT_FORCE_TESSERACT) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pinshot-ocr-')), 'capture.png');
    fs.writeFileSync(file, png);
    try {
      return await visionOcr(file);
    } catch (err) {
      console.warn('PinShot: Vision OCR failed, using Tesseract', err.message);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  }
  return tesseractOcr(png);
}

async function shutdownOcr() {
  if (tesseractWorker) {
    const worker = await tesseractWorker.catch(() => null);
    tesseractWorker = null;
    if (worker) await worker.terminate().catch(() => {});
  }
}

module.exports = { recognizeText, shutdownOcr, joinFragments };
