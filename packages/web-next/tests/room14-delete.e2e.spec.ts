import { expect, test, type Page } from '@playwright/test';

const ENG = '/?room=eng&token=next-e2e-token';
const VIEWER_ENG = '/?room=eng&token=next-e2e-viewer-token';
// Deletion is irreversible, so it runs in an agent-free scratch room of
// pre-seeded, non-grouped messages — never touching eng or creating runs.
const TRASH = '/?room=trash&token=next-e2e-token';

async function openRoom(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

// The scratch row (by seeded text) and its message id.
async function target(page: Page, tag: string): Promise<{ id: string }> {
  const row = page.locator('article', { hasText: `delete target ${tag}` }).first();
  await expect(row).toBeVisible();
  return { id: (await row.getAttribute('data-testid'))!.replace('msg-', '') };
}

test.describe('message deletion', () => {
  test('owner deletes through a confirm; the row becomes a [deleted] tombstone', async ({ page }) => {
    await openRoom(page, TRASH);
    const { id } = await target(page, 'alpha');

    await page.getByTestId(`msg-${id}`).hover();
    await page.getByTestId(`msg-${id}-delete`).click();
    const dialog = page.getByTestId('delete-confirm');
    await expect(dialog).toBeVisible();
    await page.getByTestId('delete-confirm-go').click();
    await expect(dialog).toBeHidden();

    await expect(page.getByTestId(`msg-${id}-deleted`)).toHaveText('[deleted]');
    await expect(page.locator('article', { hasText: 'delete target alpha' })).toHaveCount(0);
    await expect(page.getByTestId(`msg-${id}-delete`)).toHaveCount(0); // no actions on a tombstone
  });

  test('cancelling the confirm leaves the message intact', async ({ page }) => {
    await openRoom(page, TRASH);
    const { id } = await target(page, 'beta');

    await page.getByTestId(`msg-${id}`).hover();
    await page.getByTestId(`msg-${id}-delete`).click();
    await page.locator('[data-testid="delete-confirm"] button', { hasText: 'Cancel' }).click();
    await expect(page.getByTestId('delete-confirm')).toBeHidden();
    await expect(page.getByTestId(`msg-${id}-deleted`)).toHaveCount(0);
    await expect(page.locator('article', { hasText: 'delete target beta' })).toBeVisible();
  });

  test('deleting a pinned message drops it from the pinned strip', async ({ page }) => {
    await openRoom(page, TRASH);
    const { id } = await target(page, 'gamma');

    await page.getByTestId(`msg-${id}`).hover();
    await page.getByTestId(`msg-${id}-pin`).click();
    await expect(page.getByTestId(`pinned-${id}`)).toBeVisible();

    await page.getByTestId(`msg-${id}`).hover();
    await page.getByTestId(`msg-${id}-delete`).click();
    await page.getByTestId('delete-confirm-go').click();

    await expect(page.getByTestId(`msg-${id}-deleted`)).toBeVisible();
    await expect(page.getByTestId(`pinned-${id}`)).toHaveCount(0); // pin cleared → left the strip
  });

  test('a non-privileged member sees no delete action', async ({ page }) => {
    await openRoom(page, VIEWER_ENG);
    await expect(page.locator('[data-testid$="-delete"]')).toHaveCount(0);
  });

  test('a tombstone stays axe-clean', async ({ page }) => {
    await openRoom(page, TRASH);
    const { id } = await target(page, 'delta');
    await page.getByTestId(`msg-${id}`).hover();
    await page.getByTestId(`msg-${id}-delete`).click();
    await page.getByTestId('delete-confirm-go').click();
    await expect(page.getByTestId(`msg-${id}-deleted`)).toBeVisible();
    await page.waitForTimeout(300);

    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
  });
});
