// gifenc ships as CommonJS: give it an `exports` object to fill in.
window.exports = {};
// Report any script error straight back, so a failed export never hangs.
window.addEventListener('error', (e) => window.pinshot.send('gif:error', e.message));
