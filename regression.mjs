import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = { runtime: process.version, suites: {} };

async function launch(dir) {
  const child = fork(path.join(dir, 'server.js'), [], {
    cwd: dir, execPath: process.execPath,
    execArgv: ['--require', path.join(here, 'localhost-preload.cjs')],
    env: { PATH: '/usr/bin:/bin', PORT: '0', NODE_ENV: 'test',
      OPENAI_API_KEY: 'local-test-not-a-real-key', INTERNAL_API_KEY: 'local-test-only' },
    silent: true
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdout.resume();
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Startup timed out')), 5000);
    child.once('message', message => { clearTimeout(timer); resolve(message.port); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Startup exit ' + code + ': ' + stderr)); });
  });
  return { child, port, stderr: () => stderr };
}

async function stop(server) {
  if (server.child.exitCode === null) server.child.kill('SIGTERM');
  await delay(50);
}

function request(port, method, pathname, body = Buffer.alloc(0), headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname,
      agent: false, headers: { 'Content-Length': body.length, ...headers } }, res => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', part => { data += part; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('Request timed out')));
    req.end(body);
  });
}

for (const label of ['baseline', 'candidate']) {
  const dir = path.resolve(here, '..', label);
  const require = createRequire(path.join(dir, 'package.json'));
  const suite = results.suites[label] = { checks: [] };
  const check = (name, fn) => {
    try { fn(); suite.checks.push({ name, pass: true }); }
    catch (e) { suite.checks.push({ name, pass: false, detail: e.message }); }
  };
  const express = require('express');
  const app = express();
  check('default proxy trust is false', () => assert.equal(app.get('trust proxy'), false));
  check('default query parser is simple', () => assert.equal(app.get('query parser'), 'simple'));
  check('configured 50mb limit is valid', () => assert.equal(require('bytes').parse('50mb'), 50 * 1024 * 1024));
  check('invalid parser limit rejected', () => assert.throws(() => express.json({ limit: 'not-a-size' })));
  const proxyaddr = require('proxy-addr');
  check('mapped short IPv6 subnet does not trust unrelated IPv4', () => {
    assert.equal(proxyaddr.compile('::ffff:10.0.0.0/8')('192.0.2.123'), false);
  });
  const qs = require('qs');
  check('qs comma null stringify does not throw', () => {
    assert.doesNotThrow(() => qs.stringify({ a: [null, 'b'] }, { arrayFormat: 'comma', encodeValuesOnly: true }));
  });
  check('qs constructor isBuffer stringify does not throw', () => {
    const input = qs.parse('a[constructor][isBuffer]=x', { plainObjects: true });
    assert.doesNotThrow(() => qs.stringify(input));
  });
  const match = require('path-to-regexp').match;
  check('literal application routes retain matching', () => {
    assert.ok(match('/')('/'));
    assert.ok(match('/analyze-plan')('/analyze-plan'));
    assert.equal(match('/analyze-plan')('/not-a-route'), false);
  });

  const server = await launch(dir);
  try {
    const health = await request(server.port, 'GET', '/');
    check('actual app health', () => { assert.equal(health.status, 200); assert.match(health.body, /is alive/); });
    const jsonHeaders = { 'Content-Type': 'application/json' };
    const unauth = await request(server.port, 'POST', '/analyze-plan', Buffer.from('{}'), jsonHeaders);
    check('actual app rejects unauthenticated request', () => assert.equal(unauth.status, 401));
    const auth = { ...jsonHeaders, 'x-internal-key': 'local-test-only' };
    const missing = await request(server.port, 'POST', '/analyze-plan', Buffer.from('{}'), auth);
    check('actual app validates missing URL without model call', () => {
      assert.equal(missing.status, 400); assert.match(missing.body, /Missing file\/image URL/);
    });
    for (const [encoding, compress] of [['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync], ['br', zlib.brotliCompressSync]]) {
      const response = await request(server.port, 'POST', '/analyze-plan', compress(Buffer.from('{}')), { ...auth, 'Content-Encoding': encoding });
      check('actual app accepts valid ' + encoding + ' JSON', () => {
        assert.equal(response.status, 400); assert.match(response.body, /Missing file\/image URL/);
      });
    }
    const malformed = await request(server.port, 'POST', '/analyze-plan', Buffer.from('{'), jsonHeaders);
    check('actual app malformed JSON returns 400', () => assert.equal(malformed.status, 400));
    const unknown = await request(server.port, 'GET', '/missing');
    check('actual app unmatched route returns 404', () => assert.equal(unknown.status, 404));
  } finally { await stop(server); }

  // Bounded local reproduction based on the maintainer's compressed-body regression.
  // Run separately so the vulnerable baseline can exit without affecting other tests.
  const vulnerable = await launch(dir);
  try {
    const body = Buffer.concat([zlib.gzipSync(Buffer.from('{}')), Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)]);
    let response;
    try { response = await request(vulnerable.port, 'POST', '/analyze-plan', body,
      { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }); }
    catch (e) { suite.compressedRequestError = e.message; }
    await delay(300);
    suite.compressedResponseStatus = response?.status ?? null;
    suite.compressedProcessExit = vulnerable.child.exitCode;
    suite.compressedError = vulnerable.stderr().match(/Error[^\n]*|Z_DATA_ERROR|uncaughtException/g) || [];
    check('actual app survives unauthenticated trailing compressed bytes', () => assert.equal(vulnerable.child.exitCode, null));
    if (vulnerable.child.exitCode === null) {
      const alive = await request(vulnerable.port, 'GET', '/');
      check('actual app health after compressed regression', () => assert.equal(alive.status, 200));
    }
  } finally { await stop(vulnerable); }
}
fs.writeFileSync(path.resolve(here, '../evidence/regression-results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
if (results.suites.candidate.checks.some(check => !check.pass)) process.exitCode = 1;
