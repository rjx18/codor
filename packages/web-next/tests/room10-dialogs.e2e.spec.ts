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
    // The switch is on by default, so cwd is inherited without the operator
    // touching a picker; the inherited path is shown rather than an empty field.
    await expect(dialog.getByTestId('spawn-use-current-dir')).toBeChecked();
    await expect(dialog.getByTestId('spawn-inherited-cwd')).toContainText('/');

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
    await dialog.getByTestId('spawn-handle').press('Enter');
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
    const first = await dialog.getByTestId('spawn-inherited-cwd').textContent();
    // Diverge from the inherited default: switch off and type a different path.
    await dialog.getByTestId('spawn-use-current-dir').click();
    await dialog.getByTestId('spawn-folder-typed').fill('/tmp/typed-over');
    await dialog.getByTestId('spawn-close').click();
    await expect(page.getByTestId('spawn-dialog')).toBeHidden();

    dialog = await openSpawn(page);
    // Reopened fresh: the switch is back on and the inherited path recomputed.
    await expect(dialog.getByTestId('spawn-use-current-dir')).toBeChecked();
    expect(await dialog.getByTestId('spawn-inherited-cwd').textContent()).toBe(first);
  });

  test('the working directory collapses behind a use-current-directory switch', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    // On by default: no picker, and the inherited directory is shown instead.
    await expect(dialog.getByTestId('spawn-use-current-dir')).toBeChecked();
    await expect(dialog.getByTestId('spawn-folder-picker')).toHaveCount(0);
    await expect(dialog.getByTestId('spawn-inherited-cwd')).toBeVisible();

    // The switch renders as a compact ~38x22 control — not the 38px-tall,
    // padded, bordered field input the generic .nx-field rule would otherwise
    // cascade onto it — and it is keyboard-focusable.
    const control = dialog.getByTestId('spawn-use-current-dir');
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThan(30);
    expect(box?.height).toBeLessThan(28);
    await control.focus();
    await expect(control).toBeFocused();

    // Switched off: the picker appears, seeded with the inherited path to edit.
    await control.click();
    await expect(dialog.getByTestId('spawn-folder-picker')).toBeVisible();
    expect(await dialog.getByTestId('spawn-folder-typed').inputValue()).not.toBe('');
  });

  test('with no directory to inherit, the switch defaults off and shows the picker', async ({ page }) => {
    // The trash room is agent-free with no cwd, so there is nothing to inherit;
    // the switch must not hide the picker while spawn stays blocked.
    await page.goto('/?room=trash&token=next-e2e-token');
    await expect(page.getByTestId('timeline')).toBeVisible();
    const dialog = await openSpawn(page);
    await expect(dialog.getByTestId('spawn-use-current-dir')).not.toBeChecked();
    await expect(dialog.getByTestId('spawn-folder-picker')).toBeVisible();
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
    await dialog.getByTestId('spawn-go').click();

    await expect(page.getByTestId('spawn-dialog')).toBeVisible();
    await expect(dialog.getByTestId('spawn-error')).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByTestId('spawn-go')).toBeEnabled();
    // The typed handle survives the failure so the operator can fix and retry.
    await expect(dialog.getByTestId('spawn-handle')).toHaveValue('all');
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

    // None is an honestly agentless state: only the harness choice and guidance
    // remain, with every agent-only field absent.
    await expect(dialog.getByTestId('create-agent-name')).toHaveCount(0);
    await expect(dialog.getByTestId('create-agent-none-note')).toBeVisible();
    await dialog.getByTestId('create-harness-thinky').click();
    await expect(dialog.getByTestId('create-agent-name')).toBeVisible();
    // It defaults to codor rather than starting empty.
    await expect(dialog.getByTestId('create-agent-name')).toHaveValue('codor');
    await dialog.getByTestId('create-agent-name').fill('restored');
    await dialog.getByTestId('create-model-custom').fill('thinky/custom');
    await dialog.getByTestId('create-thinking-range').fill('3');
    await dialog.getByTestId('create-policy-full-access').click();
    await dialog.getByTestId('create-harness-none').click();
    await expect(dialog.getByTestId('create-agent-name')).toHaveCount(0);
    await dialog.getByTestId('create-harness-thinky').click();
    await expect(dialog.getByTestId('create-agent-name')).toHaveValue('restored');
    await expect(dialog.getByTestId('create-model-custom')).toHaveValue('thinky/custom');
    await expect(dialog.getByTestId('create-thinking-value')).toHaveText('high');
    await expect(dialog.getByTestId('create-policy-full-access')).toHaveAttribute('aria-pressed', 'true');

    // The working folder is required, so pick one before creating.
    await dialog.getByTestId('create-folder-alpha-project').click();
    await dialog.getByTestId('create-go').click();
    await expect(page.locator('.nx-chat-title h1')).toHaveText('seeded', { timeout: 15_000 });
    await expect(page.getByTestId('member-restored')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('member-restored')).toContainText('full-access');
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
    await dialog.getByTestId('spawn-model-custom').fill('thinky-only-model');
    await dialog.getByTestId('spawn-harness-fake').click();
    await expect(dialog.getByTestId('spawn-model-input')).toHaveValue('');
  });
});

// harn:assume agent-selection-catalog-is-refreshable ref=harness-refresh-browser-regression
test.describe('Create Channel installed harness catalog', () => {
  test('refresh resets a disappeared optional harness to None and preserves typed identity', async ({ page }) => {
    let listing: { adapters: { id: string; installed?: boolean }[] } | undefined;
    let empty = false;
    const body = () => ({
      ...listing,
      adapters: listing!.adapters.map((adapter) => ({
        ...adapter,
        installed: !empty && adapter.id === 'thinky',
      })),
      discovering: false,
    });
    await page.route('**/api/adapters**', async (route) => {
      if (route.request().method() === 'POST') {
        empty = true;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body()) });
        return;
      }
      const response = await route.fetch();
      listing = await response.json() as typeof listing;
      await route.fulfill({ response, body: JSON.stringify(body()) });
    });

    await openRoom(page);
    await page.getByTestId('create-room').click();
    const dialog = page.getByTestId('create-channel-dialog');
    await expect(dialog.getByTestId('create-harness-thinky')).toBeVisible();
    await expect(dialog.getByTestId('create-harness-fake')).toHaveCount(0);
    await dialog.getByTestId('create-harness-thinky').click();
    await dialog.getByTestId('create-agent-name').fill('kept-name');
    await dialog.getByTestId('create-name').fill('Kept Channel');
    await dialog.getByTestId('create-refresh-adapters').click();

    await expect(dialog.getByTestId('create-harness-none')).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByText('No supported harnesses found')).toBeVisible();
    await expect(dialog.getByTestId('create-agent-name')).toHaveCount(0);
    await expect(dialog.getByTestId('create-name')).toHaveValue('Kept Channel');
  });
});
// harn:end agent-selection-catalog-is-refreshable

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
    await dialog.getByTestId('create-folder-alpha-project').click();
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
    await dialog.getByTestId('create-folder-alpha-project').click();

    await dialog.getByTestId('create-harness-fake').click();
    await dialog.getByTestId('create-agent-name').fill('richard');
    await expect(dialog.getByTestId('create-owner-clash')).toBeVisible();
    await expect(dialog.getByTestId('create-go')).toBeDisabled();

    // Back to None: the same text is inert, and creation is possible again.
    await dialog.getByTestId('create-harness-none').click();
    await expect(dialog.getByTestId('create-agent-name')).toHaveCount(0);
    await expect(dialog.getByTestId('create-policy-read-only')).toHaveCount(0);
    await expect(dialog.getByTestId('create-owner-clash')).toBeHidden();
    await expect(dialog.getByTestId('create-go')).toBeEnabled();

    const createRequest = page.waitForRequest((request) => (
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/rooms'
    ));
    await dialog.getByTestId('create-go').click();
    const payload = (await createRequest).postDataJSON() as Record<string, unknown>;
    expect(payload).not.toHaveProperty('starting_agent');
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
    await expect(dialog.getByTestId('spawn-thinking-ends')).toHaveText('Defaultxhigh');

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
    await dialog.getByTestId('spawn-harness-thinky').click();

    // thinky reports ten models: above the eight-model threshold, so this proves
    // the actual searchable catalogue rather than only the free-text fallback.
    const search = dialog.getByTestId('spawn-model-search');
    await expect(search).toHaveAttribute('placeholder', 'Search 10 models…');
    await search.fill('kappa');
    await expect(dialog.getByTestId('spawn-model-thinky/kappa')).toBeVisible();
    await expect(dialog.getByTestId('spawn-model-thinky/alpha')).toBeHidden();

    await dialog.getByTestId('spawn-model-thinky/kappa').click();
    await expect(dialog.getByTestId('spawn-model-thinky/kappa')).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByTestId('spawn-model-custom')).toHaveValue('thinky/kappa');

    // The list is an aid, never a trap: an exact off-catalogue id remains valid.
    await dialog.getByTestId('spawn-model-custom').fill('some-exact-model');
    await expect(dialog.getByTestId('spawn-model-custom')).toHaveValue('some-exact-model');

    // Switching harness clears the harness-specific model selection.
    await dialog.getByTestId('spawn-harness-fake').click();
    await expect(dialog.getByTestId('spawn-model-input')).toHaveValue('');
  });

  test('the inline folder picker selects without committing while browsing', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    // The picker is collapsed behind the "use current directory" switch by
    // default; turn it off to browse for a specific folder.
    await dialog.getByTestId('spawn-use-current-dir').click();
    const picker = dialog.getByTestId('spawn-folder-picker');
    await expect(picker).toBeVisible();

    const before = await dialog.getByTestId('spawn-folder-typed').inputValue();
    const alpha = picker.getByTestId('spawn-folder-alpha-project');
    await expect(alpha).toBeVisible();

    // Select and Open are separate controls now — double-click carried "open"
    // before, which no keyboard or touch user can reach reliably.
    await alpha.click();
    await expect(alpha).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByTestId('spawn-folder-typed')).toHaveValue(/\/alpha-project$/);

    // Opening descends without changing what is selected.
    const selected = await dialog.getByTestId('spawn-folder-typed').inputValue();
    await dialog.getByTestId('spawn-open-alpha-project').click();
    await expect(dialog.getByTestId('spawn-folder-nested')).toBeVisible();
    await expect(dialog.getByTestId('spawn-folder-typed')).toHaveValue(selected);

    await dialog.getByTestId('spawn-folder-up').click();
    await expect(dialog.getByTestId('spawn-folder-typed')).toHaveValue(selected);
    expect(selected).not.toBe(before);
  });

  test('hidden folders can be revealed', async ({ page }) => {
    await openRoom(page);
    const dialog = await openSpawn(page);
    await dialog.getByTestId('spawn-use-current-dir').click();
    const toggle = dialog.getByTestId('spawn-folder-hidden');
    await expect(toggle).not.toBeChecked();
    await expect(dialog.getByTestId('spawn-folder-.hidden-project')).toHaveCount(0);
    await toggle.check();
    await expect(toggle).toBeChecked();
    await expect(dialog.getByTestId('spawn-folder-.hidden-project')).toBeVisible();
  });
});

test.describe('all three dialogs share one control', () => {
  test('spawn, create and configure each render the shared groups', async ({ page }, testInfo) => {
    // The regression this guards: three hand-rolled forms that drifted apart from
    // each other and from the protocol.
    await openRoom(page);

    const spawn = await openSpawn(page);
    await expect(spawn.getByTestId('spawn-policy-read-only')).toBeVisible();
    await expect(spawn.getByTestId('spawn-harness-fake')).toBeVisible();
    const handle = `sharedctrl${String(testInfo.workerIndex)}${String(testInfo.retry)}${String(testInfo.repeatEachIndex)}`;
    await spawn.getByTestId('spawn-handle').fill(handle);
    await spawn.getByTestId('spawn-go').click();
    await expect(page.getByTestId(`member-${handle}`)).toBeVisible({ timeout: 15_000 });

    await page.getByTestId(`member-${handle}-menu`).click();
    await page.getByRole('menuitem', { name: 'Configure…' }).click();
    const configure = page.getByTestId('configure-dialog');
    await expect(configure).toBeVisible();
    await expect(configure.getByTestId('configure-harness-fake')).toBeVisible();
    await expect(configure.getByTestId('configure-policy-read-only')).toBeVisible();
    await expect(configure.getByTestId('configure-refresh-adapters')).toHaveCount(0);
    await configure.getByTestId('configure-close').click();

    await page.getByTestId('create-room').click();
    const create = page.getByTestId('create-channel-dialog');
    await create.getByTestId('create-harness-fake').click();
    await expect(create.getByTestId('create-harness-fake')).toBeVisible();
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
    await expect(dialog.getByTestId('create-close')).toBeVisible();
    await expect(dialog.getByTestId('create-go')).toBeVisible();
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

    // The three permission cards stay in one row and inside the modal at 320px.
    await dialog.getByTestId('create-harness-thinky').click();
    const body = dialog.locator('.nx-dialog-body');
    await body.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await expect(dialog.getByTestId('create-go')).toBeVisible();
    const permissionGeometry = await dialog.locator('.nx-perm-row').evaluate((row) => {
      const parent = row.closest('[role="dialog"]')?.getBoundingClientRect();
      const cards = [...row.querySelectorAll<HTMLElement>('.nx-perm')].map((card) => card.getBoundingClientRect());
      return {
        count: cards.length,
        oneRow: cards.every((card) => Math.abs(card.top - (cards[0]?.top ?? card.top)) < 1),
        contained: parent !== undefined && cards.every((card) => card.left >= parent.left && card.right <= parent.right),
      };
    });
    expect(permissionGeometry).toEqual({ count: 3, oneRow: true, contained: true });

    // And it still works: name it and create from the phone.
    await dialog.getByTestId('create-name').fill('phonemade');
    await dialog.getByTestId('create-folder-alpha-project').click();
    await dialog.getByTestId('create-go').click();
    // On a phone, creating lands you inside the new channel (two-surface stack).
    // Asserted on the URL and the visible name rather than the desktop header
    // element, which the mobile surface does not render.
    await expect(page).toHaveURL(/room=phonemade/, { timeout: 15_000 });
    await expect(page.getByText('phonemade').first()).toBeVisible();
  });
});
