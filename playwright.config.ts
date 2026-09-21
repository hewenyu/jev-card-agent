import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: 'http://127.0.0.1:8788', headless: true, trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run build && node dist/cli/serve.js --demo',
    url: 'http://127.0.0.1:8788/health',
    env: { HOST: '127.0.0.1', PORT: '8788', DATABASE_PATH: 'data/e2e.sqlite' },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
