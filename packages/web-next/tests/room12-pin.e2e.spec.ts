import { expect, test, type Page } from '@playwright/test';

import { revealOlder } from './history.js';

const ROOM = '/?room=eng&token=next-e2e-token';

async function openRoom(page: Page): Promise<void> {
  await page.goto(ROOM);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

// Each test pins then unpins, leaving the shared room exactly as it was found.
test.describe('message pinning', () => {
  test('an owner pins a message into the strip, jumps by permalink, then unpins', async ({ page }) => {
    await openRoom(page);
    await expect(page.getByTestId('pinned-strip')).toHaveCount(0); // nothing pinned yet

    const target = page.getByTestId('msg-1');
    await revealOlder(page, target);
    await target.hover();
    await page.getByTestId('msg-1-pin').click();

    // The row wears a pin glyph and the strip lists the message.
    await expect(page.getByTestId('msg-1-pinned')).toBeVisible();
    const entry = page.getByTestId('pinned-1');
    await expect(page.getByTestId('pinned-strip')).toBeVisible();
    await expect(entry).toContainText('@richard');
    await expect(entry).toContainText('morning');

    // Scroll to the tail, then the strip chip jumps back by permalink.
    await page.getByTestId('timeline').evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await entry.click();
    await expect(page).toHaveURL(/#1$/);
    await expect(page.getByTestId('msg-1')).toBeInViewport();

    // Unpin clears the glyph and empties the strip.
    await target.hover();
    await page.getByTestId('msg-1-pin').click();
    await expect(page.getByTestId('msg-1-pinned')).toHaveCount(0);
    await expect(page.getByTestId('pinned-strip')).toHaveCount(0);
  });

  test('the pinned state stays axe-clean', async ({ page }) => {
    await openRoom(page);
    await revealOlder(page, page.getByTestId('msg-1'));
    await page.getByTestId('msg-1').hover();
    await page.getByTestId('msg-1-pin').click();
    await expect(page.getByTestId('pinned-strip')).toBeVisible();
    await page.waitForTimeout(300);

    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);

    await page.getByTestId('msg-1').hover(); // leave the room as found
    await page.getByTestId('msg-1-pin').click();
    await expect(page.getByTestId('pinned-strip')).toHaveCount(0);
  });
});
