'use strict';

window.pinshot.on('hud:message', ({ message, busy }) => {
  document.getElementById('message').textContent = message;
  document.getElementById('spinner').hidden = !busy;
});
