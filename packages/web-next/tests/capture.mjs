// Screenshot pipeline: reference-comparable captures of the seeded room at
// 1440 light/dark and 390 light. Expects the fixture harness on 28137
// (`pnpm harness`), writes to tmp/web-next/captures/ at the repo root.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const PORT = process.env.CODOR_NEXT_E2E_API_PORT ?? '28137';
const URL = `http://127.0.0.1:${PORT}/?room=eng&token=next-e2e-token`;
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tmp', 'web-next', 'captures');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const shot = async (name, { width, height, dark = false }) => {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(URL);
  await page.getByTestId('timeline').waitFor();
  if (dark) await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForTimeout(600); // fonts + transitions settle
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  await page.close();
  console.log(`captured ${name}`);
};

await shot('room-1440-light', { width: 1440, height: 900 });
await shot('room-1440-dark', { width: 1440, height: 900, dark: true });
await shot('room-390-light', { width: 390, height: 844 });
await browser.close();
