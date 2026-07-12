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

// harn:assume playwright-spec-files-use-isolated-daemons ref=isolated-e2e-playwright-config
const apiPort = readPort('CODOR_E2E_API_PORT', 18_137);
const controlPort = readPort('CODOR_E2E_CONTROL_PORT', 18_138);

export default defineConfig({
  testDir: './tests',
  testMatch: ['e2e.spec.ts', '*.e2e.spec.ts'],
  outputDir: join(tmpdir(), 'codor-playwright'), // artifacts never land in the repo
  workers: 1, // each spec keeps its own serial narrative
  use: {
    baseURL: `http://127.0.0.1:${String(apiPort)}`,
  },
  webServer: {
    command: 'node tests/harness.mjs',
    url: `http://127.0.0.1:${String(controlPort)}/health`,
    reuseExistingServer: false,
    stdout: 'pipe',
  },
});
// harn:end playwright-spec-files-use-isolated-daemons
