import { expect, test, type Page } from '@playwright/test';

const ROOM = '/?room=eng&token=next-e2e-token';
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

async function enqueue(turns: unknown[]): Promise<void> {
  const res = await fetch(`${CONTROL}/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turns }),
  });
  if (!res.ok) throw new Error(`enqueue failed: ${await res.text()}`);
}

async function openRoom(page: Page): Promise<void> {
  await page.goto(ROOM);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

test.describe('composer addressing', () => {
  test('drafts open addressed to the latest finalized agent', async ({ page }) => {
    await openRoom(page);
    await expect(page.getByTestId('composer-input')).toHaveValue('@fable ');
  });

  test('an unaddressed send is blocked with a friendly hint', async ({ page }) => {
    await openRoom(page);
    const input = page.getByTestId('composer-input');
    await input.fill('ship it please');
    await input.press('Enter');
    await expect(page.getByTestId('composer-hint')).toContainText('Say who this is for');
    await input.fill(''); // no message was posted
    await expect(page.locator('.nx-prose', { hasText: 'ship it please' })).toHaveCount(0);
  });

  test('the @ popover lists members and keyboard-inserts a mention', async ({ page }) => {
    await openRoom(page);
    const input = page.getByTestId('composer-input');
    await input.fill('');
    await input.pressSequentially('@mu');
    const popover = page.getByTestId('mention-popover');
    await expect(popover).toBeVisible();
    await expect(popover).toContainText('@muse');
    await input.press('Enter');
    await expect(input).toHaveValue('@muse ');
    await expect(popover).toBeHidden();
  });

  test('a sent message reaches its agent and earns the seen tick', async ({ page }) => {
    await enqueue([{ kind: 'complete', final_text: 'On it — summarizing now.' }]);
    await openRoom(page);
    const input = page.getByTestId('composer-input');
    await input.fill('@fable quick status line please');
    await input.press('Enter');
    await expect(input).toHaveValue('@fable '); // cleared, then re-seeded to the default recipient
    const sent = page.locator('article', { hasText: 'quick status line please' }).first();
    await expect(sent).toBeVisible();
    await expect(sent.locator('[data-testid$="-seen"]')).toHaveAttribute('data-seen', 'true');
    await expect(page.locator('.nx-prose', { hasText: 'On it — summarizing now.' })).toBeVisible();
  });

  test('quote inserts the line addressed to its author', async ({ page }) => {
    await openRoom(page);
    const input = page.getByTestId('composer-input');
    await input.fill('');
    await page.getByTestId('msg-1').hover();
    await page.getByTestId('msg-1-quote').click();
    await expect(input).toHaveValue(/@richard > morning/);
  });
});

test.describe('holds', () => {
  test('the banner names the held delivery and Release runs it', async ({ page }) => {
    await enqueue([{ kind: 'complete', final_text: 'Keys rotated.' }]);
    await openRoom(page);
    const banner = page.getByTestId('hold-banner');
    await expect(banner).toContainText('Held for @fable');
    await banner.locator('button', { hasText: 'Release' }).click();
    await expect(banner).toBeHidden();
    await expect(page.locator('.nx-prose', { hasText: 'Keys rotated.' })).toBeVisible();
  });
});

test.describe('asks', () => {
  test('answering an approval resolves it durably and the card leaves', async ({ page }) => {
    await openRoom(page);
    const card = page.locator('.nx-ask');
    await expect(card).toBeVisible();
    await card.locator('button', { hasText: 'Allow' }).click();
    await expect(card).toBeHidden();
    await expect(page.locator('.nx-prose', { hasText: 'push Allow' })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.locator('.nx-ask')).toHaveCount(0); // resolution survived the reload
  });
});

test.describe('inbox', () => {
  test('the badge count opens onto matching rows that mark read and jump', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('inbox-toggle').click();
    const panel = page.getByTestId('inbox-panel');
    await expect(panel).toBeVisible();
    const badge = page.getByTestId('inbox-badge');
    if (await badge.isVisible()) {
      const count = Number(await badge.textContent());
      await expect(panel.locator('.nx-inbox-row')).toHaveCount(count);
      await panel.locator('.nx-inbox-row').first().click();
      await expect(panel).toBeHidden();
    } else {
      await expect(panel.getByTestId('inbox-empty')).toBeVisible();
    }
  });
});

test.describe('search', () => {
  test('results jump to the permalinked message', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('toggle-message-search').click();
    await page.getByTestId('search-input').fill('staging deploy');
    const hit = page.getByTestId('search-hit-2');
    await expect(hit).toContainText('staging deploy is green');
    await hit.click();
    await expect(page.getByTestId('search-overlay')).toBeHidden();
    await expect(page).toHaveURL(/#2$/);
    await expect(page.getByTestId('msg-2')).toBeInViewport();
  });
});

test.describe('reduced motion', () => {
  test('expanding evidence and jumping still work without animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openRoom(page);
    const batch = page.getByTestId('tool-batch');
    await batch.locator('.nx-batch-line').click();
    await expect(batch.locator('.nx-tool')).toHaveCount(2);
  });
});
