import { expect, test, type Page } from '@playwright/test';

const TOKEN = 'next-e2e-token';
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

async function control<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/?room=${room}&token=${TOKEN}`);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

test.describe('multiplexed room state', () => {
  test('one socket streams every rail and fetches journals only after promotion', async ({ page }) => {
    const sockets: string[] = [];
    const summaryRequests: string[] = [];
    const engJournals: string[] = [];
    const opsJournals: string[] = [];
    page.on('websocket', (socket) => sockets.push(socket.url()));
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path === '/api/rooms/summary') summaryRequests.push(request.url());
      if (/^\/api\/rooms\/eng\/runs\//.test(path)) engJournals.push(path);
      if (/^\/api\/rooms\/ops\/runs\//.test(path)) opsJournals.push(path);
    });

    await open(page, 'eng');
    await expect(page.getByTestId('room-link-research').locator('.nx-unread')).toHaveText('1');
    expect(sockets).toHaveLength(1);
    expect(opsJournals).toHaveLength(0);

    const arrival = await control<{ id: number }>('/live-chat', {
      room: 'research',
      author: 'analyst',
      body: 'streamed retrieval update while another channel is open',
    });
    const research = page.getByTestId('room-link-research');
    await expect(research).toContainText('streamed retrieval update');
    await expect(research.locator('.nx-unread')).toHaveText('2');
    expect(summaryRequests).toHaveLength(1);

    await research.click();
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Research');
    await expect(page.getByTestId('room-working-eng')).toContainText('@scout is working');
    await expect(page.getByTestId(`msg-${arrival.id}`)).toContainText('streamed retrieval update');
    await expect(research.locator('.nx-unread')).toHaveCount(0);
    expect(sockets).toHaveLength(1);

    await page.getByTestId('room-link-ops').click();
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Ops');
    await expect.poll(() => opsJournals.length).toBeGreaterThan(0);
    expect(sockets).toHaveLength(1);

    const engReadsBeforeReturn = engJournals.length;
    await page.getByTestId('room-link-eng').click();
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Engineering');
    await expect(page.locator('.nx-skeleton')).toHaveCount(0);
    await page.waitForTimeout(250);
    expect(engJournals).toHaveLength(engReadsBeforeReturn);
    await expect(page.getByTestId('room-working-eng')).toContainText('@scout is working');
  });

  test('read state advances only after a substantive row stays visibly onscreen', async ({ page }) => {
    await control('/seed-runs', { count: 80 });
    await open(page, 'hydration');
    const row = page.getByTestId('room-link-hydration');
    await expect.poll(async () =>
      (await control<{ summary: { unread: number } }>('/room-support', { room: 'hydration' })).summary.unread,
    ).toBe(0);
    await expect(row.locator('.nx-unread')).toHaveCount(0);

    await page.getByTestId('timeline').evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new Event('scroll'));
      node.scrollTop = 0;
      node.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await expect(page.locator('.nx-jump')).toBeVisible();
    const scrolledArrival = await control<{ id: number }>('/live-chat', {
      room: 'hydration',
      author: 'archivist',
      body: 'unread while the reader is looking at older history',
    });
    await expect(page.getByTestId(`msg-${scrolledArrival.id}`)).toHaveCount(1);
    await expect(row.locator('.nx-unread')).toHaveText('1');
    await expect.poll(async () =>
      (await control<{ summary: { unread: number } }>('/room-support', { room: 'hydration' })).summary.unread,
    ).toBe(1);

    // Flying past the row for less than the dwell must not silently clear it.
    await page.getByTestId(`msg-${scrolledArrival.id}`).evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(100);
    await page.getByTestId('timeline').evaluate((node) => { node.scrollTop = 0; });
    await page.waitForTimeout(350);
    await expect(row.locator('.nx-unread')).toHaveText('1');

    // Holding the actual unread row in the focused viewport is the read edge.
    await page.getByTestId(`msg-${scrolledArrival.id}`).evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await expect(row.locator('.nx-unread')).toHaveCount(0);
    await expect.poll(async () =>
      (await control<{ summary: { unread: number } }>('/room-support', { room: 'hydration' })).summary.unread,
    ).toBe(0);

    await page.evaluate(() => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    });
    const hiddenArrival = await control<{ id: number }>('/live-chat', {
      room: 'hydration',
      author: 'archivist',
      body: 'unread while the room tab is hidden',
    });
    await expect.poll(async () =>
      (await control<{ summary: { unread: number } }>('/room-support', { room: 'hydration' })).summary.unread,
    ).toBe(1);

    await page.evaluate(() => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
      window.dispatchEvent(new FocusEvent('focus'));
    });
    await page.getByTestId(`msg-${hiddenArrival.id}`).evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await expect(row.locator('.nx-unread')).toHaveCount(0);
    await expect.poll(async () =>
      (await control<{ summary: { unread: number } }>('/room-support', { room: 'hydration' })).summary.unread,
    ).toBe(0);
  });
});

test.describe('support projections', () => {
  test('an inbox entry is self-contained even when its message is outside the tail', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    });
    const ids = await control<{ oldInboxMention: number; newInboxMention: number }>('/fixture-ids');
    await open(page, 'inbox');

    await expect(page.getByTestId(`msg-${ids.oldInboxMention}`)).toHaveCount(0);
    await expect(page.getByTestId('inbox-badge')).toHaveText('2');

    await page.getByTestId('inbox-toggle').click();
    const oldRow = page.getByTestId('inbox-panel').getByText('old incident report needs your review');
    await expect(oldRow).toBeVisible();
    await oldRow.click();
    await expect(page.getByTestId(`msg-${ids.oldInboxMention}`)).toBeInViewport();
    await expect(page.getByTestId('inbox-badge')).toHaveText('1');
  });

  test('a true reply clears its actionable inbox entry', async ({ page }) => {
    await open(page, 'inbox');
    await expect.poll(async () =>
      (await control<{ inbox: unknown[] }>('/room-support', { room: 'inbox' })).inbox.length,
    ).toBe(0);
    await expect(page.getByTestId('inbox-badge')).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
    const mention = await control<{ id: number }>('/live-chat', {
      room: 'inbox',
      author: 'inbox-reviewer',
      body: '@richard live incident report needs a reply',
    });
    await expect(page.getByTestId('inbox-badge')).toHaveText('1');
    await page.getByTestId(`msg-${mention.id}-quote`).evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.getByTestId('composer-reply')).toContainText(`#${mention.id}`);
    await page.getByTestId('composer-send').click();
    await expect(page.getByTestId('inbox-badge')).toHaveCount(0);
  });

  test('acknowledgements remain dedicated rows across refresh', async ({ page }) => {
    await open(page, 'acks');
    const ack = page.getByTestId('ack-acknowledger');
    await expect(ack).toHaveText(/@acknowledger acknowledged/);
    await expect(page.locator('.nx-run-block')).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.getByTestId('ack-acknowledger')).toHaveText(/@acknowledger acknowledged/);
  });
});
