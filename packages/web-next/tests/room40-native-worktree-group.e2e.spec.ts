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
    expect(page.url()).toContain(`room=workspace`);
    expect(page.url()).toContain(`worktree=${childId}`);
    await expect(page.getByTestId('timeline')).toContainText('review notes live in the child conversation');

    // Back returns to main without rewriting history; reload keeps the child.
    await page.goBack();
    expect(page.url()).not.toContain('worktree=');
    await page.goForward();
    expect(page.url()).toContain(`worktree=${childId}`);
    await page.reload();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.getByTestId(`worktree-link-${childId}`)).toHaveAttribute('aria-current', 'page');
  });

  test('reports independent readiness, retains rows offline, and recovers on reconnect', async ({ page }) => {
    const childId = await reviewChildId(page);
    await openRoom(page, `/?room=workspace&token=${TOKEN}`);
    await expect(page.getByTestId('worktree-group')).toBeVisible();

    // The hidden child hydrates on the multiplexed socket: readiness settles.
    await expect(page.getByTestId(`worktree-status-${childId}`)).toContainText(/live|connecting/);
    await expect(page.getByTestId(`worktree-status-${childId}`)).toContainText('live', { timeout: 15_000 });

    // Offline (operator park drives the same disconnected state): the group
    // rows remain as last-good state and the child reports offline.
    await page.evaluate(() => {
      (window as unknown as { __codor: { disconnect(): void } }).__codor.disconnect();
    });
    await expect(page.getByTestId('connection')).toHaveText(/Reconnecting/, { timeout: 15_000 });
    await expect(page.getByTestId(`worktree-link-${childId}`)).toBeVisible();
    await expect(page.getByTestId(`worktree-status-${childId}`)).toContainText('offline');

    // Reconnect refreshes the registered set and resubscribes the child.
    await page.evaluate(() => {
      (window as unknown as { __codor: { reconnect(): void } }).__codor.reconnect();
    });
    await expect(page.getByTestId('connection')).toHaveText(/Connected/, { timeout: 20_000 });
    await expect(page.getByTestId(`worktree-status-${childId}`)).toContainText('live', { timeout: 20_000 });
  });

  test('leaves normal channels unchanged and hides the entry for non-Git context', async ({ page }) => {
    await openRoom(page, `/?room=eng&token=${TOKEN}`);
    await expect(page.getByTestId('worktree-group')).toHaveCount(0);

    // A non-Git room's Diff context never offers the pre-promotion entry.
    await openRoom(page, `/?room=files&token=${TOKEN}`);
    await page.getByTestId('context-tab-diff').click();
    await expect(page.getByTestId('worktree-entry')).toHaveCount(0);
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
