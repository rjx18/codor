import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

function readPort(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
}

const apiPort = readPort('CODOR_NEXT_E2E_API_PORT', 28_137);

export default defineConfig({
  testDir: './tests',
  testMatch: ['*.e2e.spec.ts'],
  outputDir: join(tmpdir(), 'codor-next-playwright'),
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${String(apiPort)}`,
    // The reference desktop composition: all three islands visible.
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'node tests/harness.mjs',
    url: `http://127.0.0.1:${String(apiPort)}/`,
    reuseExistingServer: true,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
