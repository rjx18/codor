import { expect, test, type Page } from '@playwright/test';

// PWA startup. A bare `/` launch used to subscribe to a room literally named
// `default` that no account owns: the app opened a phantom channel, hydrated
// nothing, and left that subscription on the socket for reconnect logic to
// restore faithfully. Nothing here may ever put `default` on the wire.
const TOKEN = 'next-e2e-token';

/** Every `subscribe` frame this page sent, in order, as room ids. */
function trackSubscriptions(page: Page): string[] {
  const rooms: string[] = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', (frame) => {
      try {
        const parsed = JSON.parse(frame.payload as string) as { type?: string; room?: string };
        if (parsed.type === 'subscribe' && typeof parsed.room === 'string') rooms.push(parsed.room);
      } catch {
        // Binary or partial frames are not subscriptions.
      }
    });
  });
  return rooms;
}

async function launch(page: Page, url: string): Promise<void> {
  await page.goto(url);
}

test.describe('pwa startup room', () => {
  test('a bare launch opens a real room and never subscribes to default', async ({ page }) => {
    const subscribed = trackSubscriptions(page);
    await page.addInitScript((token) => {
      window.localStorage.setItem('codor:web-next:token-probe', token);
    }, TOKEN);

    // First visit carries the token; the bare launch follows.
    await launch(page, `/?token=${TOKEN}`);
    await expect(page.getByTestId('timeline')).toBeVisible();

    await launch(page, '/');
    await expect(page.getByTestId('timeline')).toBeVisible();

    // A real room, named in the URL, with its tail hydrated.
    await expect(page).toHaveURL(/\?room=[a-z0-9-]+/i);
    const room = new URL(page.url()).searchParams.get('room');
    expect(room).not.toBeNull();
    expect(room).not.toBe('default');
    await expect(page.locator('.nx-column > .nx-turn').first()).toBeVisible();

    expect(subscribed).not.toContain('default');
    expect(subscribed.length).toBeGreaterThan(0);
  });

  test('the remembered room survives a fresh bare launch', async ({ page }) => {
    const subscribed = trackSubscriptions(page);
    await launch(page, `/?room=design&token=${TOKEN}`);
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Design');

    await launch(page, '/');
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Design');
    await expect(page).toHaveURL(/room=design/);
    expect(subscribed).not.toContain('default');
  });

  test('an explicit authorized room overrides what was remembered', async ({ page }) => {
    await launch(page, `/?room=design&token=${TOKEN}`);
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Design');

    await launch(page, '/?room=ops');
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Ops');
    await expect(page).toHaveURL(/room=ops/);
  });

  test('an unauthorized explicit room falls back without subscribing to it', async ({ page }) => {
    const subscribed = trackSubscriptions(page);
    await launch(page, `/?token=${TOKEN}`);
    await expect(page.getByTestId('timeline')).toBeVisible();

    await launch(page, '/?room=no-such-channel');
    await expect(page.getByTestId('timeline')).toBeVisible();

    // It fell back to a real room, and never spoke the invalid id aloud.
    const room = new URL(page.url()).searchParams.get('room');
    expect(room).not.toBe('no-such-channel');
    expect(room).not.toBeNull();
    expect(subscribed).not.toContain('no-such-channel');
    expect(subscribed).not.toContain('default');
  });

  test('a stale remembered room is discarded on the next launch', async ({ page }) => {
    const subscribed = trackSubscriptions(page);
    await launch(page, `/?token=${TOKEN}`);
    await expect(page.getByTestId('timeline')).toBeVisible();

    // Poison the memory with a channel this account cannot see.
    await page.evaluate(() => {
      window.localStorage.setItem('codor:web-next:room', 'retired-channel');
    });

    await launch(page, '/');
    await expect(page.getByTestId('timeline')).toBeVisible();
    const room = new URL(page.url()).searchParams.get('room');
    expect(room).not.toBe('retired-channel');
    expect(subscribed).not.toContain('retired-channel');

    // The stale id is gone rather than retried on every future launch.
    expect(await page.evaluate(() => window.localStorage.getItem('codor:web-next:room')))
      .not.toBe('retired-channel');
  });

  test('deep links and back/forward still work', async ({ page }) => {
    await launch(page, `/?room=eng&token=${TOKEN}`);
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Engineering');

    await page.getByTestId('room-link-design').click();
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Design');

    await page.goBack();
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Engineering');
    await page.goForward();
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Design');
  });

  test('a fresh /settings launch resolves a real room for its connector', async ({ page }) => {
    const subscribed = trackSubscriptions(page);
    // No memory, no explicit room: Settings builds a connector, so resolving
    // late left it subscribing to the empty string.
    await launch(page, `/settings?token=${TOKEN}`);
    await expect(page.locator('.nx-settings')).toBeVisible();

    await expect(page).toHaveURL(/\/settings\?.*room=[a-z0-9-]+/i);
    const room = new URL(page.url()).searchParams.get('room');
    expect(room).not.toBe('');
    expect(room).not.toBe('default');
    expect(subscribed).not.toContain('');
    expect(subscribed).not.toContain('default');
    expect(subscribed.length).toBeGreaterThan(0);

    // Back returns to that same real room.
    await expect(page.locator('.nx-settings-back')).toHaveAttribute('href', `/?room=${String(room)}`);
  });

  test('a fresh /ledger launch never requests an empty-room ledger path', async ({ page }) => {
    const ledgerPaths: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.includes('/ledger')) ledgerPaths.push(path);
    });

    await launch(page, `/ledger?token=${TOKEN}`);
    await expect(page).toHaveURL(/\/ledger\?.*room=[a-z0-9-]+/i);
    const room = new URL(page.url()).searchParams.get('room');
    expect(room).not.toBe('');

    // /api/rooms//ledger is the empty-room shape this must never produce.
    await expect.poll(() => ledgerPaths.length).toBeGreaterThan(0);
    expect(ledgerPaths.some((path) => path.includes('/rooms//'))).toBe(false);
  });

  test('an unreachable channel list with nothing remembered says so, and opens nothing', async ({ page }) => {
    const subscribed = trackSubscriptions(page);
    // A failed lookup is unknown state, not an authorized empty set: claiming
    // "no channels" here would tell the operator their channels are gone when
    // the truth is that we could not ask.
    await page.route('**/api/rooms/summary**', async (route) => await route.abort());
    await page.route('**/api/rooms', async (route) => await route.abort());

    await launch(page, `/?token=${TOKEN}`);
    await expect(page.getByTestId('startup-unavailable')).toBeVisible();
    await expect(page.getByTestId('no-channels')).toHaveCount(0);
    await expect(page.getByTestId('startup-retry')).toBeVisible();
    expect(subscribed).toEqual([]);
  });

  test('an unreachable channel list resumes the remembered room and canonicalizes', async ({ page }) => {
    await launch(page, `/?room=design&token=${TOKEN}`);
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Design');

    await page.route('**/api/rooms/summary**', async (route) => await route.abort());
    await page.route('**/api/rooms', async (route) => await route.abort());

    await launch(page, '/');
    // It reopens what this device knows and says so in the URL.
    await expect(page).toHaveURL(/room=design/);
    expect(await page.evaluate(() => window.localStorage.getItem('codor:web-next:room')))
      .toBe('design');
    await expect(page.getByTestId('startup-unavailable')).toHaveCount(0);
  });

  test('an account with no channels sees a truthful empty state and opens nothing', async ({ page }) => {
    const subscribed = trackSubscriptions(page);
    // Both authorized-room sources report nothing, which is the only honest
    // way to reach this state without inventing a room.
    await page.route('**/api/rooms/summary**', async (route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({ rooms: [] }),
      });
    });
    await page.route('**/api/rooms', async (route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({ rooms: [] }),
      });
    });

    await launch(page, `/?token=${TOKEN}`);
    await expect(page.getByTestId('no-channels')).toBeVisible();
    await expect(page.getByTestId('timeline')).toHaveCount(0);
    expect(subscribed).toEqual([]);
  });
});
