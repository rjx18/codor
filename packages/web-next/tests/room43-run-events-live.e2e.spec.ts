import { expect, test, type Page } from '@playwright/test';

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

async function openRoom(page: Page, room: string): Promise<void> {
  await page.goto(`/?room=${encodeURIComponent(room)}&token=next-e2e-token`);
  await expect(page.getByTestId('timeline')).toBeVisible();
}

test.describe('background live run evidence', () => {
  // harn:assume active-run-segments-follow-established-transcript-time ref=active-run-segment-browser-regression
  test('keeps A, an interjection, and B ordered while active and after finalization', async ({ page }) => {
    const { room } = await control<{ room: string }>('/stretch-room');
    await openRoom(page, room);
    await control('/stretch-turn', { room, legacy: true, mode: 'block' });

    await control('/stretch-step', {
      room, step: 'stretch', text: 'Active chronology block A', own: false,
    });
    await expect(page.getByText('Active chronology block A', { exact: true })).toBeVisible();

    await control('/live-chat', {
      room, body: 'Interjection between active blocks', route: false,
    });
    await expect(page.getByText('Interjection between active blocks', { exact: true })).toBeVisible();

    await control('/stretch-step', {
      room, step: 'stretch', text: 'Active chronology block B', own: false,
    });
    await expect(page.getByText('Active chronology block B', { exact: true })).toBeVisible();

    const positions = async (): Promise<number[]> => page.locator('.nx-column > .nx-turn')
      .evaluateAll((nodes) => [
        nodes.findIndex((node) => node.textContent?.includes('Active chronology block A')),
        nodes.findIndex((node) => node.textContent?.includes('Interjection between active blocks')),
        nodes.findIndex((node) => node.textContent?.includes('Active chronology block B')),
      ]);
    await expect.poll(positions).toEqual([0, 1, 2]);
    await expect(page.locator('.nx-run[data-run-status="running"]')).toHaveCount(2);

    await control('/stretch-step', { room, step: 'complete' });
    await expect(page.getByTestId(`room-working-${room}`)).toHaveCount(0);
    await expect.poll(positions).toEqual([0, 1, 2]);
    await expect(page.getByText('Active chronology block A', { exact: true })).toHaveCount(1);
    await expect(page.getByText('Active chronology block B', { exact: true })).toHaveCount(1);
  });
  // harn:end active-run-segments-follow-established-transcript-time

  // harn:assume subscribed-live-run-events-survive-switch-and-history-retirement ref=run-event-browser-regression
  test('retains A events across A-to-B-to-A, appends, and settles once', async ({ page }) => {
    test.setTimeout(60_000);
    const { room } = await control<{ room: string }>('/stretch-room');
    const journalReads: string[] = [];
    page.on('request', (request) => {
      const match = /\/api\/rooms\/([^/]+)\/runs\//.exec(new URL(request.url()).pathname);
      if (match?.[1] !== undefined) journalReads.push(match[1]);
    });

    // A is the selected room first. The previous regression started with A
    // already backgrounded and therefore did not exercise the real switch.
    await openRoom(page, room);
    await expect(page.getByTestId(`room-link-${room}`)).toBeVisible();
    await expect(page.getByTestId('room-link-eng')).toBeVisible();
    await page.waitForTimeout(1_000);

    const turn = await control<{ room: string }>('/stretch-turn', { room });
    expect(turn.room).toBe(room);
    await control('/stretch-step', {
      room, step: 'stretch', text: 'A live event one', own: false,
    });
    await expect(page.getByTestId(`room-working-${room}`)).toBeVisible();
    await expect(page.locator('.nx-column')).toContainText('A live event one');
    // Let the subscribed background frame land before the deliberate room
    // switch; the browser contract is about preserving that live buffer, not
    // racing the first frame against navigation.
    await page.waitForTimeout(250);
    const targetJournalReadsBeforeSwitch = journalReads.filter((read) => read === room).length;

    // B is selected while A remains subscribed in the background. Events 2/3
    // must append to A's bounded buffer even though B owns the visible column.
    await page.getByTestId('room-link-eng').click();
    await expect(page).toHaveURL(/room=eng/);
    await control('/stretch-step', {
      room, step: 'stretch', text: 'A live event two', own: false,
    });
    await control('/stretch-step', {
      room, step: 'stretch', text: 'A live event three', own: false,
    });
    await expect(page.getByTestId(`room-working-${room}`)).toBeVisible();

    // Returning to A must render all retained events immediately without a
    // journal read or any replacement socket/reconnect behavior.
    await page.getByTestId(`room-link-${room}`).click();
    await expect(page).toHaveURL(new RegExp(`room=${room}`));
    await expect(page.locator('.nx-column')).toContainText('A live event one');
    await expect(page.locator('.nx-column')).toContainText('A live event two');
    await expect(page.locator('.nx-column')).toContainText('A live event three');
    expect(journalReads.filter((read) => read === room).length).toBe(targetJournalReadsBeforeSwitch);

    await control('/stretch-step', {
      room, step: 'stretch', text: 'A live event four', own: false,
    });
    await expect(page.locator('.nx-column')).toContainText('A live event four');

    await control('/stretch-step', { room, step: 'complete' });
    await expect(page.getByTestId(`room-working-${room}`)).toHaveCount(0, { timeout: 20_000 });
    for (const text of ['A live event one', 'A live event two', 'A live event three', 'A live event four']) {
      await expect(page.locator('.nx-column')).toContainText(text);
      await expect(page.getByText(text, { exact: false })).toHaveCount(1);
    }
  });
  // harn:end subscribed-live-run-events-survive-switch-and-history-retirement

  // harn:assume hosted-support-active-run-transcript-projection ref=direct-support-active-run-browser-regression
  test('renders a preconnection active support run through the direct journal path', async ({ page }) => {
    test.setTimeout(120_000);
    // This is the alpha.1-compatible shape: the running root remains in the
    // support snapshot while the bounded message tail is filled past it.
    const live = await control<{ room: string; root: number }>('/live-family', { handle: 'alpha-direct' });
    await control('/live-family-step', { room: live.room, handle: 'alpha-direct', step: 'evidence' });
    for (let index = 0; index < 25; index += 1) {
      await control('/post-chat', {
        room: live.room,
        body: `bounded direct filler ${String(index + 1)}`,
      });
    }
    const tail = await control<{ ids: number[] }>('/tail-ids', { room: live.room, limit: 20 });
    expect(tail.ids).not.toContain(live.root);

    const journalReads: string[] = [];
    page.on('request', (request) => {
      const match = /\/api\/rooms\/([^/]+)\/runs\//.exec(new URL(request.url()).pathname);
      if (match?.[1] !== undefined) journalReads.push(match[1]);
    });
    await openRoom(page, live.room);
    await expect(page.locator('.nx-column')).toContainText('Live root stretch.', { timeout: 30_000 });
    await expect(page.locator('.nx-column').getByText('Live root stretch.', { exact: false })).toHaveCount(1);
    await expect.poll(() => journalReads.filter((room) => room === live.room).length).toBeGreaterThan(0);

    const later = 'Direct alpha later event';
    await control('/live-family-step', {
      room: live.room, handle: 'alpha-direct', step: 'continue', body: later,
    });
    await expect(page.locator('.nx-column').getByText(later, { exact: false })).toHaveCount(1);

    await control('/live-family-step', { room: live.room, handle: 'alpha-direct', step: 'interrupt' });
    await expect(page.locator('.nx-column').getByText('Live root stretch.', { exact: false })).toHaveCount(1);
    await expect(page.locator('.nx-column').getByText(later, { exact: false })).toHaveCount(1);
  });
  // harn:end hosted-support-active-run-transcript-projection
});
