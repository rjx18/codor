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

async function openRoom(page: Page): Promise<void> {
  await page.goto('/?room=eng&token=next-e2e-token');
  await expect(page.getByTestId('timeline')).toBeVisible();
}

test.describe('background live run evidence', () => {
  // harn:assume subscribed-live-run-events-survive-switch-and-history-retirement ref=run-event-browser-regression
  test('retains a background stream, appends its next event, and settles once', async ({ page }) => {
    test.setTimeout(60_000);
    const { room } = await control<{ room: string }>('/stretch-room');
    const journalReads: string[] = [];
    page.on('request', (request) => {
      const match = /\/api\/rooms\/([^/]+)\/runs\//.exec(new URL(request.url()).pathname);
      if (match?.[1] !== undefined) journalReads.push(match[1]);
    });

    await openRoom(page);
    await expect(page.getByTestId(`room-link-${room}`)).toBeVisible();
    await page.waitForTimeout(1_000);

    const turn = await control<{ room: string }>('/stretch-turn', { room });
    expect(turn.room).toBe(room);
    await control('/stretch-step', {
      room, step: 'stretch', text: 'background live event one', own: false,
    });
    await expect(page.getByTestId(`room-working-${room}`)).toBeVisible();
    // Let the subscribed background frame land before the deliberate room
    // switch; the browser contract is about preserving that live buffer, not
    // racing the first frame against navigation.
    await page.waitForTimeout(250);
    const targetJournalReadsBeforeSwitch = journalReads.filter((read) => read === room).length;

    // The room was subscribed while it was in the background. Returning to it
    // must render its retained buffer without turning selection into recovery.
    await page.getByTestId(`room-link-${room}`).click();
    await expect(page.locator('.nx-column')).toContainText('background live event one');
    expect(journalReads.filter((read) => read === room).length).toBe(targetJournalReadsBeforeSwitch);

    await control('/stretch-step', {
      room, step: 'stretch', text: 'background live event two', own: false,
    });
    await expect(page.locator('.nx-column')).toContainText('background live event two');

    await control('/stretch-step', { room, step: 'complete' });
    await expect(page.getByTestId(`room-working-${room}`)).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('.nx-column')).toContainText('background live event one');
    await expect(page.locator('.nx-column')).toContainText('background live event two');
    await expect(page.getByText('background live event one', { exact: false })).toHaveCount(1);
    await expect(page.getByText('background live event two', { exact: false })).toHaveCount(1);
  });
  // harn:end subscribed-live-run-events-survive-switch-and-history-retirement
});
