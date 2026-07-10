import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['e2e.spec.ts', '*.e2e.spec.ts'],
  outputDir: join(tmpdir(), 'wireroom-playwright'), // artifacts never land in the repo
  workers: 1, // one shared daemon — the flow is a serial narrative
  use: {
    baseURL: 'http://127.0.0.1:8137',
  },
  webServer: {
    command: 'node tests/harness.mjs',
    url: 'http://127.0.0.1:8138/health',
    reuseExistingServer: false,
    stdout: 'pipe',
  },
});
