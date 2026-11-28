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
    const child = spawn(python, ['scripts/run_ui_preview.py', '--academy', '--port', String(port)], { stdio: ['ignore','ignore','pipe'] });
    let diagnostics = '';
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-1800); });
    try {
      await expect.poll(async () => {
        if (child.exitCode !== null) throw new Error(diagnostics);
        try { return (await fetch(origin + '/healthz')).status; } catch (_) { return 0; }
      }, { timeout: 20000 }).toBe(200);
      await use(origin);
    } finally {
      if (child.exitCode === null && !child.signalCode) {
        const stop = once(child,'exit');
        child.kill('SIGTERM');
        await stop;
      }
    }
  }, { scope: 'worker' }],
});

async function prepareAcademyPage(page, origin) {
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await page.addInitScript(() => {
    const user = { uid: 'studio-owner', email: 'studio@example.test', displayName: 'Studio', emailVerified: true, getIdToken: async () => 'academy-preview-token' };
    let app;
    const auth = { currentUser: user, onAuthStateChanged(callback) { queueMicrotask(() => callback(user)); return () => {}; } };
    window.firebase = {
      app() { if (!app) throw new Error('No preview app'); return app; },
      initializeApp(options) {
        if (options.projectId !== 'demo-xped-academy') throw new Error('Preview project required');
        app = { options };
        return app;
      },
      auth: () => auth,
    };
  });
}

module.exports = { test, expect, prepareAcademyPage };
