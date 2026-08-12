import { expect, test, type Locator, type Page } from '@playwright/test';

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

  test('a diff chip opens the stored run diff without reading the current tree', async ({ page }) => {
    await openRoom(page, FIXTURES);
    const batch = page.getByTestId('tool-batch');
    await batch.locator('.nx-batch-line').click();
    await batch.locator('.nx-tool', { hasText: 'session.ts' }).click();
    const dialog = page.getByTestId('historical-diff-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Saved with this run');
    await expect(dialog.getByRole('navigation', { name: 'Stored diff files' }))
      .toContainText('src/auth/session.ts');
    await expect(dialog.getByTestId('diff-view')).toContainText('refreshTtlSeconds');
    await expect(page.getByTestId('diff-files')).toHaveCount(0);
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
    const nova = page.getByTestId('member-nova');
    await expect(nova).toBeVisible();
    await expect(nova.getByTestId('member-nova-row-primary').locator('.nx-member-state-mark'))
      .toHaveAccessibleName('Idle @nova');
  });

  // harn:assume acp-v1-events-and-capabilities-are-negotiated ref=acp-browser-regression
  // harn:assume acp-launch-is-structured-authorized-and-bounded ref=acp-launch-regression
  test('offers the generic custom ACP command behind Advanced with executable and literal argv fields', async ({ page }) => {
    // The fixture registers the generic configurable `acp` transport; it is not a
    // primary tile — it lives inside the Advanced disclosure as Custom ACP command.
    await openRoom(page);
    await page.getByTestId('spawn-agent').click();
    const dialog = page.getByTestId('spawn-dialog');
    await expect(dialog.getByTestId('spawn-acp-launch')).toHaveCount(0); // hidden until chosen
    await dialog.getByTestId('spawn-advanced').locator('summary').click();
    await dialog.getByTestId('spawn-advanced').getByTestId('spawn-harness-acp').click();
    await expect(dialog.getByTestId('spawn-advanced').getByTestId('spawn-harness-acp'))
      .toHaveAttribute('aria-pressed', 'true');
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

// harn:assume agent-selection-shows-detected-acp-and-advanced-custom ref=detected-acp-browser-regression
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
// harn:end agent-selection-shows-detected-acp-and-advanced-custom

test.describe('usage limits', () => {
  test('member cards show the harness-reported windows; agents without reports show none', async ({ page }) => {
    await openRoom(page);
    const limits = page.getByTestId('member-fable-limits');
    // A window without a percentage keeps the text pill…
    await expect(limits.locator('.nx-limit')).toContainText('5h: allowed · resets');
    // …windows with used_percent render % LEFT gauges, tinted by what remains.
    const warn = limits.locator('.nx-gauge.is-warn');
    await expect(warn).toContainText('7d');
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

  test('keeps two compact rows, labelled icon actions, and usage in a readable order', async ({ page }) => {
    await openRoom(page, '/?room=context-reset&token=next-e2e-token');
    const card = page.getByTestId('member-eraser');
    const header = page.getByTestId('member-eraser-header');
    const primary = page.getByTestId('member-eraser-row-primary');
    const secondary = page.getByTestId('member-eraser-row-secondary');
    const metadata = page.getByTestId('member-eraser-metadata');
    const actions = page.getByTestId('member-eraser-context-actions');
    await expect(metadata).toContainText('kept-model');
    await expect(metadata.getByRole('img', { name: 'fake harness' })).toBeVisible();
    await expect(metadata.getByRole('img', { name: 'Policy: Workspace write' })).toBeVisible();
    await expect(metadata).not.toContainText('workspace-write');
    await expect(actions.getByTestId('member-eraser-compact')).toHaveText('');
    await expect(actions.getByTestId('member-eraser-clear-context')).toHaveText('');
    await expect(actions.getByTestId('member-eraser-compact'))
      .toHaveAccessibleName("Compact @eraser's context");
    await expect(actions.getByTestId('member-eraser-clear-context'))
      .toHaveAccessibleName("Clear @eraser's context");
    await expect(actions.getByTestId('member-eraser-menu')).toBeVisible();

    const headerBox = (await header.boundingBox())!;
    const primaryBox = (await primary.boundingBox())!;
    const secondaryBox = (await secondary.boundingBox())!;
    const actionBox = (await actions.boundingBox())!;
    expect(secondaryBox.y).toBeGreaterThan(primaryBox.y);
    expect(secondaryBox.y + secondaryBox.height).toBeLessThanOrEqual(headerBox.y + headerBox.height);
    expect(actionBox.x).toBeGreaterThanOrEqual(secondaryBox.x);
    expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(secondaryBox.x + secondaryBox.width);

    await openRoom(page);
    const fableHeader = page.getByTestId('member-fable-header');
    const fableActions = page.getByTestId('member-fable-context-actions');
    const ring = page.getByTestId('member-fable-context-window');
    const limits = page.getByTestId('member-fable-limits');
    await expect(ring).toHaveAttribute('title', /tokens/);
    await expect(fableActions).not.toContainText('tokens');
    const fableHeaderBox = (await fableHeader.boundingBox())!;
    const limitsBox = (await limits.boundingBox())!;
    expect(limitsBox.y).toBeGreaterThanOrEqual(fableHeaderBox.y + fableHeaderBox.height);
  });
});
// harn:end member-context-window-meter-derived-from-last-usage

// harn:assume agent-member-card-composes-two-compact-rows ref=member-card-compact-rows-regression
test.describe('member card responsive presentation', () => {
  // harn:assume controls-fit-the-surface-they-sit-on ref=control-fits-narrow-surface
  // harn:assume web-room-targets-meet-minimum-hit-size ref=room-target-size-sweep
  test('keeps two single-line rows and fixed icon actions at desktop and phone widths', async ({ page }) => {
    const assertControlRow = async (card: Locator, phone: boolean): Promise<void> => {
      const header = card.getByTestId('member-fable-header');
      const primary = card.getByTestId('member-fable-row-primary');
      const secondary = card.getByTestId('member-fable-row-secondary');
      const metadata = card.getByTestId('member-fable-metadata');
      const actions = card.getByTestId('member-fable-context-actions');
      const targets = [
        card.locator('.nx-member-context-ring'),
        card.getByTestId('member-fable-compact'),
        card.getByTestId('member-fable-clear-context'),
        card.getByTestId('member-fable-menu'),
      ];
      const boxes = await Promise.all(targets.map(async (target) => {
        const box = await target.boundingBox();
        expect(box).not.toBeNull();
        return box!;
      }));
      const centers = boxes.map((box) => box.y + box.height / 2);
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);

      await expect(metadata.getByRole('img', { name: /harness$/ })).toBeVisible();
      await expect(card.getByTestId('member-fable-compact')).toHaveText('');
      await expect(card.getByTestId('member-fable-clear-context')).toHaveText('');
      await expect(card.getByTestId('member-fable-compact')).toHaveAccessibleName("Compact @fable's context");
      await expect(card.getByTestId('member-fable-clear-context')).toHaveAccessibleName("Clear @fable's context");

      const menuButton = card.getByTestId('member-fable-menu');
      await menuButton.click();
      const menu = card.getByRole('menu', { name: '@fable actions' });
      const rename = menu.getByRole('menuitem', { name: 'Rename…' });
      await expect(menu).toBeVisible();
      await expect(rename).toBeVisible();
      expect(await rename.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2,
        );
        return hit === element || element.contains(hit);
      })).toBe(true);
      await menuButton.click();
      await expect(menu).toHaveCount(0);

      const usageMetrics = card.getByTestId('member-fable-usage').locator('.nx-member-metric');
      await expect(usageMetrics).toHaveCount(3);
      await expect(usageMetrics.nth(0)).toHaveText(/^\d+(?:\.\d+)?[KMB]?$/);
      await expect(usageMetrics.nth(1)).toHaveText(/^[~$\d.,KMB+ ]+$/);
      await expect(usageMetrics.nth(2)).toHaveText(/^\d+$/);
      const costTitle = await usageMetrics.nth(1).getAttribute('title');
      expect(costTitle).toMatch(/^Cost: /);
      await expect(usageMetrics.nth(1)).toHaveAccessibleName(costTitle!);
      await expect(usageMetrics.nth(1)).not.toContainText(/est\.|exact|unpriced tokens/i);
      for (let index = 0; index < 3; index += 1) {
        await expect(usageMetrics.nth(index).locator(':scope > span')).toHaveCount(1);
        await expect(usageMetrics.nth(index).locator(':scope > svg')).toHaveCount(1);
        expect(await usageMetrics.nth(index).evaluate((metric) =>
          Array.from(metric.children).map((child) => child.tagName.toLowerCase()),
        )).toEqual(['span', 'svg']);
      }

      const cardBox = (await card.boundingBox())!;
      const headerBox = (await header.boundingBox())!;
      const primaryBox = (await primary.boundingBox())!;
      const secondaryBox = (await secondary.boundingBox())!;
      const actionsBox = (await actions.boundingBox())!;
      expect(primaryBox.y).toBeLessThan(secondaryBox.y);
      expect(secondaryBox.y + secondaryBox.height).toBeLessThanOrEqual(headerBox.y + headerBox.height);
      expect(actionsBox.y).toBeGreaterThanOrEqual(secondaryBox.y);
      expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(secondaryBox.y + secondaryBox.height);
      expect(actionsBox.x).toBeGreaterThanOrEqual(cardBox.x);
      expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
      if (phone) {
        await expect(metadata).toHaveCSS('overflow-x', 'auto');
        for (const box of boxes) {
          expect(box.width).toBeGreaterThanOrEqual(44);
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.x).toBeGreaterThanOrEqual(cardBox.x);
          expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
        }
      }
    };

    await page.setViewportSize({ width: 1440, height: 900 });
    await openRoom(page);
    await assertControlRow(page.getByTestId('member-fable'), false);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(ROOM);
    await expect(page.getByTestId('timeline')).toBeVisible();
    await page.getByTestId('mobile-kebab').click();
    const sheet = page.getByTestId('mobile-context');
    await assertControlRow(sheet.getByTestId('member-fable'), true);

    const pageWidth = await page.evaluate(() => ({ innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(pageWidth.scrollWidth).toBeLessThanOrEqual(pageWidth.innerWidth);

    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).include('[data-testid="member-fable"]').analyze();
    expect(violations).toEqual([]);
  });
});
// harn:end web-room-targets-meet-minimum-hit-size
// harn:end controls-fit-the-surface-they-sit-on
// harn:end agent-member-card-composes-two-compact-rows

test.describe('manual compaction', () => {
  const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

  const control = async <T = unknown>(path: string, body: unknown = {}): Promise<T> => {
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
    await expect(page.getByTestId('member-fable-row-primary').locator('.nx-member-state-mark'))
      .toHaveAccessibleName('Working @fable', { timeout: 15_000 });

    const compact = page.getByTestId('member-fable-compact');
    await expect(compact).toBeDisabled();
    await expect(compact).toHaveAttribute(
      'title', /Stop the run first — compacting mid-turn would race the engine/,
    );

    // Leave the room as found: stop the run and let fable settle back to idle.
    await page.getByTestId('member-fable-stop').click();
    await expect(page.getByTestId('member-fable-row-primary').locator('.nx-member-state-mark'))
      .toHaveAccessibleName('Idle @fable', { timeout: 15_000 });
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

// harn:assume member-context-reset-is-authorized-atomic-and-lazy ref=clear-context-browser-regression
test.describe('clear member context', () => {
  const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
  const control = async (path: string, body: unknown = {}): Promise<void> => {
    const response = await fetch(`${CONTROL}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path} failed: ${await response.text()}`);
    return (await response.json()) as T;
  };

  // harn:assume context-reset-confirmation-is-anchored-and-member-local ref=clear-context-direct-browser-regression
  test('anchors a non-modal confirmation, correlates failure, and starts fresh lazily', async ({ page }) => {
    await openRoom(page, '/?room=context-reset&token=next-e2e-token');
    const card = page.getByTestId('member-eraser');
    const clear = page.getByTestId('member-eraser-clear-context');
    await expect(clear).toBeEnabled();
    await expect(clear).toHaveAccessibleName("Clear @eraser's context");
    await expect(card.getByTestId('member-eraser-tasks')).toContainText('Old native-session task');

    await clear.click();
    const confirmation = card.getByTestId('clear-context-confirmation');
    await expect(page.getByTestId('clear-context-dialog')).toHaveCount(0);
    await expect(confirmation).toContainText("permanently discards the agent's native session memory");
    await expect(confirmation).toContainText('Channel history, identity, configuration, usage limits, and spend remain');
    await expect(confirmation.getByTestId('clear-context-confirm')).toBeFocused();

    // Escape restores the trigger; an outside pointer closes without dispatching
    // and leaves the newly chosen composer target available to receive focus.
    await page.keyboard.press('Escape');
    await expect(confirmation).toHaveCount(0);
    await expect(clear).toBeFocused();
    await clear.click();
    await page.getByTestId('composer-input').click();
    await expect(card.getByTestId('clear-context-confirmation')).toHaveCount(0);
    await expect(page.getByTestId('composer-input')).toBeFocused();

    await clear.click();
    const confirm = card.getByTestId('clear-context-confirm');
    await control('/fail-reset');
    await confirm.click();
    await expect(card.getByTestId('clear-context-confirmation')).toHaveCount(0);
    await expect(clear).toBeVisible();
    await expect(card.getByTestId('member-eraser-clear-error')).toContainText('fixture native retirement failed');
    await expect(card.getByTestId('member-eraser-clear-retry')).toBeVisible();
    await expect(card.getByTestId('member-eraser-tasks')).toBeVisible();

    // While retirement is held, duplicate input cannot send another act and the
    // old ring/control remain until the authoritative member frame clears them.
    const beforeAttempts = (await control<{ attempts: number }>('/reset-stats')).attempts;
    await control('/hold-resets');
    await clear.click();
    await card.getByTestId('clear-context-confirm').click();
    await expect(card.getByTestId('clear-context-confirmation')).toHaveCount(0);
    const pending = card.getByTestId('member-eraser-clear-context');
    await expect(pending).toHaveAttribute('data-clearing', 'true');
    await pending.click({ force: true });
    await pending.click({ force: true });
    await expect(clear).toBeVisible();
    // An unrelated compact_member refusal lands in the same room while reset
    // remains held. Its correlated UI action recovers, but Clear stays pending.
    const compact = page.getByTestId('member-eraser-compact');
    await compact.click({ force: true });
    await expect(compact).toBeEnabled();
    expect((await control<{ attempts: number }>('/reset-stats')).attempts).toBe(beforeAttempts + 1);
    await control('/hold-resets', { held: false });
    await expect(clear).toHaveCount(0);
    await expect(card.getByTestId('member-eraser-tasks')).toHaveCount(0);
    await expect(card).toContainText('kept-model');

    // Clear itself did not start a native session. The first addressed delivery
    // does, receives the re-armed briefing, and makes the saved-session control
    // available again without a document reload.
    await control('/enqueue', { turns: [{ kind: 'complete', final_text: '<ACK_OK>' }] });
    await page.getByTestId('composer-input').fill('@eraser first fresh delivery');
    await page.getByTestId('composer-send').click();
    await expect(page.getByTestId('member-eraser-clear-context')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('connection')).toHaveText(/Connected/);
  });
  // harn:end context-reset-confirmation-is-anchored-and-member-local

  // harn:assume context-reset-confirmation-is-anchored-and-member-local ref=clear-context-mobile-a11y-regression
  // harn:assume web-room-targets-meet-minimum-hit-size ref=clear-context-mobile-target-regression
  // harn:assume controls-fit-the-surface-they-sit-on ref=clear-context-mobile-fit-regression
  test('keeps the anchored surface bounded and axe-clean on a 390px phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?room=context-reset&token=next-e2e-token');
    await expect(page.getByTestId('timeline')).toBeVisible();
    await page.getByTestId('mobile-kebab').click();
    const card = page.getByTestId('member-eraser');
    const clear = card.getByTestId('member-eraser-clear-context');
    await clear.click();
    const confirmation = card.getByTestId('clear-context-confirmation');
    const box = await confirmation.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    for (const id of ['clear-context-cancel', 'clear-context-confirm']) {
      const target = confirmation.getByTestId(id);
      const targetBox = await target.boundingBox();
      expect(targetBox).not.toBeNull();
      expect(targetBox!.width).toBeGreaterThanOrEqual(44);
      expect(targetBox!.height).toBeGreaterThanOrEqual(44);
    }
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      const { violations } = await new AxeBuilder({ page })
        .include('[data-testid="clear-context-confirmation"]')
        .analyze();
      expect(violations).toEqual([]);
    }
  });
  // harn:end controls-fit-the-surface-they-sit-on
  // harn:end web-room-targets-meet-minimum-hit-size
  // harn:end context-reset-confirmation-is-anchored-and-member-local
});
// harn:end member-context-reset-is-authorized-atomic-and-lazy

// harn:assume dead-agent-surfaces-revive-in-its-action-area ref=member-revive-regression
test.describe('member lifecycle', () => {
  test('a dead agent swaps the disabled Compact for a direct Revive that brings it back', async ({ page }) => {
    await openRoom(page);
    const fable = page.getByTestId('member-fable');
    await expect(fable.getByTestId('member-fable-row-primary').locator('.nx-member-state-mark'))
      .toHaveAccessibleName('Idle @fable');
    // Alive: Compact is present in the action area; Revive is not.
    await expect(page.getByTestId('member-fable-compact')).toBeVisible();
    await expect(page.getByTestId('member-fable-revive')).toHaveCount(0);

    // Kill via the overflow menu (still available for a live agent).
    await page.getByTestId('member-fable-menu').click();
    await page.locator('.nx-menu button', { hasText: 'Kill…' }).click();
    await page.getByTestId('member-confirm-go').click();
    await expect(fable.getByTestId('member-fable-row-primary').locator('.nx-member-state-mark'))
      .toHaveAccessibleName('Dead @fable');

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
    await expect(fable.getByTestId('member-fable-row-primary').locator('.nx-member-state-mark'))
      .toHaveAccessibleName('Idle @fable', { timeout: 10_000 });

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
