// harn:assume registered-worktree-navigation-is-promotion-gated ref=worktree-group-browser-regression
// harn:assume worktree-conversation-status-is-live-and-independent ref=worktree-status-browser-regression
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

async function reviewChildId(page: Page): Promise<string> {
  const { registered } = await control<{
    registered: { id: string; alias: string; primary: boolean }[];
  }>('/wt-registered', { room: 'workspace' });
  const child = registered.find((worktree) => !worktree.primary && worktree.alias === 'review');
  expect(child).toBeDefined();
  return child!.id;
}

test.describe('native worktree group navigation', () => {
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
    await expect(row.locator('.nx-turn-author')).toHaveText('~review:@reviewer');
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

  test('reports independent readiness, retains rows offline, and recovers on reconnect', async ({ page }) => {
    const childId = await reviewChildId(page);
    await openRoom(page, `/?room=workspace&token=${TOKEN}`);
    await expect(page.getByTestId('worktree-group')).toBeVisible();

    // The hidden child hydrates on the multiplexed socket: connection settles
    // on its OWN sync_complete, independent of activity or unread state.
    await expect(page.getByTestId(`worktree-connection-${childId}`)).toContainText(/live|connecting/);
    await expect(page.getByTestId(`worktree-connection-${childId}`)).toContainText('live', { timeout: 15_000 });

    // Offline (operator park drives the same disconnected state): the group
    // rows remain as last-good state, the unread badge survives, and the
    // child's connection reads offline — never masked by activity.
    await page.evaluate(() => {
      (window as unknown as { __codor: { disconnect(): void } }).__codor.disconnect();
    });
    await expect(page.getByTestId('connection')).toHaveText(/Reconnecting/, { timeout: 15_000 });
    await expect(page.getByTestId(`worktree-link-${childId}`)).toBeVisible();
    await expect(page.getByTestId(`worktree-unread-${childId}`)).toBeVisible();
    await expect(page.getByTestId(`worktree-connection-${childId}`)).toContainText('offline');

    // Reconnect replaces the generation: the child must re-prove itself with a
    // fresh sync_complete before it reads live again.
    await page.evaluate(() => {
      (window as unknown as { __codor: { reconnect(): void } }).__codor.reconnect();
    });
    await expect(page.getByTestId('connection')).toHaveText(/Connected/, { timeout: 20_000 });
    await expect(page.getByTestId(`worktree-connection-${childId}`)).toContainText('live', { timeout: 20_000 });
  });

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

  test('fits the 390px channel surface and keeps focus behavior in dialogs', async ({ page }) => {
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

    // Focus enters the manage dialog and Escape returns it to the opener.
    await page.getByTestId('mobile-back').click();
    await page.getByTestId(`worktree-manage-${childId}`).click();
    const dialog = page.getByTestId('worktree-child-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId(`worktree-manage-${childId}`)).toBeFocused();
  });
});
// harn:end worktree-conversation-status-is-live-and-independent
// harn:end registered-worktree-navigation-is-promotion-gated
