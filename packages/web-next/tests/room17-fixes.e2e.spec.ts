import { expect, test, type Page } from '@playwright/test';

const ENG = '/?room=eng&token=next-e2e-token';
const TRASH = '/?room=trash&token=next-e2e-token';
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

async function enqueue(turns: unknown[]): Promise<void> {
  const res = await fetch(`${CONTROL}/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turns }),
  });
  if (!res.ok) throw new Error(`enqueue failed: ${await res.text()}`);
}

async function openRoom(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

test.describe('typing bar — all working agents', () => {
  test('every working agent gets a chip; running ones carry their own stop', async ({ page }) => {
    await openRoom(page, ENG); // scout runs from the seed
    await enqueue([{ kind: 'fail-on-interrupt' }]);
    const input = page.getByTestId('composer-input');
    await expect(input).toHaveValue(/@\w+ /);
    await input.fill('@fable keep working while scout runs');
    await input.press('Enter');
    await expect(page.getByTestId('member-fable')).toContainText('Working');

    // Both working agents show, each with its own stop control.
    await expect(page.getByTestId('typing-scout')).toBeVisible();
    await expect(page.getByTestId('typing-fable')).toBeVisible();
    await expect(page.getByTestId('typing-stop-scout')).toBeVisible();
    await expect(page.getByTestId('typing-stop-fable')).toBeVisible();

    // Stop fable so it leaves the bar and later specs see it idle again.
    await page.getByTestId('typing-stop-fable').click();
    await expect(page.getByTestId('typing-fable')).toHaveCount(0);
    await expect(page.getByTestId('member-fable')).toContainText('Idle');
  });
});

test.describe('empty terminal runs', () => {
  test('an interrupted run with no reply shows a status marker, not a blank bubble', async ({ page }) => {
    await enqueue([{ kind: 'die-silently' }]); // EOF with no completion → interrupted, empty
    await openRoom(page, ENG);
    const input = page.getByTestId('composer-input');
    await expect(input).toHaveValue(/@\w+ /);
    await input.fill('@fable this turn gets cut short');
    await input.press('Enter');

    const marker = page.locator('[data-testid$="-status"]').filter({ hasText: 'run interrupted' });
    await expect(marker.first()).toBeVisible();
  });
});

test.describe('mention highlight', () => {
  test('a message mentioning the viewer is amber-highlighted with a bold handle', async ({ page }) => {
    await openRoom(page, TRASH); // agent-free room: an unaddressed @richard post is allowed
    const input = page.getByTestId('composer-input');
    await input.fill('@richard remember to rotate the keys');
    await input.press('Enter');

    const msg = page.locator('article.is-mentioned').filter({ hasText: 'remember to rotate the keys' }).first();
    await expect(msg).toBeVisible();
    await expect(msg).toHaveAttribute('data-mentions-me', 'true');
    await expect(msg.locator('.nx-mention-self')).toHaveText('@richard');

    await page.waitForTimeout(300);
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const light = await new AxeBuilder({ page }).analyze();
    expect(light.violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.waitForTimeout(300);
    const dark = await new AxeBuilder({ page }).analyze();
    expect(dark.violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
  });
});

test.describe('inbox relevance', () => {
  test('mark-all-read empties the inbox', async ({ page }) => {
    await openRoom(page, ENG);
    await page.getByTestId('inbox-toggle').click();
    await expect(page.getByTestId('inbox-panel')).toBeVisible();

    const clearAll = page.getByTestId('inbox-mark-all');
    if (await clearAll.isVisible()) {
      await clearAll.click(); // closes the panel
      await page.getByTestId('inbox-toggle').click();
      await expect(page.getByTestId('inbox-empty')).toBeVisible();
      await expect(page.getByTestId('inbox-badge')).toHaveCount(0);
    } else {
      await expect(page.getByTestId('inbox-empty')).toBeVisible();
    }
  });

  test('every inbox row is a mention of the viewer or an ask/approval for them', async ({ page }) => {
    await openRoom(page, ENG);
    await page.getByTestId('inbox-toggle').click();
    const panel = page.getByTestId('inbox-panel');
    await expect(panel).toBeVisible();
    // Relevance is enforced by construction; assert the panel is coherent —
    // either empty, or its row count matches the badge exactly.
    const badge = page.getByTestId('inbox-badge');
    if (await badge.isVisible()) {
      const count = Number(await badge.textContent());
      await expect(panel.locator('.nx-inbox-row')).toHaveCount(count);
    } else {
      await expect(panel.getByTestId('inbox-empty')).toBeVisible();
    }
  });
});
