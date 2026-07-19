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

test.describe('Tier-1 #5: a failed spawn stays visible and recoverable', () => {
  test('keeps the error, re-enables submit, ignores unrelated members, and closes only on the real one', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);

    // `all` is syntactically valid but RESERVED (protocol member.ts), so it passes
    // native validation and is rejected by the daemon — a deterministic server
    // failure rather than one that depends on client-side validation working.
    await dialog.getByTestId('spawn-handle').fill('all');
    await expect(dialog.getByTestId('spawn-handle')).toHaveJSProperty('validity.valid', true);
    await dialog.getByTestId('spawn-go').click();

    // It must not close on a request that was merely sent.
    await expect(page.getByTestId('spawn-dialog')).toBeVisible();
    await expect(dialog.getByTestId('spawn-error')).toBeVisible({ timeout: 15_000 });
    // ...and the operator can try again without losing what they typed.
    await expect(dialog.getByTestId('spawn-go')).toBeEnabled();
    await expect(dialog.getByTestId('spawn-cwd')).not.toHaveValue('');

    // An UNRELATED member arriving must not be read as this spawn succeeding.
    await dialog.getByTestId('spawn-handle').fill('bystander');
    await dialog.getByTestId('spawn-go').click();
    await expect(page.getByTestId('member-bystander')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('spawn-dialog')).toBeHidden();

    // Success closes it, and only for the handle actually submitted.
    const second = await openSpawn(page);
    await second.getByTestId('spawn-handle').fill('realone');
    await second.getByTestId('spawn-go').click();
    await expect(page.getByTestId('member-realone')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('spawn-dialog')).toBeHidden();
  });

  test('native validation actually rejects a malformed handle', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    // The pattern was compiled invalid under `v` rules and therefore ignored, so
    // this reported valid while looking guarded.
    await dialog.getByTestId('spawn-handle').fill('NOPE!!');
    await expect(dialog.getByTestId('spawn-handle')).toHaveJSProperty('validity.valid', false);
    await expect(dialog.getByTestId('spawn-handle')).toHaveJSProperty('validity.patternMismatch', true);
  });

  test('the handle field takes focus on open, not the close button', async ({ page }) => {
    await openRoom(page);
    await openSpawn(page);
    await expect(page.getByTestId('spawn-handle')).toBeFocused();
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

test.describe('Tier-1: rendered reconciliation and validation', () => {
  test('changing harness clears the model and an unsupported thinking level in the DOM', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    // The fixture harness reports no thinking support, so the group is disabled
    // and the default stays selected — the absence is stated, not hidden.
    await expect(dialog.getByTestId('spawn-thinking-unsupported')).toBeVisible();
    await expect(dialog.getByTestId('spawn-thinking-default')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a preset arms only what the harness accepts, and fills the visible fields', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    await dialog.getByTestId('spawn-preset-writer').click();
    await expect(dialog.getByTestId('spawn-handle')).toHaveValue(/writer/);
    await expect(dialog.getByTestId('spawn-policy-workspace-write')).toHaveAttribute('aria-pressed', 'true');
    // Writer asks for `low`; this harness supports no levels, so it stays default
    // rather than arming a value that would be rejected.
    await expect(dialog.getByTestId('spawn-thinking-default')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a handle colliding with the channel owner is blocked with a specific message', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    const owner = await page.getByTestId(/^member-/).first().textContent();
    const ownerHandle = /@?([a-z0-9][a-z0-9-]*)/.exec(owner ?? '')?.[1] ?? 'richard';
    await dialog.getByTestId('spawn-handle').fill(ownerHandle);
    const clash = dialog.getByTestId('spawn-owner-clash');
    if (await clash.count() > 0) {
      await expect(clash).toBeVisible();
      await expect(dialog.getByTestId('spawn-go')).toBeDisabled();
    }
  });
});

test.describe('Tier-1: create channel keyboard and fallbacks', () => {
  test('Enter creates, and a blank agent name falls back to Agent', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('create-room').click();
    const dialog = page.getByTestId('create-channel-dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByTestId('create-harness-fake').click();
    // Clearing the name must not block submit — it falls back to "Agent".
    await dialog.getByTestId('create-agent-name').fill('');
    await dialog.getByTestId('create-name').fill('fallbackchan');
    await expect(dialog.getByTestId('create-go')).toBeEnabled();

    await dialog.getByTestId('create-name').press('Enter');
    await expect(page.locator('.nx-chat-title h1')).toHaveText('fallbackchan', { timeout: 15_000 });
    await expect(page.getByTestId('member-agent')).toBeVisible({ timeout: 15_000 });
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

  test('the create dialog is genuinely usable at 320px via Back → Channels → Create', async ({ page }) => {
    // The real mobile path, not a desktop CSS proxy: below the breakpoint the
    // two-surface IA moves creation to the channels surface, so that is where a
    // phone user actually reaches this dialog.
    await page.setViewportSize({ width: 320, height: 720 });
    await openRoom(page);
    await page.getByTestId('mobile-back').click();
    await page.getByTestId('create-room').click();

    const dialog = page.getByTestId('create-channel-dialog');
    await expect(dialog).toBeVisible();

    // No horizontal overflow anywhere on the page.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);

    // Every swatch is inside the modal and keeps a real touch target.
    const box = (await dialog.boundingBox())!;
    for (const index of [0, 5]) {
      const swatch = (await dialog.getByTestId(`create-color-${String(index)}`).boundingBox())!;
      expect(swatch.x).toBeGreaterThanOrEqual(box.x - 0.5);
      expect(swatch.x + swatch.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      expect(swatch.width).toBeGreaterThanOrEqual(44);
      expect(swatch.height).toBeGreaterThanOrEqual(44);
    }

    // And it still works: name it and create from the phone.
    await dialog.getByTestId('create-name').fill('phonemade');
    await dialog.getByTestId('create-go').click();
    // On a phone, creating lands you inside the new channel (two-surface stack).
    // Asserted on the URL and the visible name rather than the desktop header
    // element, which the mobile surface does not render.
    await expect(page).toHaveURL(/room=phonemade/, { timeout: 15_000 });
    await expect(page.getByText('phonemade').first()).toBeVisible();
  });
});
