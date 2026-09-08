import { expect, test } from '@playwright/test';

const controlPort = process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138';
const spaPort = process.env.CODOR_NEXT_E2E_SPA_PORT ?? '28139';
const apiPort = process.env.CODOR_NEXT_E2E_API_PORT ?? '28137';
async function control(path: string, body = {}) {
  const response = await fetch(`http://127.0.0.1:${controlPort}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return response.json();
}

for (const hosted of [false, true]) {
  test(`${hosted ? 'hosted' : 'direct'} old hold never crawls a 5165-message transcript`, async ({ page }) => {
    await control('/held-history-fixture');
    const initialCount = (await control('/held-history-status')).requests.length;
    if (hosted) {
      const { code, relayUrl } = await control('/relay-pair');
      await page.addInitScript((url) => { (window as any).__CODOR_RELAY_URL = url; }, relayUrl);
      await page.goto(`http://127.0.0.1:${spaPort}/`);
      await page.getByTestId('pairing-code-0').evaluate((element, code) => {
        const data = new DataTransfer(); data.setData('text/plain', code);
        element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: data }));
      }, code);
      await page.getByTestId('pairing-code-submit').click();
      await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30000 });
      await page.getByText('Held History', { exact: true }).first().click();
    } else {
      await page.goto(`http://127.0.0.1:${apiPort}/?room=held-history&token=next-e2e-token`);
    }
    await expect(page.getByTestId('unloaded-held-recovery')).toBeVisible();
    await expect(page.getByTestId('timeline').getByText(/History 5165:/)).toBeVisible();
    await page.getByTestId('timeline').evaluate((node) => { node.scrollTop -= 100; });
    const before = await page.getByTestId('timeline').evaluate((node) => ({ height: node.scrollHeight, top: node.scrollTop }));
    await control('/held-history-refresh');
    await page.waitForTimeout(1500);
    const after = await page.getByTestId('timeline').evaluate((node) => ({ height: node.scrollHeight, top: node.scrollTop }));
    expect(after).toEqual(before);
    const requests = (await control('/held-history-status')).requests.slice(initialCount);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toBeNull();
    if (hosted) {
      const count = (await control('/held-history-status')).requests.length;
      await page.reload();
      await expect(page.getByTestId('unloaded-held-recovery')).toBeVisible();
      await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30000 });
      await page.waitForTimeout(1500);
      expect((await control('/held-history-status')).requests.length - count).toBeLessThanOrEqual(2);
    }
    await page.getByTestId('unloaded-held-recovery').locator('summary').click();
    await expect(page.getByRole('button', { name: 'Review message #2476 for @held-worker' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Review message.*removed-worker/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Review message #2476 for @held-worker' }).click();
    await expect(page.locator('[id="2476"]')).toBeInViewport({ timeout: 60000 });
  });
}

for (const shape of ['agent', 'grouped-human', 'continuation', 'root']) {
  test(`${shape} origin exposes one retry independently of its header`, async ({ page }) => {
    const fixture = await control('/held-origin-fixture', { shape });
    await control('/release-hold-fixture', { resetAttempts: true, delayMs: 500 });
    await page.goto(`http://127.0.0.1:${apiPort}/?room=${fixture.room}&token=next-e2e-token`);
    if (shape === 'root') {
      await page.getByTestId('unloaded-held-recovery').locator('summary').click();
      await page.getByRole('button', { name: `Review message #${fixture.origin} for @worker` }).click();
    }
    const origin = page.locator(`[id="${fixture.origin}"]`);
    const article = origin.locator('xpath=ancestor-or-self::article[1]');
    await expect(article.locator('[data-testid$="-held"]')).toBeVisible();
    if (shape === 'grouped-human') await expect(article).toHaveClass(/is-grouped/);
    else await expect(article.locator('[data-testid$="-seen"]')).toHaveCount(0);
    await article.locator('[data-testid$="-held"]').click();
    const retry = article.getByTestId(`hold-${fixture.delivery}-release`);
    await retry.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect(retry).toBeDisabled();
    await expect.poll(async () => (await control('/release-hold-stats')).attempts).toBe(1);
    await expect(article.locator('[data-testid$="-held"]')).toHaveCount(0);
  });
}
