import { expect, test, type Page } from '@playwright/test';

// Large-room hydration regression (codex #516): a room with hundreds of runs used
// to trigger a triangular journal-request storm — 16,465 requests for 180 runs —
// which exhausted the browser's connection pool, left the live run's prose
// unfetched, and broke attachment uploads. These assertions pin the bounded,
// deduplicated behaviour. Cold-load message-count contracts belong to round 2.
const HYDRATION = '/?room=hydration&token=next-e2e-token';
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

interface SeedIds { liveRunId: number; neighbourRunId: number; orphanRunId: number; oldestId: number; nearTailId: number }

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

// harn:assume finalized-browser-history-is-combined-page-owned ref=combined-history-browser-regression
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
    // Combined history owns every archived run. Only the mutable live family may
    // use the full-journal endpoint during a cold load.
    expect(requests.every((id) => id === ids.liveRunId)).toBe(true);
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

  test('a cold load shows only the bounded tail, at the bottom, with no crawl', async ({ page }) => {
    const historyRequests: string[] = [];
    const historyResponses: Array<{ bytes: number; units: number }> = [];
    const journals = trackJournalRequests(page);
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/rooms/hydration/transcript-history') {
        historyRequests.push(url.search);
      }
    });
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.pathname !== '/api/rooms/hydration/transcript-history') return;
      void response.body().then((body) => {
        const parsed = JSON.parse(body.toString()) as { units: unknown[] };
        historyResponses.push({ bytes: body.byteLength, units: parsed.units.length });
      });
    });
    await page.addInitScript(() => {
      const counts: number[] = [];
      (window as unknown as { __timelineCounts: number[] }).__timelineCounts = counts;
      const record = (): void => {
        const column = document.querySelector('.nx-column');
        if (!column) return;
        const count = column.querySelectorAll('[data-transcript-unit]').length;
        if (count > 0 && counts.at(-1) !== count) counts.push(count);
      };
      const start = (): void => {
        new MutationObserver(record).observe(document.body, { childList: true, subtree: true });
        record();
      };
      if (document.body) start();
      else document.addEventListener('DOMContentLoaded', start, { once: true });
    });
    await page.goto(HYDRATION);
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.locator('article.nx-turn').first()).toBeVisible();

    await expect(page.locator('[data-transcript-unit]')).toHaveCount(20);
    await expect.poll(() => historyResponses.length).toBe(1);
    expect(historyRequests).toEqual(['']);
    expect(historyResponses[0]!.units).toBe(20);
    expect(historyResponses[0]!.bytes).toBeLessThan(128 * 1024);
    expect(journals.every((id) => id === ids.liveRunId)).toBe(true);
    console.info('[transcript-history-browser-metrics]', JSON.stringify({
      requests: historyRequests.length,
      bytes: historyResponses[0]!.bytes,
      units: historyResponses[0]!.units,
      mutableRunRequests: journals.length,
      finalizedRunRequests: journals.filter((id) => id !== ids.liveRunId).length,
    }));
    const counts = await page.evaluate(
      () => (window as unknown as { __timelineCounts: number[] }).__timelineCounts,
    );
    expect(Math.max(...counts)).toBe(20);

    // Bottom-anchored once the committed tail has painted. Polled, not sampled:
    // run rows keep growing as their journals render, and under a loaded machine
    // the sample could land between a growth and the tail-follow that answers it.
    await expect
      .poll(async () => page.getByTestId('timeline').evaluate(
        (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
      ), { timeout: 5000 })
      .toBeLessThan(80);
  });

  test('one top reach loads one stable page and preserves the visible anchor', async ({ page }) => {
    let releaseHistory = (): void => undefined;
    const held = new Promise<void>((resolve) => { releaseHistory = resolve; });
    let historyRequests = 0;
    await page.route('**/api/rooms/hydration/transcript-history*', async (route) => {
      const url = new URL(route.request().url());
      if (!url.searchParams.has('cursor')) return route.continue();
      historyRequests += 1;
      if (historyRequests !== 1) return route.continue();
      const response = await route.fetch();
      await held;
      return route.fulfill({ response });
    });

    await openRoom(page);
    const timeline = page.getByTestId('timeline');
    const rows = page.locator('[data-transcript-unit]');
    await expect(rows.first()).toBeVisible();
    const before = await rows.count();
    const anchor = await timeline.evaluate((node) => {
      node.scrollTop = 0;
      const row = node.querySelector<HTMLElement>('[data-transcript-unit]')!;
      return {
        unit: row.dataset.transcriptUnit!,
        offset: row.getBoundingClientRect().top - node.getBoundingClientRect().top,
      };
    });

    await timeline.evaluate((node) => {
      for (let index = 0; index < 12; index += 1) node.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(() => historyRequests).toBe(1);
    await expect(timeline).toHaveAttribute('aria-busy', 'true');

    releaseHistory();
    await expect(timeline).toHaveAttribute('aria-busy', 'false', { timeout: 10_000 });
    await expect(rows).toHaveCount(before + 20);
    const restoredOffset = await page.locator(`[data-transcript-unit="${anchor.unit}"]`).evaluate((row) =>
      row.getBoundingClientRect().top
      - document.querySelector('[data-testid="timeline"]')!.getBoundingClientRect().top);
    expect(Math.abs(restoredOffset - anchor.offset)).toBeLessThanOrEqual(2);

    // Releasing the latch at the old top caused an immediate second page before
    // the first restoration committed. It must remain at one until another
    // deliberate trip to the top.
    await page.waitForTimeout(400);
    expect(historyRequests).toBe(1);

    await timeline.evaluate((node) => { node.scrollTop = 0; });
    await expect.poll(() => historyRequests).toBe(2);
  });

  test('loaded tall runs keep one stable scrollbar height while traversing downward', async ({ page }) => {
    await openRoom(page);
    const timeline = page.getByTestId('timeline');
    const rows = page.locator('[data-transcript-unit]');

    // Make the archived run blocks decisively taller than the old 64px
    // content-visibility estimate. The real room has this shape naturally from
    // long prose and tool batches; the fixture pins it without huge journals.
    await page.addStyleTag({ content: '.nx-run-block { min-height: 240px; }' });
    await page.evaluate(() => document.fonts.ready);

    for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
      const before = await rows.count();
      await timeline.evaluate((node) => { node.scrollTop = 0; });
      await expect(rows).toHaveCount(before + 20, { timeout: 10_000 });
      await expect(timeline).toHaveAttribute('aria-busy', 'false', { timeout: 10_000 });
    }

    const beforeTraversal = await rows.count();
    const heights: number[] = [];
    for (const ratio of [0.2, 0.4, 0.6, 0.8, 1]) {
      heights.push(await timeline.evaluate(async (node, position) => {
        node.scrollTop = (node.scrollHeight - node.clientHeight) * position;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        return node.scrollHeight;
      }, ratio));
    }

    expect(await rows.count()).toBe(beforeTraversal);
    expect(new Set(heights)).toEqual(new Set([heights[0]]));
  });

  test('a deep link to a message beyond the tail pages back to it', async ({ page }) => {
    const historyResponses: Array<{ search: string; status: number; units?: number }> = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.pathname === '/api/rooms/hydration/transcript-history') {
        const record: { search: string; status: number; units?: number } = {
          search: url.search,
          status: response.status(),
        };
        historyResponses.push(record);
        void response.json().then((body: { units: unknown[] }) => { record.units = body.units.length; });
      }
    });
    // Bounding cold hydration created this case: the target sits hundreds of ids
    // below the tail, so a permalink can only land by paging history back.
    await openRoom(page);
    const target = page.getByTestId(`msg-${ids.oldestId}`);
    await expect(target).toHaveCount(0); // genuinely outside the hydrated tail

    await page.getByTestId('toggle-message-search').click();
    await page.getByTestId('search-input').fill('mariner beacon');
    const hit = page.getByTestId(`search-hit-${ids.oldestId}`);
    await expect(hit).toContainText('mariner beacon');
    await hit.click();

    await expect(page).toHaveURL(new RegExp(`#${ids.oldestId}$`));
    console.info('[transcript-history-target-walk]', JSON.stringify({
      pages: historyResponses.length,
      units: historyResponses.reduce((total, response) => total + (response.units ?? 0), 0),
      statuses: historyResponses.map((response) => response.status),
    }));
    await expect(target).toBeInViewport({ timeout: 15_000 });
  });

  test('a permalink jump releases the tail pin instead of snapping back', async ({ page }) => {
    // Paging in older history used to re-anchor the view to the newest message,
    // yanking the operator off the message they had just jumped to.
    // Jump to a target that sits above the tail but with ~40 messages BELOW it,
    // so staying put and snapping back to the tail are different positions.
    await openRoom(page);
    await page.getByTestId('toggle-message-search').click();
    await page.getByTestId('search-input').fill('pelican waypoint');
    await page.getByTestId(`search-hit-${ids.nearTailId}`).click();
    const target = page.getByTestId(`msg-${ids.nearTailId}`);
    await expect(target).toBeInViewport({ timeout: 15_000 });

    // The regression: the transcript stayed pinned across the jump, so the next
    // arrival re-anchored the view to the tail and yanked the operator off the
    // message they had just opened. A live message must not move them now.
    // (This pins the BEHAVIOUR. Two mechanisms now deliver it — the hashchange
    // release and the upward-scroll release — so it does not isolate either.)
    const arrival = await control<{ id: number }>('/live-chat', {
      room: 'hydration', body: 'arrival after the permalink jump', route: false,
    });
    await expect(page.getByTestId(`msg-${arrival.id}`)).toHaveCount(1, { timeout: 10_000 });
    await expect(target).toBeInViewport();
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
// harn:end finalized-browser-history-is-combined-page-owned
