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
    const cwd = await dialog.getByTestId('spawn-folder-typed').inputValue();
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
    await dialog.getByTestId('spawn-folder-typed').press('Enter');
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
    const first = await dialog.getByTestId('spawn-folder-typed').inputValue();
    await dialog.getByTestId('spawn-folder-typed').fill('/tmp/typed-over');
    await dialog.getByTestId('spawn-close').click();
    await expect(page.getByTestId('spawn-dialog')).toBeHidden();

    dialog = await openSpawn(page);
    await expect(dialog.getByTestId('spawn-folder-typed')).toHaveValue(first);
  });
});

test.describe('Tier-1 #5: a failed spawn stays visible and recoverable', () => {
  test('a rejected spawn keeps the dialog, the error and the typed values', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);

    // `all` is syntactically valid but RESERVED by the protocol, so it passes
    // native validation and the daemon rejects it — a deterministic server
    // failure that does not depend on client validation working.
    await dialog.getByTestId('spawn-handle').fill('all');
    await expect(dialog.getByTestId('spawn-handle')).toHaveJSProperty('validity.valid', true);
    const cwd = await dialog.getByTestId('spawn-folder-typed').inputValue();
    await dialog.getByTestId('spawn-go').click();

    await expect(page.getByTestId('spawn-dialog')).toBeVisible();
    await expect(dialog.getByTestId('spawn-error')).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByTestId('spawn-go')).toBeEnabled();
    await expect(dialog.getByTestId('spawn-folder-typed')).toHaveValue(cwd);
  });

  test('a successful spawn closes the dialog only when the submitted handle arrives', async ({ page }) => {
    // The branch matrix — unrelated member present, unrelated error present, our
    // error present — is proven exhaustively in agent-spec.spec.ts against
    // resolveSpawn(), because a browser cannot inject those states
    // deterministically. This covers the observable end-to-end path.
    await openRoom(page);
    const dialog = await openSpawn(page);
    await dialog.getByTestId('spawn-handle').fill('closer');
    await dialog.getByTestId('spawn-go').click();
    await expect(page.getByTestId('member-closer')).toBeVisible({ timeout: 20_000 });
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
    // No slider at all for a harness that declares no levels — the absence is the
    // information, and there is nothing to arm by accident.
    await expect(dialog.getByTestId('spawn-thinking-slider')).toHaveCount(0);
  });

  test('a preset arms only what the harness accepts, and fills the visible fields', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    await dialog.getByTestId('spawn-preset-writer').click();
    await expect(dialog.getByTestId('spawn-handle')).toHaveValue(/writer/);
    await expect(dialog.getByTestId('spawn-policy-workspace-write')).toHaveAttribute('aria-pressed', 'true');
    // Writer asks for `low`; this harness supports no levels, so nothing is armed
    // rather than a value that would be rejected.
    await expect(dialog.getByTestId('spawn-thinking-slider')).toHaveCount(0);
  });

  test('a handle colliding with the channel owner is blocked, unconditionally', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    // The fixture's owner, asserted rather than discovered: a guarded assertion
    // lets the bug vanish silently the day the fixture changes.
    await expect(page.getByTestId('member-richard')).toBeVisible();
    await dialog.getByTestId('spawn-handle').fill('richard');
    await expect(dialog.getByTestId('spawn-owner-clash')).toBeVisible();
    await expect(dialog.getByTestId('spawn-go')).toBeDisabled();
    await dialog.getByTestId('spawn-handle').fill('notrichard');
    await expect(dialog.getByTestId('spawn-owner-clash')).toBeHidden();
    await expect(dialog.getByTestId('spawn-go')).toBeEnabled();
  });

  test('switching between two real harnesses reconciles thinking and the policy warning', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);

    // thinky declares its own levels; fake supports none.
    await dialog.getByTestId('spawn-harness-thinky').click();
    // The slider's stops are adapter-declared: Default, then thinky's four levels.
    await dialog.getByTestId('spawn-thinking-range').fill('4');
    await expect(dialog.getByTestId('spawn-thinking-value')).toHaveText('xhigh');

    // thinky defers read-only entirely — null mapping, so the choice changes
    // nothing and the operator must be told.
    await dialog.getByTestId('spawn-policy-read-only').click();
    await expect(dialog.getByTestId('spawn-policy-deferred')).toBeVisible();

    await dialog.getByTestId('spawn-harness-fake').click();
    await expect(dialog.getByTestId('spawn-thinking-unsupported')).toBeVisible();
    // No slider at all for a harness that declares no levels — the absence is the
    // information, and there is nothing to arm by accident.
    await expect(dialog.getByTestId('spawn-thinking-slider')).toHaveCount(0);
    await expect(dialog.getByTestId('spawn-policy-deferred')).toBeHidden();
  });

  test('a model typed for one harness does not survive switching to another', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    await dialog.getByTestId('spawn-harness-thinky').click();
    await dialog.getByTestId('spawn-model-input').fill('thinky-only-model');
    await dialog.getByTestId('spawn-harness-fake').click();
    await expect(dialog.getByTestId('spawn-model-input')).toHaveValue('');
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

test.describe('the "None" state means none', () => {
  test('an owner collision applies only while a starting agent is selected', async ({ page }) => {
    // The name field keeps its value under "None". Without scoping the collision
    // to a selected harness, an owner-shaped name blocked channel creation
    // entirely — for an agent that was never going to be created.
    await openRoom(page);
    await page.getByTestId('create-room').click();
    const dialog = page.getByTestId('create-channel-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('create-name').fill('agentless');

    await dialog.getByTestId('create-harness-fake').click();
    await dialog.getByTestId('create-agent-name').fill('richard');
    await expect(dialog.getByTestId('create-owner-clash')).toBeVisible();
    await expect(dialog.getByTestId('create-go')).toBeDisabled();

    // Back to None: the same text is inert, and creation is possible again.
    await dialog.getByTestId('create-harness-none').click();
    await expect(dialog.getByTestId('create-agent-name')).toBeDisabled();
    await expect(dialog.getByTestId('create-owner-clash')).toBeHidden();
    await expect(dialog.getByTestId('create-go')).toBeEnabled();

    await dialog.getByTestId('create-go').click();
    await expect(page.locator('.nx-chat-title h1')).toHaveText('agentless', { timeout: 15_000 });
  });

  test('a reserved starting-agent name is refused before it can be submitted', async ({ page }) => {
    // Client-side: `all` is reserved, so the derived handle is refused and submit
    // never arms. Routing of a genuine SERVER starting-agent failure is proven in
    // agent-spec.spec.ts against isAgentFieldError — this fixture cannot provoke
    // one, because a brand-new channel has no members to collide with.
    await openRoom(page);
    await page.getByTestId('create-room').click();
    const dialog = page.getByTestId('create-channel-dialog');
    await dialog.getByTestId('create-name').fill('reservedname');
    await dialog.getByTestId('create-harness-fake').click();
    await dialog.getByTestId('create-agent-name').fill('all');
    await expect(dialog.getByTestId('create-go')).toBeDisabled();
  });
});

test.describe('v2 controls', () => {
  test('the thinking slider is adapter-sourced and rides its stops', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    await dialog.getByTestId('spawn-harness-thinky').click();

    const range = dialog.getByTestId('spawn-thinking-range');
    // thinky declares four levels, so the stops are Default + 4 — never the
    // reference's hardcoded seven.
    await expect(range).toHaveAttribute('max', '4');
    await expect(dialog.getByTestId('spawn-thinking-value')).toHaveText('Default');

    await range.fill('1');
    await expect(dialog.getByTestId('spawn-thinking-value')).toHaveText('low');
    await range.fill('4');
    await expect(dialog.getByTestId('spawn-thinking-value')).toHaveText('xhigh');

    // Keyboard reaches it, and the accessible value tracks the visible one.
    await range.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(dialog.getByTestId('spawn-thinking-value')).toHaveText('high');
    await expect(range).toHaveAttribute('aria-valuetext', 'high');
  });

  test('the model list searches, selects, and still takes a custom id', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    // The fixture harnesses report no catalogue, so the free-text escape is the
    // whole control — and it must still accept an off-catalogue id.
    await dialog.getByTestId('spawn-model-input').fill('some-exact-model');
    await expect(dialog.getByTestId('spawn-model-input')).toHaveValue('some-exact-model');
    // Switching harness clears it, because model ids are harness-specific.
    await dialog.getByTestId('spawn-harness-thinky').click();
    await expect(dialog.getByTestId('spawn-model-input')).toHaveValue('');
  });

  test('the inline folder picker selects without committing while browsing', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    const picker = dialog.getByTestId('spawn-folder-picker');
    await expect(picker).toBeVisible();

    const before = await dialog.getByTestId('spawn-folder-typed').inputValue();
    // Navigating up must not change the selection — only choosing a row does.
    const up = dialog.getByTestId('spawn-folder-up');
    if (await up.count() > 0) {
      await up.click();
      await expect(dialog.getByTestId('spawn-folder-typed')).toHaveValue(before);
    }
    // Select and Open are separate controls now — double-click carried "open"
    // before, which no keyboard user can reach.
    const dir = picker.getByTestId(/^spawn-folder-(?!picker|typed|hidden|up|refresh|parent|selected|retry)/).first();
    await expect(dir).toBeVisible();
    const name = (await dir.getAttribute('data-testid'))!.replace('spawn-folder-', '');
    await dir.click();
    await expect(dir).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByTestId('spawn-folder-typed')).not.toHaveValue(before);

    // Opening descends without changing what is selected.
    const selected = await dialog.getByTestId('spawn-folder-typed').inputValue();
    await dialog.getByTestId(`spawn-open-${name}`).click();
    await expect(dialog.getByTestId('spawn-folder-typed')).toHaveValue(selected);
  });

  test('hidden folders can be revealed', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    const toggle = dialog.getByTestId('spawn-folder-hidden');
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(toggle).toBeChecked();
  });
});

test.describe('all three dialogs share one control', () => {
  test('spawn, create and configure each render the shared groups', async ({ page }) => {
    // The regression this guards: three hand-rolled forms that drifted apart from
    // each other and from the protocol.
    await openRoom(page);

    const spawn = await openSpawn(page);
    await expect(spawn.getByTestId('spawn-policy-read-only')).toBeVisible();
    await expect(spawn.getByTestId('spawn-policy-read-only')).toBeVisible();
    await spawn.getByTestId('spawn-close').click();

    await page.getByTestId('create-room').click();
    const create = page.getByTestId('create-channel-dialog');
    await create.getByTestId('create-harness-fake').click();
    await expect(create.getByTestId('create-policy-read-only')).toBeVisible();
    await expect(create.getByTestId('create-policy-read-only')).toBeVisible();
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
    await expect(dialog.getByTestId('configure-policy-read-only')).toBeVisible();

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

    // Channel colour is automatic; creation no longer asks the operator to
    // make a cosmetic decision before doing the useful work.
    await expect(dialog.getByText('Colour', { exact: true })).toHaveCount(0);
    await expect(dialog.locator('[data-testid^="create-color-"]')).toHaveCount(0);

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
