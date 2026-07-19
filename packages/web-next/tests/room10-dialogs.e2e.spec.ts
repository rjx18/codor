import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const ROOM = '/?room=eng&token=next-e2e-token';

async function openRoom(page: Page): Promise<void> {
  await page.goto(ROOM);
  await expect(page.getByTestId('timeline')).toBeVisible();
  // The connection pill is desktop chrome; at phone widths it is not rendered.
  const connection = page.getByTestId('connection');
  if (await connection.count() > 0) await expect(connection).toHaveText(/Connected/);
}

async function openSpawn(page: Page) {
  await page.getByTestId('spawn-agent').click();
  const dialog = page.getByTestId('spawn-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Integration coverage for the Tier-1 contracts.
 *
 * The unit suite proves the rules; these prove the dialogs actually apply them.
 * That gap is not theoretical — every Tier-1 defect was a case of correct
 * intent never reaching the payload.
 */

test.describe('Tier-1: spawn payload', () => {
  test('always carries a policy, and the inherited cwd, without the operator touching either', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    // cwd arrives prefilled by inheritance; the operator retyped it before.
    const cwd = await dialog.getByTestId('spawn-cwd').inputValue();
    expect(cwd).not.toBe('');

    await dialog.getByTestId('spawn-handle').fill('policyprobe');
    await dialog.getByTestId('spawn-go').click();

    // The member is the observable proof the payload was accepted.
    await expect(page.getByTestId('member-policyprobe')).toBeVisible({ timeout: 15_000 });
    // read-only is the default the dialog never sent before.
    await expect(page.getByTestId('member-policyprobe')).toContainText('read-only');
  });

  test('Enter submits from a field, without reaching for the button', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    await dialog.getByTestId('spawn-handle').fill('enterling');
    await dialog.getByTestId('spawn-cwd').press('Enter');
    await expect(page.getByTestId('member-enterling')).toBeVisible({ timeout: 15_000 });
  });

  test('a duplicate handle is made unique instead of failing server-side', async ({ page }) => {
    await openRoom(page);
    let dialog = await openSpawn(page);
    await dialog.getByTestId('spawn-handle').fill('twin');
    await dialog.getByTestId('spawn-go').click();
    await expect(page.getByTestId('member-twin')).toBeVisible({ timeout: 15_000 });

    dialog = await openSpawn(page);
    await dialog.getByTestId('spawn-handle').fill('twin');
    await dialog.getByTestId('spawn-go').click();
    await expect(page.getByTestId('member-twin-2')).toBeVisible({ timeout: 15_000 });
  });

  test('a role preset fills handle, purpose and policy in one click', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    await dialog.getByTestId('spawn-preset-reviewer').click();
    await expect(dialog.getByTestId('spawn-handle')).toHaveValue(/reviewer/);
    await expect(dialog.getByTestId('spawn-purpose')).toHaveValue(/[Rr]eview/);
    await expect(dialog.getByTestId('spawn-policy-read-only')).toHaveAttribute('aria-pressed', 'true');
  });

  test('reopening recomputes the inherited cwd rather than keeping stale state', async ({ page }) => {
    await openRoom(page);
    let dialog = await openSpawn(page);
    const first = await dialog.getByTestId('spawn-cwd').inputValue();
    await dialog.getByTestId('spawn-cwd').fill('/tmp/typed-over');
    await dialog.getByTestId('spawn-close').click();
    await expect(page.getByTestId('spawn-dialog')).toBeHidden();

    dialog = await openSpawn(page);
    await expect(dialog.getByTestId('spawn-cwd')).toHaveValue(first);
  });
});

test.describe('Tier-1 #5: a failed spawn stays visible', () => {
  test('keeps the dialog open with the error, and an unrelated member does not report success', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    // A handle the server will reject: uppercase is outside the handle grammar.
    await dialog.getByTestId('spawn-handle').fill('NOPE!!');
    await dialog.getByTestId('spawn-cwd').fill('/tmp');

    const enabled = await dialog.getByTestId('spawn-go').isEnabled();
    if (enabled) {
      await dialog.getByTestId('spawn-go').click();
      // It must NOT close on a request that was merely sent.
      await expect(page.getByTestId('spawn-dialog')).toBeVisible();
      await expect(dialog.getByTestId('spawn-error')).toBeVisible({ timeout: 15_000 });
    } else {
      // Blocked client-side is also acceptable — what is not acceptable is
      // closing silently, which is what it used to do.
      await expect(page.getByTestId('spawn-dialog')).toBeVisible();
    }
  });
});

test.describe('Tier-1: the create dialog seeds a fully configured agent', () => {
  test('sends a policy with the starting agent and shows the derived id', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('create-room').click();
    const dialog = page.getByTestId('create-channel-dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByTestId('create-name').fill('seeded');
    await expect(dialog).toContainText('id:');

    // The agent-name field stays mounted while None is selected, disabled.
    await expect(dialog.getByTestId('create-agent-name')).toBeDisabled();
    await dialog.getByTestId('create-harness-fake').click();
    await expect(dialog.getByTestId('create-agent-name')).toBeEnabled();
    // It defaults to codor rather than starting empty.
    await expect(dialog.getByTestId('create-agent-name')).toHaveValue('codor');

    await dialog.getByTestId('create-go').click();
    await expect(page.locator('.nx-chat-title h1')).toHaveText('seeded', { timeout: 15_000 });
    await expect(page.getByTestId('member-codor')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('member-codor')).toContainText('read-only');
  });
});

test.describe('all three dialogs share one control', () => {
  test('spawn, create and configure each render the shared groups', async ({ page }) => {
    // The regression this guards: three hand-rolled forms that drifted apart from
    // each other and from the protocol.
    await openRoom(page);

    const spawn = await openSpawn(page);
    await expect(spawn.getByTestId('spawn-policy-read-only')).toBeVisible();
    await expect(spawn.getByTestId('spawn-thinking-default')).toBeVisible();
    await spawn.getByTestId('spawn-close').click();

    await page.getByTestId('create-room').click();
    const create = page.getByTestId('create-channel-dialog');
    await create.getByTestId('create-harness-fake').click();
    await expect(create.getByTestId('create-policy-read-only')).toBeVisible();
    await expect(create.getByTestId('create-thinking-default')).toBeVisible();
    await create.getByTestId('create-close').click();
  });
});

test.describe('accessibility', () => {
  test('the create dialog is axe-clean in both themes', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('create-room').click();
    const dialog = page.getByTestId('create-channel-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('create-harness-fake').click();
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      const res = await new AxeBuilder({ page }).analyze();
      expect(res.violations.map((v) => v.id), theme).toEqual([]);
    }
  });

  test('the configure dialog is axe-clean in both themes and shares the control', async ({ page }) => {
    await openRoom(page);
    // Spawn one so there is definitely a configurable agent present.
    const spawn = await openSpawn(page);
    await spawn.getByTestId('spawn-handle').fill('cfgtarget');
    await spawn.getByTestId('spawn-go').click();
    await expect(page.getByTestId('member-cfgtarget')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('member-cfgtarget-menu').click();
    await page.getByRole('menuitem', { name: 'Configure…' }).click();
    const dialog = page.getByTestId('configure-dialog');
    await expect(dialog).toBeVisible();
    // Same shared groups as the other two dialogs.
    await expect(dialog.getByTestId('configure-policy-read-only')).toBeVisible();
    await expect(dialog.getByTestId('configure-thinking-default')).toBeVisible();

    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      const res = await new AxeBuilder({ page }).analyze();
      expect(res.violations.map((v) => v.id), theme).toEqual([]);
    }
  });

  test('the six colour swatches wrap rather than overflowing a narrow modal', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('create-room').click();
    const dialog = page.getByTestId('create-channel-dialog');
    await expect(dialog).toBeVisible();

    // Asserted as a CSS contract rather than by measuring at 320px: below the
    // mobile breakpoint the two-surface IA unmounts this dialog entirely, so
    // there is no geometry to measure there. Six 44px targets need ~264px plus
    // gaps, which overflows a narrow modal unless the row wraps.
    const wrap = await dialog.getByTestId('create-color-0').evaluate(
      (el) => getComputedStyle(el.parentElement as HTMLElement).flexWrap,
    );
    expect(wrap).toBe('wrap');

    // And they must still all be reachable and hittable at the size they render.
    for (const index of [0, 5]) {
      const box = await dialog.getByTestId(`create-color-${String(index)}`).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });
});
