import { expect, test, type Page } from '@playwright/test';

// Large-room hydration regression (codex #516): a room with hundreds of runs used
// to trigger a triangular journal-request storm — 16,465 requests for 180 runs —
// which exhausted the browser's connection pool, left the live run's prose
// unfetched, and broke attachment uploads. These assertions pin the bounded,
// deduplicated behaviour. Cold-load message-count contracts belong to round 2.
const HYDRATION = '/?room=hydration&token=next-e2e-token';
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

interface SeedIds { liveRunId: number; neighbourRunId: number; orphanRunId: number }

async function control<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** Journal requests this page issued, in order, as run ids. */
function trackJournalRequests(page: Page): number[] {
  const seen: number[] = [];
  page.on('request', (request) => {
    const match = /^\/api\/rooms\/hydration\/runs\/(\d+)$/.exec(new URL(request.url()).pathname);
    if (match) seen.push(Number(match[1]));
  });
  return seen;
}

async function openRoom(page: Page): Promise<void> {
  await page.goto(HYDRATION);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

let ids: SeedIds;

test.beforeAll(async () => {
  ids = await control<SeedIds>('/seed-runs', { count: 180 });
});

test.describe('large-room hydration', () => {
  test('journal requests stay bounded and deduplicated, and the live run is never starved', async ({ page }) => {
    const requests = trackJournalRequests(page);
    await openRoom(page);

    // The live run's prose is what the storm starved: /runs/508 was requested
    // zero times. It must load promptly rather than queue behind the archive —
    // that is the priority guarantee, observable as the prose simply arriving.
    await expect(page.locator('.nx-run-block', { hasText: 'live hydration prose' }))
      .toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(2000); // let hydration finish issuing whatever it will

    expect(requests).toContain(ids.liveRunId);
    // Deduplicated: no journal is fetched more than twice (a running run may be
    // re-read once when it settles), where the storm hit /runs/2 181 times.
    const perId = new Map<number, number>();
    for (const id of requests) perId.set(id, (perId.get(id) ?? 0) + 1);
    expect(Math.max(...perId.values())).toBeLessThanOrEqual(2);
    // Bounded: at most one request per run in the room, not thousands.
    expect(requests.length).toBeLessThanOrEqual(new Set(requests).size * 2);
    expect(requests.length).toBeLessThan(500);
  });

  test('the live run keeps its prose across a reload', async ({ page }) => {
    await openRoom(page);
    await expect(page.locator('.nx-run-block', { hasText: 'live hydration prose' })).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.locator('.nx-run-block', { hasText: 'live hydration prose' })).toBeVisible();
  });

  test('an empty interrupted run keeps its own header, number and status', async ({ page }) => {
    await openRoom(page);
    const orphan = page.getByTestId(`run-${String(ids.orphanRunId)}`);
    await expect(orphan).toBeVisible();

    // Standalone: never folded into the neighbouring same-author turn.
    await expect(orphan).not.toHaveClass(/is-grouped/);
    await expect(orphan.locator('.nx-turn-meta')).toHaveCount(1);
    await expect(orphan.locator('.nx-permalink')).toHaveText(`#${String(ids.orphanRunId)}`);
    await expect(orphan.getByTestId(`run-${String(ids.orphanRunId)}-status`)).toContainText('run interrupted');
    await expect(orphan.getByTestId('run-error')).toContainText('restarted mid-turn');
  });

  test('an attachment upload during hydration still reaches the server', async ({ page }) => {
    await page.goto(HYDRATION);
    await expect(page.getByTestId('timeline')).toBeVisible();
    // Upload immediately, while the room is still hydrating hundreds of runs —
    // this is what the exhausted request pool used to break.
    await page.setInputFiles('[data-testid="composer-file"]', [
      { name: 'during-hydration.txt', mimeType: 'text/plain', buffer: Buffer.from('uploaded mid-hydration\n') },
    ]);
    await expect(page.getByTestId('attach-tray').locator('.nx-attach-chip')).toHaveCount(1);
    await expect(page.getByTestId('attach-tray')).toContainText('during-hydration.txt');
  });
});
