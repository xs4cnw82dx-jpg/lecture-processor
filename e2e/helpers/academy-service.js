const { test: base, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { createServer } = require('node:net');
const { once } = require('node:events');

const test = base.extend({
  academyOrigin: [async ({}, use) => {
    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const origin = 'http://127.0.0.1:' + port;
    const python = existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3';
    const child = spawn(python, ['scripts/run_ui_preview.py', '--academy-memory', '--port', String(port)], {stdio:'ignore'});
    try {
      await expect.poll(async () => { try { return (await fetch(origin + '/healthz')).status; } catch (_) { return 0; } }).toBe(200);
      await use(origin);
    } finally { child.kill('SIGTERM'); }
  }, {scope:'worker'}],
  academyPage: async ({page, academyOrigin}, use) => {
    await page.route('**/*', route => new URL(route.request().url()).origin === academyOrigin ? route.continue() : route.abort());
    await page.addInitScript(() => {
      let app;
      const user = {uid:'studio-owner', email:'studio@example.test', emailVerified:true, getIdToken:async ()=>'academy-preview-token'};
      const auth = {currentUser:user, onAuthStateChanged(cb) { queueMicrotask(()=>cb(this.currentUser)); return ()=>{}; }};
      window.firebase = {app() { if(!app) throw Error('Not initialized'); return app; }, initializeApp(options) { app = {options}; return app; }, auth:()=>auth};
    });
    await use(page);
  }
});
module.exports = { test, expect };
