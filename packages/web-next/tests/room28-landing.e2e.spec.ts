import { expect, test } from '@playwright/test';

async function pasteCode(page: import('@playwright/test').Page, code: string): Promise<void> {
  await page.getByTestId('pairing-code-0').evaluate((element, pasted) => {
    const data = new DataTransfer();
    data.setData('text/plain', pasted);
    element.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  }, code);
}

test.describe('local setup landing', () => {
  test('the unpaired root gives exactly two truthful steps and a complete code control', async ({ page }) => {
    await page.goto('/?code=2345-ABCD');
    const landing = page.getByTestId('landing-page');
    await expect(landing).toBeVisible();
    await expect(landing.locator('.nx-setup-step')).toHaveCount(2);
    // harn:assume unpaired-root-explains-primary-install-and-hosted-access ref=landing-primary-install-regression
    await expect(landing).toContainText('npx @richhardry/codor install');
    // harn:end unpaired-root-explains-primary-install-and-hosted-access
    await expect(landing).toContainText('localhost');
    await expect(landing).toContainText('Tailscale');

    const cells = landing.locator('.nx-code-cell');
    await expect(cells).toHaveCount(8);
    await expect(cells.nth(0)).toHaveValue('2');
    await expect(cells.nth(7)).toHaveValue('D');
    await expect(landing.locator('.nx-setup-step').nth(1)).toBeInViewport();
    const lastCell = await cells.nth(7).boundingBox();
    const pairButton = await page.getByTestId('pairing-code-submit').boundingBox();
    expect(pairButton?.y).toBeGreaterThan((lastCell?.y ?? 0) + (lastCell?.height ?? 0));

    await pasteCode(page, '6789-WXYZ');
    await expect(cells.nth(0)).toHaveValue('6');
    await expect(cells.nth(7)).toHaveValue('Z');
    await cells.nth(4).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(cells.nth(3)).toBeFocused();
    await page.keyboard.press('Backspace');
    await expect(cells.nth(3)).toHaveValue('');
    await page.keyboard.press('Backspace');
    await expect(cells.nth(2)).toBeFocused();
  });

  test('a failed short code stays on the landing and explains recovery', async ({ page }) => {
    await page.goto('/');
    await pasteCode(page, 'ZZZZZZZZ');
    await page.getByTestId('pairing-code-submit').click();
    await expect(page.getByRole('alert')).toContainText('fresh code');
    await expect(page.getByTestId('landing-page')).toBeVisible();
  });

  test('the conversation starts on scroll and reduced motion receives the settled result', async ({ page }) => {
    await page.goto('/');
    const demo = page.getByTestId('landing-demo');
    await expect(page.getByTestId('landing-demo-channel')).toContainText('# relay-onboarding');
    const turns = demo.locator('.nx-demo-thread > .nx-turn');
    await expect(turns).toHaveCount(0);
    await demo.scrollIntoViewIfNeeded();
    await expect(turns).toHaveCount(1, { timeout: 2_000 });
    await expect(turns).toHaveCount(2, { timeout: 4_500 });
    await expect(demo.locator('.nx-ask')).toHaveCount(1);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    const settled = page.getByTestId('landing-demo');
    await expect(settled).toContainText('Ran 4 tools · wrote 2 files +68 −24');
    await expect(settled).toContainText('Re-review is clean');
    await expect(settled).toContainText('Deployed to codor.app 🚀 Everything is green ✅');
    // Richard sends the approval himself, as his own message, between the
    // approval control and Fable launching the workflows (Codex review #556).
    const approval = settled.locator('.nx-turn', { hasText: 'Approved — run all four phases' });
    await expect(approval.locator('.nx-turn-author')).toHaveText('Richard');
    await expect(settled.locator('.nx-demo-ask.is-approved')).toContainText('Four-phase plan approved');
    await expect(settled.locator('.nx-demo-thread > .nx-turn')).toHaveCount(22);
    await expect(page.locator('.nx-demo-windowbar')).toHaveCount(1);
    await expect(settled.getByRole('textbox')).toHaveCount(0);
    await expect(settled).toHaveCSS('overflow-y', 'hidden');
    const feed = await settled.evaluate((stream) => {
      const content = stream.querySelector<HTMLElement>('.nx-demo-content');
      const last = stream.querySelector<HTMLElement>('.nx-demo-thread > .nx-turn:last-child');
      return {
        scrollTop: stream.scrollTop,
        contentTop: content?.getBoundingClientRect().top ?? 0,
        streamTop: stream.getBoundingClientRect().top,
        lastBottom: last?.getBoundingClientRect().bottom ?? 0,
        streamBottom: stream.getBoundingClientRect().bottom,
      };
    });
    expect(feed.scrollTop).toBe(0);
    expect(feed.contentTop).toBeLessThan(feed.streamTop);
    expect(feed.lastBottom).toBeLessThanOrEqual(feed.streamBottom + 1);
    await expect(page.locator('.nx-workflow-dots i')).toHaveCount(6);
    await expect(page.locator('.nx-review-image-placeholder')).toContainText('Image preview');
    await expect(page.locator('.nx-review-history-toggle')).toContainText('Working tree / HEAD');
    await expect(page.locator('.nx-review-history-list')).toContainText('Expand landing workflow story');
  });

  test('the landing fits a 320px phone and stays axe-clean', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 780 });
    await page.goto('/');
    await expect(page.getByTestId('landing-page')).toBeVisible();
    const workflow = page.locator('.nx-workflow-story');
    await expect(workflow.locator('.nx-story-copy')).toHaveCSS('opacity', '0');
    await workflow.scrollIntoViewIfNeeded();
    await expect(workflow.locator('.nx-story-copy')).toHaveCSS('opacity', '1');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.locator('.nx-code-cell')).toHaveCount(8);
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target[0]}`)).toEqual([]);
  });
});
