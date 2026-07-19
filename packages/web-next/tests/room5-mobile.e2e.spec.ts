import { expect, test, type Page } from '@playwright/test';

import { revealOlder } from './history.js';

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
  test('turn headers carry a small inline chip and tool activity is a quiet disclosure line', async ({ page }) => {
    await openRoom(page);
    // The chip column folds into a 24px chip beside the handle in the header.
    await revealOlder(page, page.locator('.nx-batch-line').first());
    await expect(page.locator('.nx-turn > .nx-chip')).toHaveCount(0);
    const headerChip = page.locator('.nx-turn-meta .nx-chip').first();
    await expect(headerChip).toBeVisible();
    const chipBox = await headerChip.boundingBox();
    expect(chipBox!.width).toBe(24);
    expect(chipBox!.height).toBe(24);
    // The batch keeps the DESKTOP chip on mobile — border, radius, background
    // and padding — so a tappable control still looks like one. Stripped to
    // bare text it read as prose nobody thought to touch.
    const line = page.locator('.nx-batch-line').first();
    await expect(line).toContainText(/Ran 2 tools · wrote 1 file \+2 −1/);
    const chrome = await line.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        borderWidth: parseFloat(style.borderTopWidth),
        radius: parseFloat(style.borderTopLeftRadius),
        paddingX: parseFloat(style.paddingLeft),
        background: style.backgroundColor,
      };
    });
    expect(chrome.borderWidth).toBeGreaterThan(0);
    expect(chrome.radius).toBeGreaterThan(0);
    expect(chrome.paddingX).toBeGreaterThan(0);
    expect(chrome.background).not.toBe('rgba(0, 0, 0, 0)');
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
    // Assigning scrollTop does not reliably produce a browser scroll event under
    // full-suite timing, and the pin release listens for that event. Dispatch it
    // explicitly, as the stable room11 gesture already does.
    await timeline.evaluate((node) => {
      node.scrollTop = Math.max(0, node.scrollTop - 60);
      node.dispatchEvent(new Event('scroll'));
    });
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

    // Crossing the release threshold exposes the FAB and the growth observer
    // stops following. Measured from the bottom so the gesture is the same
    // distance regardless of how much history the suite accumulated in eng.
    //
    // The two-frame barriers matter: the first spacer's growth/scroll work can
    // still be pending, and capturing the released position before it settles
    // records a baseline the browser is about to move — which is exactly the
    // +160 drift that looked like a partial pinned follow.
    await timeline.evaluate(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    });
    await timeline.evaluate(async (node) => {
      node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 160);
      node.dispatchEvent(new Event('scroll'));
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    });
    await expect(fab).toBeVisible();
    const released = await timeline.evaluate((node) => ({
      top: node.scrollTop,
      distance: node.scrollHeight - node.scrollTop - node.clientHeight,
    }));
    expect(released.distance).toBeGreaterThanOrEqual(120);
    const releasedTop = released.top;
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
  test('two rows: the @ affordance opens mentions and the send button posts', async ({ page }, testInfo) => {
    // repeat-each shares one harness database, so every attempt needs its own
    // prompt/result identity. Waiting for the matching agent response also
    // drains the enqueued fake turn before the next attempt starts.
    const marker = `${String(testInfo.repeatEachIndex)}-${String(testInfo.retry)}`;
    const prompt = `ping from the phone ${marker}`;
    const response = `ack from fable ${marker}`;
    await enqueueTurn(response);
    await openRoom(page);
    const input = page.getByTestId('composer-input');
    // Wait out the draft seeding effect — clearing before it lands would let
    // the seed overwrite the cleared draft mid-test.
    await expect(input).toHaveValue(/@\w+ /);
    await input.fill('');
    await page.getByTestId('composer-at').click();
    await expect(page.getByTestId('mention-popover')).toBeVisible();
    await expect(input).toBeFocused();
    await input.pressSequentially('fa', { delay: 40 });
    await expect(page.getByTestId('mention-popover')).toContainText('@fable');
    // On a phone, Enter is the newline key and must stay that way even with the
    // mention list open — it inserts a break rather than accepting a name.
    await input.press('Enter');
    await expect(input).toHaveValue('@fa\n');

    // Selection is a tap, which is the only aiming a thumb can do reliably.
    await input.fill('@fa');
    await expect(page.getByTestId('mention-popover')).toContainText('@fable');
    await page.getByTestId('mention-popover').getByText('@fable').click();
    await expect(input).toHaveValue('@fable ');
    await input.pressSequentially(prompt);
    await expect(input).toHaveValue(`@fable ${prompt}`);

    const send = page.getByTestId('composer-send');
    const box = await send.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    await send.click();
    await expect(page.locator('.nx-prose', { hasText: prompt })).toBeVisible();
    await expect(page.locator('.nx-prose', { hasText: response })).toBeVisible();
  });
});

test.describe('mobile composer keyboard', () => {
  test('Enter writes newlines and posts nothing', async ({ page }) => {
    // Deliberately does NOT send: this file shares one FakeAdapter queue with
    // every other spec, and a second posting test races the turn they depend
    // on. Sending is proven once, above; this owns the keyboard contract.
    await openRoom(page);
    const input = page.getByTestId('composer-input');
    await expect(input).toHaveValue(/@\w+ /);
    await input.fill('@fable ');

    // Snapshot AFTER hydration settles: counting mid-hydration would compare a
    // partly-painted transcript against a full one and read as a phantom post.
    await expect(page.locator('.nx-turn').first()).toBeVisible();
    await page.waitForTimeout(300);
    const before = await page.locator('.nx-turn').count();
    await input.pressSequentially('first line');
    await input.press('Enter');
    await input.press('Enter');
    await input.pressSequentially('second line');

    // Two Enters produced two newlines and posted nothing at all.
    await expect(input).toHaveValue('@fable first line\n\nsecond line');
    expect(await page.locator('.nx-turn').count()).toBe(before);

    await input.fill(''); // leave the room as found
  });

  test('eight rows actually fit, a ninth scrolls, and sending resets to one row', async ({ page }, testInfo) => {
    const marker = `${String(testInfo.repeatEachIndex)}-${String(testInfo.retry)}`;
    await openRoom(page);
    const input = page.getByTestId('composer-input');
    await expect(input).toHaveValue(/@\w+ /);

    const metrics = async () => await input.evaluate((node: HTMLTextAreaElement) => ({
      client: node.clientHeight, scroll: node.scrollHeight,
    }));
    const rows = (count: number) =>
      Array.from({ length: count }, (_, index) => `line ${String(index)}`).join('\n');

    await input.fill('');
    const oneRow = (await input.boundingBox())!.height;

    await input.fill(rows(4));
    expect((await input.boundingBox())!.height).toBeGreaterThan(oneRow);

    // Eight rows must FIT, not merely stop growing: the cap is a height, so it
    // has to include the box's own vertical padding or the eighth row clips.
    await input.fill(rows(8));
    const eight = await metrics();
    expect(eight.scroll).toBeLessThanOrEqual(eight.client);

    // The ninth scrolls internally instead of growing the box further.
    await input.fill(rows(9));
    const nine = await metrics();
    expect(nine.client).toBe(eight.client);
    expect(nine.scroll).toBeGreaterThan(nine.client);

    // A real send — not just clearing the value — returns it to one row.
    // Addressed to @viewer, a human member: that posts a chat and starts no
    // agent turn, so this cannot consume a fake turn another spec is awaiting.
    // The FakeAdapter queue is global, and this test was the second consumer in
    // this file, which is what made the pre-existing send test flake on repeat.
    await input.fill(`@viewer multi\nline\nbody ${marker}`);
    expect((await input.boundingBox())!.height).toBeGreaterThan(oneRow);
    await page.getByTestId('composer-send').click();
    await expect(page.locator('article', { hasText: `body ${marker}` }).first()).toBeVisible();
    expect((await input.boundingBox())!.height).toBeLessThanOrEqual(oneRow + 1);
  });

  test('the send control shares the desktop primitive and keeps a 44px target', async ({ page }) => {
    await openRoom(page);
    const send = page.getByTestId('composer-send');
    // Same primitive as desktop, so theme and shape cannot drift between them.
    await expect(send).toHaveClass(/nx-iconbtn/);
    await expect(send).toHaveClass(/is-solid/);
    const box = (await send.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
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

async function enqueueTurn(finalText: string): Promise<void> {
  const control = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
  const res = await fetch(`${control}/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turns: [{ kind: 'complete', final_text: finalText }] }),
  });
  if (!res.ok) throw new Error(await res.text());
}
