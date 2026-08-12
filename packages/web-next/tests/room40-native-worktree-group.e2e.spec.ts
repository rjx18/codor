// harn:assume registered-worktree-navigation-is-promotion-gated ref=worktree-group-browser-regression
// harn:assume worktree-conversation-status-is-live-and-independent ref=worktree-status-browser-regression
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const TOKEN = 'next-e2e-token';
const API = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_API_PORT ?? '28137'}`;
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

async function control<T = unknown>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw new Error(`control ${path} failed: ${response.status}`);
  return (await response.json()) as T;
}

async function openRoom(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

type RegisteredChild = {
  id: string;
  alias: string;
  branch: string;
  primary: boolean;
  conversation_id: string;
};

async function registeredWorktrees(): Promise<{
  registered: RegisteredChild[];
}> {
  const { registered } = await control<{
    registered: RegisteredChild[];
  }>('/wt-registered', { room: 'workspace' });
  return { registered };
}

async function reviewChild(page: Page): Promise<RegisteredChild> {
  const { registered } = await registeredWorktrees();
  const child = registered.find((worktree) => !worktree.primary && worktree.branch === 'feature/review');
  expect(child).toBeDefined();
  return child!;
}

async function reviewChildId(page: Page): Promise<string> {
  return (await reviewChild(page)).id;
}

async function registeredChildren(page: Page): Promise<{
  id: string;
  alias: string;
  branch: string;
  conversation_id: string;
}[]> {
  const { registered } = await registeredWorktrees();
  return registered.filter((worktree) => !worktree.primary);
}

test.describe('native worktree group navigation', () => {
  // harn:assume exact-trailing-mentions-send-before-completion ref=exact-trailing-mention-regression
  // harn:assume composer-acknowledgement-separates-raw-draft-from-canonical-echo ref=raw-draft-acknowledgement-regression
  test('an exact trailing qualified mention with raw whitespace sends once and clears on its canonical echo', async ({ page }) => {
    const review = await reviewChild(page);
    await openRoom(page, `/?room=workspace&token=${TOKEN}`);
    await expect(page.getByTestId(`worktree-link-${review.id}`)).toHaveAttribute(
      'aria-label', /Connected/, { timeout: 10_000 },
    );
    const input = page.getByTestId('composer-input');
    const raw = `please investigate ~${review.alias}:@reviewer `;
    const canonical = raw.trim();
    await input.fill(raw);
    await input.press('Enter');
    await expect.poll(async () => (await control<{ count: number }>('/room-message-count', {
      room: review.conversation_id,
      body: canonical,
    })).count).toBe(1);
    await expect(input).not.toHaveValue(raw);
    expect((await control<{ count: number }>('/room-message-count', {
      room: 'workspace',
      body: canonical,
    })).count).toBe(0);
  });
  // harn:end composer-acknowledgement-separates-raw-draft-from-canonical-echo
  // harn:end exact-trailing-mentions-send-before-completion

  // harn:assume merged-worktree-reliability-contracts-coexist ref=cross-stack-browser-regression
  test('renders worktree-qualified bounded history without a finalized journal fetch', async ({ page }) => {
    const historyRequests: string[] = [];
    const finalizedJournalRequests: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path === '/api/rooms/workspace/transcript-history') historyRequests.push(path);
      if (/^\/api\/rooms\/workspace\/runs\/\d+$/.test(path)) finalizedJournalRequests.push(path);
    });

    await openRoom(page, `/?room=workspace&token=${TOKEN}`);
    const row = page.locator('article', { hasText: 'bounded history from the review worktree' });
    await expect(row).toBeVisible();
    const review = await reviewChild(page);
    await expect(row.locator('.nx-turn-author')).toHaveText(`~${review.alias}:@reviewer`);
    await expect(row).toHaveAttribute('data-transcript-unit', /message:/);
    const id = await row.getAttribute('id');
    expect(id).toMatch(/^\d+$/);
    await expect(row.locator('.nx-permalink')).toHaveText(`#${id}`);
    await expect.poll(() => historyRequests.length).toBeGreaterThan(0);
    expect(finalizedJournalRequests).toEqual([]);
  });
  // harn:end merged-worktree-reliability-contracts-coexist

  test('first promotion keeps main selected, switches by stable id, and survives back/reload', async ({ page }) => {
    const childId = await reviewChildId(page);
    await openRoom(page, `/?room=workspace&token=${TOKEN}`);

    // Promotion: the group renders under the root row while MAIN stays selected.
    await expect(page.getByTestId('worktree-group')).toBeVisible();
    await expect(page.getByTestId(`worktree-link-${childId}`)).toBeVisible();
    expect(page.url()).not.toContain('worktree=');
    await expect(page.getByTestId('room-link-workspace')).toHaveAttribute('aria-current', 'page');

    // Independent unread: the child's seeded note is unread; the main row is not.
    await expect(page.getByTestId(`worktree-unread-${childId}`)).toBeVisible();
    await expect(page.getByTestId('rail-unread-workspace')).toHaveCount(0);

    // Selecting the child switches the conversation in place with a stable URL.
    await page.getByTestId(`worktree-link-${childId}`).click();
    await expect(page.getByTestId(`worktree-link-${childId}`)).toHaveAttribute('aria-current', 'page');
    // Exclusivity: main is a plain link while its child claims the page.
    await expect(page.getByTestId('room-link-workspace')).not.toHaveAttribute('aria-current', 'page');
    expect(page.url()).toContain(`room=workspace`);
    expect(page.url()).toContain(`worktree=${childId}`);
    await expect(page.getByTestId('timeline')).toContainText('review notes live in the child conversation');

    // The real href carries BOTH the public root and the stable child id, so
    // copied links and open-in-new-tab keep their authorization.
    const href = await page.getByTestId(`worktree-link-${childId}`).getAttribute('href');
    expect(href).toContain('room=workspace');
    expect(href).toContain(`worktree=${childId}`);

    // Back returns to main without rewriting history; reload keeps the child.
    await page.goBack();
    expect(page.url()).not.toContain('worktree=');
    await expect(page.getByTestId('room-link-workspace')).toHaveAttribute('aria-current', 'page');
    await page.goForward();
    expect(page.url()).toContain(`worktree=${childId}`);
    await page.reload();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.getByTestId(`worktree-link-${childId}`)).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('room-link-workspace')).not.toHaveAttribute('aria-current', 'page');

    // A Settings round-trip carries the public root PLUS the stable selector
    // in its history entry and returns to exactly the selected child.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    expect(page.url()).toContain('/settings');
    expect(page.url()).toContain('room=workspace');
    expect(page.url()).toContain(`worktree=${childId}`);
    await page.goBack();
    expect(page.url()).not.toContain('/settings');
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.getByTestId(`worktree-link-${childId}`)).toHaveAttribute('aria-current', 'page');

    // Open-in-new-tab equivalent: a cold load of the copied href lands on the
    // selected child with the group in place.
    await page.goto(`${href}&token=${TOKEN}`);
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.getByTestId('worktree-group')).toBeVisible();
    await expect(page.getByTestId(`worktree-link-${childId}`)).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('room-link-workspace')).not.toHaveAttribute('aria-current', 'page');
  });

  // harn:assume worktree-child-conversations-stay-nested-and-isolated ref=worktree-nested-row-browser-regression
  test('nests both children by exact branch and never promotes child summaries', async ({ page }) => {
    const children = await registeredChildren(page);
    expect(children.map((child) => child.branch)).toEqual(['feature/plan', 'feature/review']);
    await openRoom(page, `/?room=workspace&token=${TOKEN}`);
    await expect(page.getByTestId('worktree-group')).toBeVisible();

    for (const child of children) {
      await expect(page.getByTestId(`worktree-link-${child.id}`)).toBeVisible();
      expect(await page.getByTestId(`worktree-branch-${child.id}`).textContent()).toBe(child.branch);
      expect(await page.getByTestId(`worktree-branch-${child.id}`).textContent()).not.toBe(child.alias);
      await expect(page.getByTestId(`worktree-unread-${child.id}`)).toBeVisible();
      await expect(page.getByTestId(`worktree-link-${child.id}`)).toHaveAttribute(
        'aria-label',
        new RegExp(`${child.branch}; (Connected|Connecting|Unavailable|Not subscribed)`),
      );
      await expect(page.getByTestId(`worktree-connection-${child.id}`)).toHaveCount(0);
      await expect(page.getByTestId(`worktree-status-${child.id}`)).toHaveCount(0);
      await expect(page.getByTestId(`room-link-${child.conversation_id}`)).toHaveCount(0);
    }
    await expect(page.getByTestId('worktree-group')).not.toContainText('Live');

    // A reload restores the cached/registered projection without reintroducing
    // either hidden child as a top-level channel row.
    await page.reload();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.getByTestId('worktree-group')).toBeVisible();
    for (const child of children) {
      await expect(page.getByTestId(`room-link-${child.conversation_id}`)).toHaveCount(0);
    }

    const review = children.find((child) => child.branch === 'feature/review')!;
    const plan = children.find((child) => child.branch === 'feature/plan')!;
    await page.getByTestId(`worktree-link-${review.id}`).click();
    await expect(page.getByTestId('timeline')).toContainText('review notes live in the child conversation');
    await expect(page.getByTestId('timeline')).not.toContainText('plan notes live in the planning child conversation');
    await page.getByTestId(`worktree-link-${plan.id}`).click();
    await expect(page.getByTestId('timeline')).toContainText('plan notes live in the planning child conversation');
    await expect(page.getByTestId('timeline')).not.toContainText('review notes live in the child conversation');
  });
  // harn:end worktree-child-conversations-stay-nested-and-isolated

  test('moves the public root across top-level A-to-B-to-A switching and history', async ({ page }) => {
    await openRoom(page, `/?room=workspace&token=${TOKEN}`);
    await expect(page.getByTestId('worktree-group')).toBeVisible();

    // A → B: the group projection and aria-current follow the public root,
    // and the selector clears on a top-level switch.
    await page.getByTestId('room-link-wtops').click();
    expect(page.url()).toContain('room=wtops');
    expect(page.url()).not.toContain('worktree=');
    await expect(page.getByTestId('room-link-wtops')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('room-link-workspace')).not.toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('worktree-group')).toHaveCount(0);

    // Back to A: the group returns under the root row.
    await page.goBack();
    expect(page.url()).toContain('room=workspace');
    await expect(page.getByTestId('room-link-workspace')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('worktree-group')).toBeVisible();

    // Forward to B, then reload: the public root survives the reload.
    await page.goForward();
    expect(page.url()).toContain('room=wtops');
    await page.reload();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.getByTestId('room-link-wtops')).toHaveAttribute('aria-current', 'page');

    // And an ordinary channel after all of this is still ordinary.
    await page.getByTestId('room-link-eng').click();
    expect(page.url()).toContain('room=eng');
    await expect(page.getByTestId('room-link-eng')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('worktree-group')).toHaveCount(0);
  });

  // harn:assume worktree-rail-uses-branch-only-compact-status ref=worktree-branch-status-browser-regression
  test('reports independent readiness, retains rows offline, and recovers on reconnect', async ({ page }) => {
    const childId = await reviewChildId(page);
    await openRoom(page, `/?room=workspace&token=${TOKEN}`);
    await expect(page.getByTestId('worktree-group')).toBeVisible();

    // The hidden child hydrates on the multiplexed socket: connection settles
    // on its OWN sync_complete, independent of activity or unread state.
    await expect(page.getByTestId(`worktree-link-${childId}`)).toHaveAttribute(
      'aria-label', /feature\/review; (Connected|Connecting)/,
    );
    await expect(page.getByTestId(`worktree-link-${childId}`)).toHaveAttribute(
      'aria-label', /feature\/review; Connected/, { timeout: 15_000 },
    );

    // Offline (operator park drives the same disconnected state): the group
    // rows remain as last-good state, the unread badge survives, and the
    // child's connection reads offline — never masked by activity.
    await page.evaluate(() => {
      (window as unknown as { __codor: { disconnect(): void } }).__codor.disconnect();
    });
    await expect(page.getByTestId('connection')).toHaveText(/Reconnecting/, { timeout: 15_000 });
    await expect(page.getByTestId(`worktree-link-${childId}`)).toBeVisible();
    await expect(page.getByTestId(`worktree-unread-${childId}`)).toBeVisible();
    await expect(page.getByTestId(`worktree-link-${childId}`)).toHaveAttribute(
      'aria-label', /feature\/review; Unavailable/,
    );

    // Reconnect replaces the generation: the child must re-prove itself with a
    // fresh sync_complete before it reads live again.
    await page.evaluate(() => {
      (window as unknown as { __codor: { reconnect(): void } }).__codor.reconnect();
    });
    await expect(page.getByTestId('connection')).toHaveText(/Connected/, { timeout: 20_000 });
    await expect(page.getByTestId(`worktree-link-${childId}`)).toHaveAttribute(
      'aria-label', /feature\/review; Connected/, { timeout: 20_000 },
    );
  });
  // harn:end worktree-rail-uses-branch-only-compact-status

  test('leaves normal channels unchanged and hides the entry for a known non-Git cwd', async ({ page }) => {
    await openRoom(page, `/?room=eng&token=${TOKEN}`);
    await expect(page.getByTestId('worktree-group')).toHaveCount(0);

    // A KNOWN existing cwd that is not a Git repository never reveals either
    // pre-promotion entry, and the bounded read must not create a repository.
    await openRoom(page, `/?room=plain&token=${TOKEN}`);
    await page.getByTestId('context-tab-diff').click();
    await expect(page.getByTestId('worktree-entry')).toHaveCount(0);
    await expect(page.getByTestId('worktree-entry-create')).toHaveCount(0);
    const proof = await control<{ git: boolean }>('/wt-plain-git');
    expect(proof.git).toBe(false);
  });

  // harn:assume worktree-rail-is-one-line-and-working-replaces-the-branch-glyph ref=worktree-one-line-browser-regression
  // harn:assume worktree-child-menu-is-portal-and-viewport-bounded ref=worktree-menu-viewport-browser-regression
  test('fits the 390px channel surface and keeps the dropdown focus-safe', async ({ page }) => {
    const childId = await reviewChildId(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?room=workspace&token=${TOKEN}`);
    await expect(page.getByTestId('timeline')).toBeVisible();

    // Mobile is a channels ⇄ room stack: the group rows live on the channels surface.
    await page.getByTestId('mobile-back').click();
    await expect(page.getByTestId('worktree-group')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(overflow).toBeLessThanOrEqual(390);

    // Worktree switching stays reachable at phone width.
    await page.getByTestId(`worktree-link-${childId}`).click();
    await expect(page.getByTestId('timeline')).toContainText('review notes live in the child conversation');

    // The reserved action cell never overlaps the exact-branch link.
    await page.getByTestId('mobile-back').click();
    const row = page.getByTestId(`worktree-link-${childId}`);
    const trigger = page.getByTestId(`worktree-menu-trigger-${childId}`);
    const [rowBox, triggerBox] = await Promise.all([row.boundingBox(), trigger.boundingBox()]);
    expect(rowBox).not.toBeNull();
    expect(triggerBox).not.toBeNull();
    expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(triggerBox!.x + 1);

    // Focus enters the anchored dropdown and Escape returns it to the opener.
    await trigger.click();
    const menu = page.getByTestId(`worktree-menu-${childId}`);
    await expect(menu).toBeVisible();
    const assertMenuInViewport = async (): Promise<void> => {
      const box = await menu.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual((await page.evaluate(() => innerWidth)));
      expect(box!.y + box!.height).toBeLessThanOrEqual((await page.evaluate(() => innerHeight)));
      expect(await menu.evaluate((element) => ({
        position: getComputedStyle(element).position,
        inBody: element.parentElement === document.body,
      }))).toEqual({ position: 'fixed', inBody: true });
    };
    await assertMenuInViewport();
    await expect(menu.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // Outside pointerdown closes the same popup and restores focus.
    await trigger.click();
    await expect(menu).toBeVisible();
    await assertMenuInViewport();
    await page.getByTestId('worktree-group').locator('.nx-wt-group-label').click();
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // The same fixed menu flips/clamps in a short desktop viewport, not just
    // on the phone rail. The menu remains the only scroll owner for its body.
    await page.setViewportSize({ width: 1440, height: 240 });
    await trigger.click();
    await expect(menu).toBeVisible();
    await assertMenuInViewport();
    const shortGeometry = await menu.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      maxHeight: getComputedStyle(element).maxHeight,
    }));
    expect(shortGeometry.clientHeight).toBeLessThanOrEqual(224);
    expect(shortGeometry.scrollHeight).toBeGreaterThanOrEqual(shortGeometry.clientHeight);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // Restore a normal desktop viewport and prove the portal remains bounded.
    await page.setViewportSize({ width: 1440, height: 900 });
    await trigger.click();
    await expect(menu).toBeVisible();
    await assertMenuInViewport();
    await page.keyboard.press('Escape');
  });
  // harn:end worktree-rail-is-one-line-and-working-replaces-the-branch-glyph
});
// harn:end worktree-conversation-status-is-live-and-independent
// harn:end registered-worktree-navigation-is-promotion-gated

// harn:assume native-worktree-rail-is-axe-valid ref=worktree-rail-browser-a11y
test.describe('native worktree rail accessibility', () => {
  test('uses valid list ownership and stays axe-clean in both themes', async ({ page }) => {
    await openRoom(page, `/?room=workspace&token=${TOKEN}`);
    const group = page.getByTestId('worktree-group');
    await expect(group).toBeVisible();
    const list = group.locator('ul.nx-wt-list');
    const shape = await list.evaluate((element) => ({
      directTags: Array.from(element.children).map((child) => child.tagName),
      nestedListItems: Array.from(element.children)
        .reduce((count, row) => count + row.querySelectorAll('li').length, 0),
      rowChildren: Array.from(element.children).map((row) => Array.from(row.children).map((child) => child.tagName)),
    }));
    expect(shape.directTags.length).toBeGreaterThan(0);
    expect(shape.directTags.every((tag) => tag === 'LI')).toBe(true);
    expect(shape.nestedListItems).toBe(0);
    expect(shape.rowChildren.every((children) => children.includes('A'))).toBe(true);
    expect(await group.locator('[data-testid^="worktree-connection-"]').count()).toBe(0);
    expect(await group.locator('[data-testid^="worktree-status-"]').count()).toBe(0);
    await expect(group).not.toContainText('Live');

    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      const { violations } = await new AxeBuilder({ page }).include('[data-testid="worktree-group"]').analyze();
      expect(violations.map((violation) => violation.id), theme).toEqual([]);
    }

    const trigger = group.getByTestId(/worktree-menu-trigger-/).first();
    await trigger.click();
    const menu = page.locator('[role="menu"][data-testid^="worktree-menu-"]').first();
    await expect(menu).toBeVisible();
    const menuTestId = await menu.getAttribute('data-testid');
    expect(menuTestId).toBeTruthy();
    const { violations } = await new AxeBuilder({ page })
      .include(`[data-testid="${menuTestId}"]`)
      .analyze();
    expect(violations.map((violation) => violation.id), 'open dropdown').toEqual([]);
  });
});
// harn:end native-worktree-rail-is-axe-valid
