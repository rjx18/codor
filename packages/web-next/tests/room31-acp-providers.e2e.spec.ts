import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// Named PATH-detected ACP providers. The fixture registers a configurable `acp` transport
// and injects mutable detection: kimi is detected, kilo is not, until a control endpoint
// flips it. Kimi/Kilo are the frozen curated providers. No provider is ever invoked and the
// wire never carries a provider's executable/argv — only its safe id.
const ENG = '/?room=eng&token=next-e2e-token';
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

async function control(path: string): Promise<void> {
  const res = await fetch(`${CONTROL}${path}`, { method: 'POST' });
  if (!res.ok) throw new Error(`${path} failed: ${await res.text()}`);
}

async function openSpawn(page: Page): Promise<ReturnType<Page['getByTestId']>> {
  await page.goto(ENG);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
  await page.getByTestId('spawn-agent').click();
  const dialog = page.getByTestId('spawn-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

// Expand the Advanced disclosure and select the generic custom-ACP tile inside it.
async function chooseCustomAcp(dialog: ReturnType<Page['getByTestId']>): Promise<void> {
  await dialog.getByTestId('spawn-advanced').locator('summary').click();
  await dialog.getByTestId('spawn-advanced').getByTestId('spawn-harness-acp').click();
}

test.describe('named ACP providers', () => {
  test.beforeEach(async () => { await control('/acp-reset'); });

  test('shows only detected named providers in primary selection with an ACP pill', async ({ page }) => {
    const dialog = await openSpawn(page);
    // Kimi is detected -> a primary tile with an ACP pill; the generic tile is NOT primary.
    await expect(dialog.getByTestId('spawn-harness-acp:kimi')).toBeVisible();
    await expect(dialog.getByTestId('spawn-acp-pill-kimi')).toHaveText('ACP');
    await expect(dialog.getByTestId('spawn-harness-acp:kimi')).toContainText('Kimi Code CLI');
    // Kilo is not detected -> absent from primary. The generic `acp` tile is not primary.
    await expect(dialog.getByTestId('spawn-harness-acp:kilo')).toHaveCount(0);
    // The one generic `acp` tile lives only inside the Advanced disclosure, never primary.
    await expect(dialog.getByTestId('spawn-harness-acp')).toHaveCount(1);
    await expect(dialog.getByTestId('spawn-advanced').getByTestId('spawn-harness-acp')).toHaveCount(1);
  });

  test('keeps the generic custom ACP command behind an Advanced disclosure', async ({ page }) => {
    const dialog = await openSpawn(page);
    const advanced = dialog.getByTestId('spawn-advanced');
    await expect(advanced).toBeVisible();
    // The custom launch fields are hidden until the generic tile is chosen.
    await expect(dialog.getByTestId('spawn-acp-launch')).toHaveCount(0);
    await chooseCustomAcp(dialog);
    await expect(dialog.getByTestId('spawn-acp-executable')).toBeVisible();
    await expect(dialog.getByTestId('spawn-acp-args')).toBeVisible();
    // A named tile carries no custom fields.
    await dialog.getByTestId('spawn-harness-acp:kimi').click();
    await expect(dialog.getByTestId('spawn-acp-launch')).toHaveCount(0);
  });

  test('Refresh brings a newly detected provider into the catalog', async ({ page }) => {
    const dialog = await openSpawn(page);
    await expect(dialog.getByTestId('spawn-harness-acp:kilo')).toHaveCount(0);
    await control('/acp-detect-kilo'); // kilo appears on PATH
    await dialog.getByTestId('spawn-refresh-adapters').click();
    await expect(dialog.getByTestId('spawn-harness-acp:kilo')).toBeVisible();
    await expect(dialog.getByTestId('spawn-acp-pill-kilo')).toHaveText('ACP');
  });

  test('spawning a named provider sends its safe id and never a command', async ({ page }) => {
    // The dialog spawns over the websocket, so capture sent frames to inspect the payload.
    const frames: string[] = [];
    page.on('websocket', (ws) => {
      ws.on('framesent', (frame) => { if (typeof frame.payload === 'string') frames.push(frame.payload); });
    });
    const dialog = await openSpawn(page);
    await dialog.getByTestId('spawn-harness-acp:kimi').click();
    await dialog.getByTestId('spawn-handle').fill('kimispawn');
    await dialog.getByTestId('spawn-go').click();
    await expect(page.getByTestId('member-kimispawn')).toBeVisible({ timeout: 15_000 });
    const spawnFrame = frames.find((f) => f.includes('"act":"spawn"') && f.includes('kimispawn'));
    expect(spawnFrame, 'a spawn act was sent for @kimispawn').toBeDefined();
    expect(spawnFrame).toContain('"harness":"acp"');
    expect(spawnFrame).toContain('"acp_provider":"kimi"');
    expect(spawnFrame).not.toContain('executable'); // never a command
    expect(spawnFrame).not.toContain('argv');
  });

  test('a custom ACP command still sends a structured launch, not a provider id', async ({ page }) => {
    const frames: string[] = [];
    page.on('websocket', (ws) => {
      ws.on('framesent', (frame) => { if (typeof frame.payload === 'string') frames.push(frame.payload); });
    });
    const dialog = await openSpawn(page);
    await chooseCustomAcp(dialog);
    await dialog.getByTestId('spawn-acp-executable').fill('my-acp-tool');
    await dialog.getByTestId('spawn-acp-args').fill('acp\n--profile=x');
    await dialog.getByTestId('spawn-handle').fill('customspawn');
    await dialog.getByTestId('spawn-go').click();
    await expect(page.getByTestId('member-customspawn')).toBeVisible({ timeout: 15_000 });
    const spawnFrame = frames.find((f) => f.includes('"act":"spawn"') && f.includes('customspawn'));
    expect(spawnFrame, 'a spawn act was sent for @customspawn').toBeDefined();
    expect(spawnFrame).toContain('"harness":"acp"');
    expect(spawnFrame).not.toContain('acp_provider'); // a custom command carries no provider id
    expect(spawnFrame).toContain('"executable":"my-acp-tool"');
    expect(spawnFrame).toContain('"argv"');
  });

  test('Create channel offers the same detected named provider', async ({ page }) => {
    await page.goto(ENG);
    await expect(page.getByTestId('timeline')).toBeVisible();
    await page.getByTestId('create-room').click();
    const dialog = page.getByTestId('create-channel-dialog');
    await expect(dialog.getByTestId('create-harness-acp:kimi')).toBeVisible();
    await expect(dialog.getByTestId('create-acp-pill-kimi')).toHaveText('ACP');
    await expect(dialog.getByTestId('create-advanced')).toBeVisible();
  });

  test('Configure shows a named member locked to its provider identity, with the ACP pill', async ({ page }) => {
    await page.goto('/?room=acp-providers&token=next-e2e-token');
    await expect(page.getByTestId('timeline')).toBeVisible();
    await page.getByTestId('member-kimo-menu').click();
    await page.getByRole('menuitem', { name: 'Configure…' }).click();
    const configure = page.getByTestId('configure-dialog');
    await expect(configure).toBeVisible();
    const tile = configure.getByTestId('configure-harness-acp:kimi');
    await expect(tile).toBeVisible();
    await expect(tile).toBeDisabled(); // locked to the persisted provider identity
    await expect(configure.getByTestId('configure-acp-pill-kimi')).toHaveText('ACP');
    // A locked configure never exposes a custom-command field or the Advanced disclosure.
    await expect(configure.getByTestId('configure-acp-launch')).toHaveCount(0);
    await expect(configure.getByTestId('configure-advanced')).toHaveCount(0);
  });

  test('the named provider tiles are keyboard operable', async ({ page }) => {
    const dialog = await openSpawn(page);
    const tile = dialog.getByTestId('spawn-harness-acp:kimi');
    await tile.focus();
    await page.keyboard.press('Enter');
    await expect(tile).toHaveAttribute('aria-pressed', 'true');
  });

  test('renders the named provider tiles at mobile width without overflow', async ({ page }) => {
    // At phone width the context panel (and its spawn button) live behind the kebab sheet.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(ENG);
    await expect(page.getByTestId('timeline')).toBeVisible();
    await page.getByTestId('mobile-kebab').click();
    await page.getByTestId('mobile-context').getByTestId('spawn-agent').click();
    const dialog = page.getByTestId('spawn-dialog');
    await expect(dialog.getByTestId('spawn-harness-acp:kimi')).toBeVisible();
    const overflow = await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(overflow).toBe(false);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`is axe-clean with named provider tiles in ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const dialog = await openSpawn(page);
      await expect(dialog.getByTestId('spawn-harness-acp:kimi')).toBeVisible();
      await chooseCustomAcp(dialog);
      const { violations } = await new AxeBuilder({ page }).include('[data-testid="spawn-dialog"]').analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
    });
  }
});
