import { expect, test, type Page } from '@playwright/test';

const ROOM = '/?room=eng&token=next-e2e-token';

test.use({ viewport: { width: 390, height: 844 } });

async function openRoom(page: Page): Promise<void> {
  await page.goto(ROOM);
  await expect(page.getByTestId('timeline')).toBeVisible();
}

test.describe('two-surface stack', () => {
  test('back opens the channels list; picking one returns to its room', async ({ page }) => {
    await openRoom(page);
    await expect(page.getByTestId('mobile-back')).toBeVisible();

    await page.getByTestId('mobile-back').click();
    await expect(page.getByTestId('room-link-design')).toBeVisible();
    await expect(page.getByTestId('timeline')).toHaveCount(0);

    await page.getByTestId('room-link-design').click();
    await expect(page.locator('.nx-mobile-title h1')).toHaveText('Design');
    await expect(page.getByTestId('timeline')).toBeVisible();
  });

  test('the kebab opens the context sheet with the roster', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('mobile-kebab').click();
    const sheet = page.getByTestId('mobile-context');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('member-fable')).toBeVisible();
    await sheet.locator('.nx-mobile-context-close').click();
    await expect(sheet).toBeHidden();
  });
});

test.describe('mobile transcript re-composition', () => {
  test('turns are plain text and tool activity is a quiet disclosure line', async ({ page }) => {
    await openRoom(page);
    // Identity chips leave the timeline on the phone.
    await expect(page.locator('.nx-turn > .nx-chip').first()).toBeHidden();
    // The batch renders as a line with inline ±, expanding on tap.
    const line = page.locator('.nx-batch-line').first();
    await expect(line).toContainText(/Ran 2 tools · wrote 1 file \+2 −1/);
    await line.click();
    await expect(page.locator('.nx-tool').first()).toBeVisible();
  });

  test('content growth stays pinned until an intentional upward scroll releases it', async ({ page }) => {
    await openRoom(page);
    const timeline = page.getByTestId('timeline');
    const fab = page.locator('.nx-jump');

    await expect.poll(() => timeline.evaluate((node) =>
      node.scrollHeight - node.scrollTop - node.clientHeight,
    )).toBeLessThan(4);

    // A small nudge does not release the tail; subsequent column growth snaps back.
    await timeline.evaluate((node) => { node.scrollTop -= 60; });
    await expect(fab).toBeHidden();
    await timeline.evaluate((node) => {
      const spacer = document.createElement('div');
      spacer.dataset.testid = 'growth-probe-one';
      spacer.style.height = '240px';
      spacer.style.flex = '0 0 240px';
      node.querySelector('.nx-column')?.append(spacer);
    });
    await expect.poll(() => timeline.evaluate((node) =>
      node.scrollHeight - node.scrollTop - node.clientHeight,
    )).toBeLessThan(4);

    // Crossing the release threshold exposes the FAB and ResizeObserver stops following.
    await timeline.evaluate((node) => { node.scrollTop -= 160; });
    await expect(fab).toBeVisible();
    const releasedTop = await timeline.evaluate((node) => node.scrollTop);
    await timeline.evaluate((node) => {
      const spacer = document.createElement('div');
      spacer.dataset.testid = 'growth-probe-two';
      spacer.style.height = '240px';
      spacer.style.flex = '0 0 240px';
      node.querySelector('.nx-column')?.append(spacer);
    });
    await page.waitForTimeout(100);
    expect(await timeline.evaluate((node) => node.scrollTop)).toBe(releasedTop);

    const box = await fab.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);

    // Returning near the bottom re-glues without needing the button.
    await timeline.evaluate((node) => { node.scrollTop = node.scrollHeight - node.clientHeight - 40; });
    await expect(fab).toBeHidden();
    await timeline.evaluate((node) => {
      const spacer = document.createElement('div');
      spacer.style.height = '120px';
      spacer.style.flex = '0 0 120px';
      node.querySelector('.nx-column')?.append(spacer);
    });
    await expect.poll(() => timeline.evaluate((node) =>
      node.scrollHeight - node.scrollTop - node.clientHeight,
    )).toBeLessThan(4);
  });
});

test.describe('mobile composer', () => {
  test('two rows: the @ affordance opens mentions and the peach send posts', async ({ page }) => {
    await enqueueTurn();
    await openRoom(page);
    const input = page.getByTestId('composer-input');
    await expect(input).toHaveValue('@fable ');
    await input.fill('');
    await page.getByTestId('composer-at').click();
    await expect(page.getByTestId('mention-popover')).toBeVisible();
    await expect(input).toBeFocused();
    await input.pressSequentially('fa', { delay: 40 });
    await expect(page.getByTestId('mention-popover')).toContainText('@fable');
    await input.press('Enter'); // accept @fable
    await expect(input).toHaveValue('@fable ');
    await input.pressSequentially('ping from the phone');
    await expect(input).toHaveValue('@fable ping from the phone');

    const send = page.getByTestId('composer-send');
    const box = await send.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    await send.click();
    await expect(page.locator('.nx-prose', { hasText: 'ping from the phone' })).toBeVisible();
  });
});

test.describe('accessibility', () => {
  test('the mobile room is axe-clean in light and dark', async ({ page }) => {
    await openRoom(page);
    await page.waitForTimeout(350);
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const light = await new AxeBuilder({ page }).analyze();
    expect(light.violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);

    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.waitForTimeout(350);
    const dark = await new AxeBuilder({ page }).analyze();
    expect(dark.violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
  });
});

async function enqueueTurn(): Promise<void> {
  const control = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
  const res = await fetch(`${control}/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turns: [{ kind: 'complete', final_text: 'ack from fable' }] }),
  });
  if (!res.ok) throw new Error(await res.text());
}
