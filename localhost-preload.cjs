// Test-only isolation. Never load in production.
const http = require('node:http');
const https = require('node:https');
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function () {
  this.once('listening', () => process.send?.({ port: this.address().port }));
  return originalListen.call(this, 0, '127.0.0.1');
};
function blockOutbound() { throw new Error('External network disabled in isolated test'); }
https.request = blockOutbound;
https.get = blockOutbound;
globalThis.fetch = blockOutbound;
