import { expect, test, type Page } from '@playwright/test';

const ROOM = '/?room=eng&token=next-e2e-token';
// The tool-evidence tests read a seeded run, so they open the stable fixtures
// room rather than paging eng's growing history back to reach the same run.
const FIXTURES = '/?room=fixtures&token=next-e2e-token';

async function openRoom(page: Page, url = ROOM): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

test.describe('diff tab', () => {
  test('a repo with no working changes shows the clean working-tree state', async ({ page }) => {
    // eng's agents run in a plain (non-git) cwd, so the live git tab reads clean —
    // the diff tab now mirrors the repository, not historical run evidence.
    await openRoom(page);
    await page.getByTestId('context-tab-diff').click();
    await expect(page.getByTestId('diff-clean')).toContainText('Working tree clean');
  });

  test('preview tab shows the dot-grid empty state without artifacts', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('context-tab-preview').click();
    await expect(page.getByTestId('preview-empty')).toContainText('Nothing to preview yet');
  });
});

test.describe('run inspector', () => {
  test('a non-diff tool card opens the inspector with output and no diff pane', async ({ page }) => {
    await openRoom(page, FIXTURES);
    const batch = page.getByTestId('tool-batch');
    await batch.locator('.nx-batch-line').click();
    await batch.locator('.nx-tool', { hasText: 'pnpm test' }).click();
    const inspector = page.getByTestId('run-inspector');
    await expect(inspector).toBeVisible();
    await expect(inspector.getByTestId('inspector-output')).toContainText('42 passed');
    await expect(inspector.getByTestId('diff-view')).toHaveCount(0); // diff pane dropped
    await page.keyboard.press('Escape');
    await expect(inspector).toBeHidden();
  });

  test('a diff chip routes to the Diff tab, noting no current changes when clean', async ({ page }) => {
    await openRoom(page, FIXTURES);
    const batch = page.getByTestId('tool-batch');
    await batch.locator('.nx-batch-line').click();
    await batch.locator('.nx-tool', { hasText: 'session.ts' }).click();
    // The chip opens the live Diff tab focused on that file; eng's tree is clean.
    await expect(page.getByTestId('diff-no-current')).toContainText('session.ts');
  });
});

test.describe('spawn dialog', () => {
  test('traps focus, requires its fields, and spawns into the roster', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('spawn-agent').click();
    const dialog = page.getByTestId('spawn-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('spawn-go')).toBeDisabled();

    // Tab cycles stay inside the dialog.
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
    const focusInside = await page.evaluate(() =>
      document.querySelector('[data-testid="spawn-dialog"]')?.contains(document.activeElement),
    );
    expect(focusInside).toBe(true);

    await dialog.getByTestId('spawn-handle').fill('nova');
    await dialog.getByTestId('spawn-use-current-dir').click();
    await dialog.getByTestId('spawn-folder-typed').fill('/tmp');
    await expect(dialog.getByTestId('spawn-go')).toBeEnabled();
    await dialog.getByTestId('spawn-go').click();
    await expect(page.getByTestId('member-nova')).toBeVisible();
    await expect(page.getByTestId('member-nova')).toContainText('Idle');
  });

  // harn:assume acp-v1-events-and-capabilities-are-negotiated ref=acp-browser-regression
  // harn:assume acp-launch-is-structured-authorized-and-bounded ref=acp-launch-regression
  test('offers configurable ACP with explicit executable and literal argv fields', async ({ page }) => {
    await page.route('**/api/adapters**', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const listing = await response.json() as { adapters: unknown[]; discovering?: boolean };
      await route.fulfill({
        response,
        body: JSON.stringify({
          ...listing,
          adapters: [...listing.adapters, {
            id: 'acp', installed: false, configurable: true,
            capabilities: {
              resume: false, discover: false, interactiveAttach: false, ask: false,
              approvals: 'runtime', extensions: false, thinking: false, live_inbox: false,
              policies: { 'read-only': null, 'workspace-write': null, 'full-access': null },
            },
          }],
        }),
      });
    });
    await openRoom(page);
    await page.getByTestId('spawn-agent').click();
    const dialog = page.getByTestId('spawn-dialog');
    await dialog.getByTestId('spawn-harness-acp').click();
    await expect(dialog.getByTestId('spawn-harness-acp')).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByTestId('spawn-acp-launch')).toBeVisible();
    await expect(dialog.getByTestId('spawn-acp-executable')).toHaveValue('');
    await expect(dialog.getByTestId('spawn-acp-executable')).toHaveAttribute('placeholder', 'e.g. kimi');
    await expect(dialog.getByTestId('spawn-acp-args')).toHaveAttribute(
      'placeholder', 'acp\n--profile=x',
    );
    await expect(dialog.getByTestId('spawn-model-input')).toHaveCount(0);
    await dialog.getByTestId('spawn-handle').fill('acp-helper');
    await dialog.getByTestId('spawn-use-current-dir').click();
    await dialog.getByTestId('spawn-folder-typed').fill('/tmp');
    await expect(dialog.getByTestId('spawn-go')).toBeDisabled();
    await dialog.getByTestId('spawn-acp-executable').fill('/opt/acp agent');
    await dialog.getByTestId('spawn-acp-args').fill('acp\n--profile=x');
    await expect(dialog.getByTestId('spawn-go')).toBeEnabled();
    await expect(dialog.getByText('Shell syntax is not evaluated.')).toBeVisible();
  });
  // harn:end acp-launch-is-structured-authorized-and-bounded
  // harn:end acp-v1-events-and-capabilities-are-negotiated
});

test.describe('spawn before adapter discovery', () => {
  test('the dialog adopts adapters when they arrive instead of staying dead', async ({ page }) => {
    // The dialog used to snapshot the first adapter at mount. Opened before
    // /api/adapters resolved it captured '' permanently: options appeared a
    // moment later, but the selection never caught up and Spawn stayed
    // disabled forever. In isolation discovery simply won the race.
    let holding = true;
    await page.route('**/api/adapters**', async (route) => {
      while (holding) await new Promise((resolve) => setTimeout(resolve, 50));
      await route.continue();
    });

    await page.goto(ROOM);
    await expect(page.getByTestId('timeline')).toBeVisible();
    await page.getByTestId('spawn-agent').click();
    const dialog = page.getByTestId('spawn-dialog');
    await expect(dialog).toBeVisible();

    // Fill everything a human can fill while the harness list is still absent.
    await dialog.getByTestId('spawn-handle').fill('lateling');
    await dialog.getByTestId('spawn-use-current-dir').click();
    await dialog.getByTestId('spawn-folder-typed').fill('/tmp');
    await expect(dialog.getByTestId('spawn-go')).toBeDisabled();

    holding = false;

    // The harness picker adopts the first adapter and the action comes alive.
    // (Harness is chosen with tiles now, not a <select>; the healing behaviour
    // this test exists for is unchanged.)
    await expect(dialog.getByTestId('spawn-harness-fake')).toHaveAttribute(
      'aria-pressed', 'true', { timeout: 15_000 },
    );
    await expect(dialog.getByTestId('spawn-go')).toBeEnabled();

    await dialog.getByTestId('spawn-go').click();
    await expect(page.getByTestId('member-lateling')).toBeVisible();
  });
});

// harn:assume agent-selection-catalog-is-refreshable ref=harness-refresh-browser-regression
test.describe('installed harness refresh', () => {
  test('Add Agent filters, shows busy and failure states, and reconciles without losing fields', async ({ page }) => {
    let listing: { adapters: { id: string; installed?: boolean }[]; discovering?: boolean } | undefined;
    let refreshed = false;
    let failRefresh = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const body = () => ({
      ...listing,
      adapters: listing!.adapters.map((adapter) => ({
        ...adapter,
        installed: refreshed ? adapter.id === 'thinky' : adapter.id === 'fake',
      })),
      discovering: false,
    });
    await page.route('**/api/adapters**', async (route) => {
      if (route.request().method() === 'POST') {
        if (failRefresh) {
          await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'refresh unavailable' }) });
          return;
        }
        await held;
        refreshed = true;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body()) });
        return;
      }
      const response = await route.fetch();
      listing = await response.json() as typeof listing;
      await route.fulfill({ response, body: JSON.stringify(body()) });
    });

    await openRoom(page);
    await page.getByTestId('spawn-agent').click();
    const dialog = page.getByTestId('spawn-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('spawn-harness-fake')).toBeVisible();
    await expect(dialog.getByTestId('spawn-harness-thinky')).toHaveCount(0);
    await dialog.getByTestId('spawn-handle').fill('kept-handle');

    const refresh = dialog.getByTestId('spawn-refresh-adapters');
    await refresh.click();
    await expect(refresh).toBeDisabled();
    await expect(refresh).toContainText('Refreshing');
    release();
    await expect(dialog.getByTestId('spawn-harness-thinky')).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByTestId('spawn-harness-fake')).toHaveCount(0);
    await expect(dialog.getByTestId('spawn-handle')).toHaveValue('kept-handle');

    failRefresh = true;
    await refresh.click();
    await expect(dialog.getByRole('alert')).toContainText('Refresh failed: refresh unavailable');
  });
});
// harn:end agent-selection-catalog-is-refreshable

test.describe('usage limits', () => {
  test('member cards show the harness-reported windows; agents without reports show none', async ({ page }) => {
    await openRoom(page);
    const limits = page.getByTestId('member-fable-limits');
    // A window without a percentage keeps the text pill…
    await expect(limits.locator('.nx-limit')).toContainText('5h: allowed · resets');
    // …windows with used_percent render % LEFT gauges, tinted by what remains.
    const warn = limits.locator('.nx-gauge.is-warn');
    await expect(warn).toContainText('weekly');
    await expect(warn).toContainText('18% left');
    await expect(warn.locator('.nx-gauge-fill')).toHaveAttribute('style', /width: 18%/);
    const ok = limits.locator('.nx-gauge.is-ok');
    await expect(ok).toContainText('monthly');
    await expect(ok).toContainText('80% left');
    await expect(page.getByTestId('member-scout-limits')).toHaveCount(0);
  });
});

// harn:assume member-context-window-meter-derived-from-last-usage ref=context-window-meter-browser-smoke
test.describe('context window meter', () => {
  test('member cards derive the ring and tooltip from fixture telemetry', async ({ page }) => {
    await openRoom(page);

    const meter = page.getByTestId('member-fable-context-window');
    await expect(meter).toBeVisible();
    await expect(meter).toHaveClass(/is-amber/);
    await expect(meter).toHaveAttribute('data-percentage', '75');
    await expect(meter).toHaveAttribute('title', /150K \/ 200K tokens · Session cost: \$0\.04/);

    await expect(page.getByTestId('member-scout-context-window')).toHaveClass(/is-pending/);
    await expect(page.getByTestId('member-hydrate-context-window')).toHaveCount(0);
  });
});
// harn:end member-context-window-meter-derived-from-last-usage

test.describe('manual compaction', () => {
  const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

  const control = async (path: string, body: unknown = {}): Promise<void> => {
    const res = await fetch(`${CONTROL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} failed: ${await res.text()}`);
  };

  test('compacting shows busy, then lands a new ring reading and re-enables', async ({ page }) => {
    // Hold the compaction so the in-flight state is a fact this test controls,
    // and stage a re-baseline well below fable's seeded 150K/200K.
    await control('/hold-compactions', {
      usage: { contextWindowMaxTokens: 200_000, contextWindowUsedTokens: 40_000 },
    });
    try {
      await openRoom(page);
      const ring = page.getByTestId('member-fable-context-window');
      await expect(ring).toHaveAttribute('data-percentage', '75');

      const compact = page.getByTestId('member-fable-compact');
      await expect(compact).toBeEnabled(); // fable is idle
      await compact.click();

      // Busy: the operator has evidence their click did something.
      await expect(compact).toHaveAttribute('data-compacting', 'true');
      await expect(compact).toBeDisabled();
      await expect(compact).toHaveAttribute('title', /Compacting this agent/);

      await control('/hold-compactions', { held: false });

      // The ring re-reads from the engine's re-baseline and the lever returns.
      await expect(ring).toHaveAttribute('data-percentage', '20');
      await expect(compact).toBeEnabled();
      await expect(compact).not.toHaveAttribute('data-compacting', 'true');
    } finally {
      await control('/hold-compactions', { held: false }); // leave nothing parked
    }
  });

  test('a running agent keeps the lever, disabled, and says why', async ({ page }) => {
    // A turn this test CREATES, not one it finds: @scout carries the harness's
    // seeded long-running fixture, so asserting there would pass on a state the
    // test never made — and stopping it would destroy a shared fixture.
    await control('/enqueue', { turns: [{ kind: 'fail-on-interrupt' }] });
    await openRoom(page);
    await page.getByTestId('composer-input').fill('@fable hold this turn open');
    await page.getByTestId('composer-send').click();
    await expect(page.getByTestId('member-fable')).toContainText('Working', { timeout: 15_000 });

    const compact = page.getByTestId('member-fable-compact');
    await expect(compact).toBeDisabled();
    await expect(compact).toHaveAttribute(
      'title', /Stop the run first — compacting mid-turn would race the engine/,
    );

    // Leave the room as found: stop the run and let fable settle back to idle.
    await page.getByTestId('member-fable-stop').click();
    await expect(page.getByTestId('member-fable')).toContainText('Idle', { timeout: 15_000 });
  });

  test('a non-privileged member is not offered the lever at all', async ({ page }) => {
    await page.goto('/?room=eng&token=next-e2e-viewer-token');
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.getByTestId('connection')).toHaveText(/Connected/);
    // Role gating is absence, not a disabled control: a viewer never manages.
    await expect(page.getByTestId('member-fable-context-window')).toBeVisible();
    await expect(page.getByTestId('member-fable-compact')).toHaveCount(0);
  });

  test('the compacting state is axe-clean', async ({ page }) => {
    await control('/hold-compactions', {
      usage: { contextWindowMaxTokens: 200_000, contextWindowUsedTokens: 40_000 },
    });
    try {
      await openRoom(page);
      const compact = page.getByTestId('member-fable-compact');
      await compact.click();
      await expect(compact).toHaveAttribute('data-compacting', 'true');
      await page.waitForTimeout(300);

      const { default: AxeBuilder } = await import('@axe-core/playwright');
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
    } finally {
      await control('/hold-compactions', { held: false });
    }
  });
});

// harn:assume dead-agent-surfaces-revive-in-its-action-area ref=member-revive-regression
test.describe('member lifecycle', () => {
  test('a dead agent swaps the disabled Compact for a direct Revive that brings it back', async ({ page }) => {
    await openRoom(page);
    const fable = page.getByTestId('member-fable');
    await expect(fable).toContainText('Idle');
    // Alive: Compact is present in the action area; Revive is not.
    await expect(page.getByTestId('member-fable-compact')).toBeVisible();
    await expect(page.getByTestId('member-fable-revive')).toHaveCount(0);

    // Kill via the overflow menu (still available for a live agent).
    await page.getByTestId('member-fable-menu').click();
    await page.locator('.nx-menu button', { hasText: 'Kill…' }).click();
    await page.getByTestId('member-confirm-go').click();
    await expect(fable).toContainText('Dead');

    // Dead: the disabled Compact is gone, replaced by a direct Revive in the
    // action area — no overflow menu needed.
    await expect(page.getByTestId('member-fable-compact')).toHaveCount(0);
    const revive = page.getByTestId('member-fable-revive');
    await expect(revive).toBeVisible();
    // The control renders on defined theme tokens: its background resolves to a
    // real colour (not transparent) in both light and dark.
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      const background = await revive.evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(background).not.toBe('rgba(0, 0, 0, 0)');
      expect(background).not.toBe('transparent');
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await revive.click();
    await expect(fable).toContainText('Idle', { timeout: 10_000 });

    // Back alive: Compact returns and Revive is gone again.
    await expect(page.getByTestId('member-fable-compact')).toBeVisible();
    await expect(page.getByTestId('member-fable-revive')).toHaveCount(0);
  });
});
// harn:end dead-agent-surfaces-revive-in-its-action-area

test.describe('accessibility', () => {
  test('the context panel and open spawn dialog are axe-clean', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('spawn-agent').click();
    await expect(page.getByTestId('spawn-dialog')).toBeVisible();
    await page.waitForTimeout(350);
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
  });
});
