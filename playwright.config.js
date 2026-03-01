// Optional E2E suite. Kept out of required CI checks.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },
  webServer: {
    command: 'python app.py',
    url: 'http://127.0.0.1:5000',
    reuseExistingServer: true,
    timeout: 90_000,
    env: {
      SENTRY_DSN_BACKEND: '',
      SENTRY_DSN_FRONTEND: ''
    }
  }
});
