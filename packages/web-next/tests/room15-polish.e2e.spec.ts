import { expect, test, type Page } from '@playwright/test';

const ENG = '/?room=eng&token=next-e2e-token';
const VIEWER_ENG = '/?room=eng&token=next-e2e-viewer-token';
// Hydration runs in the agent-free scratch room so the 120-message bulk never
// pollutes eng (which later specs depend on).
const TRASH = '/?room=trash&token=next-e2e-token';
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

async function openRoom(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

async function seedBulk(room: string, count: number): Promise<void> {
  const res = await fetch(`${CONTROL}/seed-bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room, count }),
  });
  if (!res.ok) throw new Error(`seed-bulk failed: ${await res.text()}`);
}

test.describe('pinned-strip hydration', () => {
  test('a pin beyond the loaded window hydrates into the strip and pages back on click', async ({ page }) => {
    await openRoom(page, TRASH);
    // Pin a message while it is still loaded.
    const row = page.locator('article', { hasText: 'delete target epsilon' }).first();
    await expect(row).toBeVisible();
    const id = (await row.getAttribute('data-testid'))!.replace('msg-', '');
    await page.getByTestId(`msg-${id}`).hover();
    await page.getByTestId(`msg-${id}-pin`).click();
    await expect(page.getByTestId(`pinned-${id}`)).toBeVisible();

    // Bury it far beyond the loaded page window, then reload.
    await seedBulk('trash', 120);
    await openRoom(page, TRASH);

    // The message is no longer in the timeline, but the strip hydrated it from
    // the server and its chip pages history back until it lands.
    await expect(page.locator('article', { hasText: 'delete target epsilon' })).toHaveCount(0);
    await expect(page.getByTestId(`pinned-${id}`)).toBeVisible();
    await page.getByTestId(`pinned-${id}`).click();
    await expect(page.locator('article', { hasText: 'delete target epsilon' })).toBeVisible();
  });
});

test.describe('member kebab role-gate', () => {
  test('the lifecycle kebab shows for the owner and hides from a non-privileged viewer', async ({ page }) => {
    await openRoom(page, ENG);
    await expect(page.getByTestId('member-fable-menu')).toBeVisible();

    await openRoom(page, VIEWER_ENG);
    await expect(page.getByTestId('member-fable')).toBeVisible(); // roster still renders
    await expect(page.getByTestId('member-fable-menu')).toHaveCount(0);
  });
});
