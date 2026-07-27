// E2E smoke suite for pull requests and local verification.
const { defineConfig } = require('@playwright/test');
const { existsSync } = require('fs');

const testPort = Number(process.env.PLAYWRIGHT_PORT || process.env.PORT || 5113);
const baseUrl = `http://127.0.0.1:${testPort}`;
const physioPort = Number(process.env.PHYSIO_E2E_PORT || 8766);
const physioBaseUrl = `http://127.0.0.1:${physioPort}`;
const physioOwnerToken = process.env.PHYSIO_COMPANION_OWNER_TOKEN
  || 'playwright-owner-token-for-isolated-e2e-only';
const pythonCommand = existsSync('.venv/bin/python')
  ? '.venv/bin/python'
  : (existsSync('venv/bin/python') ? 'venv/bin/python' : 'python3');

process.env.PHYSIO_COMPANION_URL = `${physioBaseUrl}/physio`;
process.env.PHYSIO_COMPANION_OWNER_TOKEN = physioOwnerToken;

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: baseUrl,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },
  webServer: [
    {
      command: `${pythonCommand} app.py`,
      url: baseUrl,
      reuseExistingServer: false,
      timeout: 90_000,
      env: {
        PORT: String(testPort),
        FLASK_DEBUG: '0',
        SENTRY_DSN_BACKEND: '',
        SENTRY_DSN_FRONTEND: ''
      }
    },
    {
      command: `${pythonCommand} scripts/run_physio_companion_e2e.py --port ${physioPort}`,
      url: `${physioBaseUrl}/healthz`,
      reuseExistingServer: false,
      timeout: 90_000,
      env: {
        PHYSIO_COMPANION_OWNER_TOKEN: physioOwnerToken
      }
    }
  ]
});
