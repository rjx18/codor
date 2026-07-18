import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Page older history in until `target` exists.
 *
 * A cold load now serves only the bounded tail, so a spec asserting on an old
 * seeded fixture must scroll back for it exactly as an operator would — the
 * shared `eng` room accumulates messages as other specs post into it, which
 * pushes the boot fixtures out of the first page.
 */
export async function revealOlder(page: Page, target: Locator, tries = 40): Promise<void> {
  let loaded = -1;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (await target.count() > 0) return;
    const before = await page.locator('.nx-column > .nx-turn').count();
    if (before === loaded) return; // paged to the very start; nothing more to load
    loaded = before;
    await page.getByTestId('timeline').evaluate((node) => { node.scrollTop = 0; });
    await page.waitForTimeout(400);
  }
  await expect(target).toHaveCount(1); // fail loudly if it never paged in
}
