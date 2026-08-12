import { expect, test, type Locator, type Page } from '@playwright/test';

import { revealOlder } from './history.js';

const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

interface ContinuationIds {
  room: string;
  main: { trigger: number; root: number; interjection: number; tail: number };
  ack: { trigger: number; root: number; interjection: number; result: number };
}

interface TranscriptUnit {
  kind: string;
  message_id?: number;
  root_message_id?: number;
  output_message_id?: number;
  event_indices?: number[];
}

interface TranscriptHistoryPage {
  units: TranscriptUnit[];
}

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
  await page.goto(`/?room=${room}&token=next-e2e-token`);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

async function clickRoom(page: Page, room: string): Promise<void> {
  const link = page.getByTestId(`room-link-${room}`);
  await expect(link).toBeVisible();
  await link.click();
  await expect(link).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

async function expectIdOrder(rows: Locator, count: number): Promise<void> {
  const boxes = await Promise.all(Array.from({ length: count }, (_, index) =>
    rows.nth(index).boundingBox()));
  expect(boxes.every((box) => box !== null)).toBe(true);
  for (let index = 1; index < boxes.length; index++) {
    expect(boxes[index - 1]!.y).toBeLessThan(boxes[index]!.y);
  }
}

function transcriptUnitKey(unit: TranscriptUnit): string {
  if (unit.kind === 'message') return `message:${String(unit.message_id)}`;
  return [
    unit.kind,
    String(unit.root_message_id),
    String(unit.output_message_id),
    (unit.event_indices ?? []).join(','),
  ].join(':');
}

async function renderedUnitKeys(page: Page): Promise<string[]> {
  return page.locator('[data-transcript-unit]').evaluateAll((nodes) => nodes
    .map((node) => node.getAttribute('data-transcript-unit'))
    .filter((key): key is string => key !== null));
}

// harn:assume live-runs-settle-beside-paged-history-once ref=live-history-settlement-regression
test.describe('durable continuation writer', () => {
  // harn:assume combined-head-adopts-authoritative-overlap-order ref=authoritative-order-lifecycle-browser-regression
  test('keeps a mutable production family ordered when hydration follows its first prose', async ({ page }) => {
    const { room } = await control<{ room: string }>('/continuation-room');
    const trigger = await control<{ id: number }>('/post-chat', {
      room, body: '@continuator stream a durable answer',
    });
    const live = await control<{ room: string; root: number }>('/live-family', { room });
    await control('/live-family-step', { room, step: 'evidence' });
    const interjection = await control<{ id: number }>('/live-family-step', {
      room, step: 'interject', body: 'Investigator interjection between stretches.',
    });

    let documentLoads = 0;
    page.on('request', (request) => {
      if (request.resourceType() === 'document') documentLoads += 1;
    });
    await openRoom(page, room);
    await expect(page.locator(`[id="${String(live.root)}"]`)).toContainText('Live root stretch.');

    const continuation = await control<{ id: number }>('/live-family-step', {
      room, step: 'continue', body: 'Live continuation stretch.',
    });
    await expect(page.locator(`[id="${String(continuation.id)}"]`)).toContainText('Live continuation stretch.');
    await control('/live-family-step', { room, step: 'interrupt' });

    const rows = page.locator('.nx-column > [id]');
    const familyIds = [trigger.id, live.root, interjection.id, continuation.id];
    await expect.poll(() => rows.evaluateAll((nodes, ids) => nodes.map((node) => Number(node.id))
      .filter((id) => ids.includes(id)), familyIds))
      .toEqual([trigger.id, live.root, interjection.id, continuation.id]);
    expect(documentLoads).toBe(1);
    const rootBlock = page.locator(`[id="${String(live.root)}"]`);
    await rootBlock.getByTestId('tool-batch').locator('.nx-batch-line').click();
    const coordinates = await page.evaluate((ids) => {
      const article = (id: number): HTMLElement => document.querySelector(`[id="${String(id)}"]`)!;
      const root = article(ids.root);
      return {
        order: [...document.querySelectorAll<HTMLElement>('.nx-column > [id]')]
          .map((node) => Number(node.id))
          .filter((id) => ids.all.includes(id)),
        root: root.querySelector<HTMLElement>('.nx-run')?.getBoundingClientRect().x,
        prose: root.querySelector<HTMLElement>('.nx-run-block')?.getBoundingClientRect().x,
        tool: root.querySelector<HTMLElement>('.nx-tool')?.getBoundingClientRect().x,
      };
    }, { root: live.root, all: [trigger.id, live.root, interjection.id, continuation.id] });
    expect(coordinates.order).toEqual([trigger.id, live.root, interjection.id, continuation.id]);
    expect(coordinates.prose).toBe(coordinates.root);
    expect(coordinates.tool).toBe(coordinates.root);
    await expect(page.locator(`[id="${String(interjection.id)}"]`)).toContainText('Investigator interjection');
  });
  // harn:end combined-head-adopts-authoritative-overlap-order

  // harn:assume combined-head-adopts-authoritative-overlap-order ref=authoritative-order-lifecycle-browser-regression
  test('keeps the production family in authoritative order when a live interjection is refreshed', async ({ page }) => {
    const { room } = await control<{ room: string }>('/continuation-room');
    const otherRoom = await control<{ room: string }>('/continuation-room');
    const historyUrl = `**/api/rooms/${room}/transcript-history`;
    let documentLoads = 0;
    page.on('request', (request) => {
      if (request.resourceType() === 'document') documentLoads += 1;
    });
    const initialResponse = page.waitForResponse(historyUrl);
    await openRoom(page, room);
    const initialPage = await (await initialResponse).json() as TranscriptHistoryPage;
    await control('/live-family', { room });
    const interjection = await control<{ id: number }>('/live-family-step', {
      room, step: 'interject', body: 'Authoritative-order interjection.',
    });

    // Reconnect while the family is still running. The only finalized unit in
    // this response is the permanent interjection; the family is still live.
    const reloadResponse = page.waitForResponse(historyUrl);
    await page.reload();
    await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(`[data-testid="msg-${String(interjection.id)}"]`)).toBeVisible();
    const reloadedPage = await (await reloadResponse).json() as TranscriptHistoryPage;
    expect(initialPage.units).toEqual([]);
    expect(reloadedPage.units.map(transcriptUnitKey)).toEqual([`message:${String(interjection.id)}`]);

    await control('/live-family-step', { room, step: 'evidence' });
    const continuation = await control<{ id: number }>('/live-family-step', {
      room, step: 'continue', body: 'Authoritative continuation.',
    });
    await expect(page.locator(`[data-testid="run-${String(continuation.id)}"]`)).toBeVisible();
    const settledHeadResponse = page.waitForResponse(historyUrl, { timeout: 15_000 });
    await control('/live-family-step', { room, step: 'interrupt' });

    const settledPage = await (await settledHeadResponse).json() as TranscriptHistoryPage;
    const authoritative = settledPage.units.map(transcriptUnitKey);
    await expect.poll(() => renderedUnitKeys(page)).toEqual(authoritative);

    const interjectionIndex = authoritative.indexOf(`message:${String(interjection.id)}`);
    const continuationIndex = authoritative.findIndex((key) => key.includes(`:${String(continuation.id)}:`));
    expect(interjectionIndex).toBeGreaterThanOrEqual(0);
    expect(continuationIndex).toBeGreaterThan(interjectionIndex);
    expect(new Set(await renderedUnitKeys(page)).size).toBe(authoritative.length);

    const documentLoadsBeforeSwitch = documentLoads;
    await clickRoom(page, otherRoom.room);
    const switchBackResponse = page.waitForResponse(historyUrl);
    await clickRoom(page, room);
    const switchBack = await (await switchBackResponse).json() as TranscriptHistoryPage;
    expect(switchBack.units.map(transcriptUnitKey)).toEqual(authoritative);
    expect(documentLoads).toBe(documentLoadsBeforeSwitch);
    const switchReloadResponse = page.waitForResponse(historyUrl);
    await page.reload();
    await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 15_000 });
    const reloaded = await (await switchReloadResponse).json() as TranscriptHistoryPage;
    expect(reloaded.units.map(transcriptUnitKey)).toEqual(authoritative);

    await control('/seed-bulk', { room, count: 25, newer: true });
    await page.reload();
    await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 15_000 });
    await page.addStyleTag({ content: '.nx-turn { min-height: 80px; }' });
    const familyTarget = page.locator(`[data-transcript-unit="${authoritative.at(-1)!}"]`);
    await revealOlder(page, familyTarget);
    const pagedKeys = await renderedUnitKeys(page);
    const familyPositions = authoritative.map((key) => pagedKeys.indexOf(key));
    expect(familyPositions.every((position) => position >= 0)).toBe(true);
    expect(familyPositions).toEqual([...familyPositions].sort((left, right) => left - right));
    expect(new Set(pagedKeys).size).toBe(pagedKeys.length);
  });
  // harn:end combined-head-adopts-authoritative-overlap-order

  // harn:assume combined-head-preserves-reader-unit-offset ref=head-reconciliation-reader-anchor-regression
  test('holds an unpinned intra-message anchor through delayed head materialization', async ({ page }) => {
    const seeded = await control<{ room: string }>('/seed-terminal-family', {
      shape: 'root-evidence', status: 'interrupted', gap: 0,
    });
    const { room } = seeded;
    const pinnedRoom = await control<{ room: string }>('/seed-terminal-family', {
      shape: 'root-evidence', status: 'interrupted', gap: 0,
    });
    await page.setViewportSize({ width: 1440, height: 500 });
    await openRoom(page, room);
    await page.addStyleTag({ content: '.nx-run-block { min-height: 240px; }' });

    const anchor = page.locator('[data-transcript-unit^="tool:"]').first();
    await expect(anchor).toBeVisible();
    const timeline = page.getByTestId('timeline');
    const placeAnchor = async (): Promise<void> => {
      await timeline.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
        node.dispatchEvent(new Event('scroll'));
        node.scrollTop = 0;
        node.dispatchEvent(new Event('scroll'));
      });
      await anchor.evaluate((row) => {
        const node = document.querySelector('[data-testid="timeline"]')!;
        node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top;
        node.dispatchEvent(new Event('scroll'));
      });
    };
    await placeAnchor();
    const anchorState = await anchor.evaluate((row) => {
      const node = document.querySelector('[data-testid="timeline"]')!;
      return {
        key: row.getAttribute('data-transcript-unit')!,
        offset: row.getBoundingClientRect().top - node.getBoundingClientRect().top,
      };
    });

    await control('/live-family', { room });
    await control('/live-family-step', {
      room, step: 'interject', body: 'Delayed-head anchor interjection.',
    });
    await page.reload();
    await expect(anchor).toBeVisible();
    await page.addStyleTag({ content: '.nx-run-block { min-height: 240px; }' });
    await placeAnchor();

    let releaseHead = (): void => undefined;
    let headHeld = false;
    const held = new Promise<void>((resolve) => { releaseHead = resolve; });
    let heldOnce = false;
    await page.route(`**/api/rooms/${room}/transcript-history`, async (route) => {
      const response = await route.fetch();
      if (!heldOnce && new URL(route.request().url()).search === '') {
        heldOnce = true;
        headHeld = true;
        await held;
      }
      await route.fulfill({ response });
    });

    await control('/live-family-step', { room, step: 'evidence' });
    await control('/live-family-step', { room, step: 'continue', body: 'Delayed-head continuation.' });
    await placeAnchor();
    const interrupt = control('/live-family-step', { room, step: 'interrupt' });
    await expect.poll(() => headHeld).toBe(true);
    const before = await anchor.evaluate((row) => {
      const node = document.querySelector('[data-testid="timeline"]')!;
      return row.getBoundingClientRect().top - node.getBoundingClientRect().top;
    });
    releaseHead();
    await interrupt;
    await expect.poll(async () => {
      const after = await anchor.evaluate((row) => {
        const node = document.querySelector('[data-testid="timeline"]')!;
        return row.getBoundingClientRect().top - node.getBoundingClientRect().top;
      });
      return Math.abs(after - before);
    }, { timeout: 10_000 }).toBeLessThanOrEqual(2);
    expect(anchorState.key).toBe(await anchor.getAttribute('data-transcript-unit'));

    // A second held head resolves while the reader is in another room. The
    // destination is already pinned at its true tail; the A response must not
    // carry its pending anchor or unpin state across that room boundary.
    await page.unroute(`**/api/rooms/${room}/transcript-history`);
    await control('/live-family', { room, handle: 'reviewer' });
    await control('/live-family-step', { room, handle: 'reviewer', step: 'evidence' });
    await control('/live-family-step', {
      room, handle: 'reviewer', step: 'interject', body: 'Second delayed-head interjection.',
    });
    await control('/live-family-step', {
      room, handle: 'reviewer', step: 'continue', body: 'Second delayed-head continuation.',
    });
    let releaseBackgroundHead = (): void => undefined;
    let backgroundHeadHeld = false;
    const backgroundHead = new Promise<void>((resolve) => { releaseBackgroundHead = resolve; });
    let backgroundHeadOnce = false;
    await page.route(`**/api/rooms/${room}/transcript-history`, async (route) => {
      const response = await route.fetch();
      if (!backgroundHeadOnce && new URL(route.request().url()).search === '') {
        backgroundHeadOnce = true;
        backgroundHeadHeld = true;
        await backgroundHead;
      }
      await route.fulfill({ response });
    });
    const secondInterrupt = control('/live-family-step', {
      room, handle: 'reviewer', step: 'interrupt',
    });
    await expect.poll(() => backgroundHeadHeld).toBe(true);
    await clickRoom(page, pinnedRoom.room);
    const pinnedTimeline = page.getByTestId('timeline');
    await expect.poll(() => pinnedTimeline.locator('[data-transcript-unit]').count())
      .toBeGreaterThan(0);
    const pinnedGap = (): Promise<number> => pinnedTimeline.evaluate((node) =>
      node.scrollHeight - node.scrollTop - node.clientHeight);
    await expect.poll(pinnedGap).toBeLessThanOrEqual(2);
    releaseBackgroundHead();
    await secondInterrupt;
    await expect.poll(pinnedGap).toBeLessThanOrEqual(2);
  });
  // harn:end combined-head-preserves-reader-unit-offset

  test('real turns preserve permanent chronology, evidence, and one acknowledgement live and after paging', async ({ page }) => {
    // A room of this repetition's own, opened BEFORE the turns start, makes
    // every row and journal event below a genuine live production-writer frame.
    const { room } = await control<{ room: string }>('/continuation-room');
    await openRoom(page, room);
    const ids = await control<ContinuationIds>('/run-continuation', { room });
    expect(ids).toEqual({
      room,
      main: { trigger: 1, root: 2, interjection: 3, tail: 4 },
      ack: { trigger: 5, root: 6, interjection: 7, result: 8 },
    });

    const root = page.locator(`article[id="${String(ids.main.root)}"]`);
    const interjection = page.locator(`article[id="${String(ids.main.interjection)}"]`);
    const tail = page.locator(`article[id="${String(ids.main.tail)}"]`);
    const orderedMain = page.locator(
      [ids.main.root, ids.main.interjection, ids.main.tail]
        .map((id) => `article[id="${String(id)}"]`).join(', '),
    );
    await expect(tail).toBeVisible();
    await expectIdOrder(orderedMain, 3);

    await expect(root).toContainText('First durable stretch');
    await expect(root).not.toContainText('Second durable stretch');
    await expect(interjection).toContainText('Operator interjection');
    await expect(tail).toContainText('Second durable stretch');
    await expect(tail).not.toContainText('First durable stretch');

    await expect(root.locator('.nx-permalink')).toHaveText(`#${String(ids.main.root)}`);
    await expect(interjection.locator('.nx-permalink')).toHaveText(`#${String(ids.main.interjection)}`);
    await expect(tail.locator('.nx-permalink')).toHaveText(`#${String(ids.main.tail)}`);
    await expect(root.locator('.nx-turn-meta')).toHaveCount(1);
    await expect(tail.locator('.nx-turn-meta')).toHaveCount(1);
    await expect(root).not.toHaveClass(/is-grouped/);
    await expect(tail).not.toHaveClass(/is-grouped/);

    // Both tools stay in one batch even though an empty reasoning summary sits
    // between call/result evidence. No tool evidence leaks onto the continuation.
    const batch = root.getByTestId('tool-batch');
    await expect(batch).toHaveCount(1);
    await batch.locator('.nx-batch-line').click();
    await expect(batch.locator('.nx-tool')).toHaveCount(2);
    await expect(tail.getByTestId('tool-batch')).toHaveCount(0);
    await expect(root.locator('[aria-label="Copy run block"]')).toHaveCount(1);
    await expect(tail.locator('[aria-label="Copy run block"]')).toHaveCount(1);
    await expect(page.getByText('Reasoning', { exact: true })).toHaveCount(0);

    const ack = page.getByTestId('ack-continuator');
    await expect(ack).toHaveCount(1);
    await expect(ack).toHaveText('@continuator acknowledged');
    await expect(ack).toHaveAttribute('id', String(ids.ack.result));
    await expect(page.locator(`[id="${String(ids.ack.root)}"]`)).toHaveCount(0);
    await expect(page.locator(`article[id="${String(ids.ack.interjection)}"]`))
      .toContainText('Operator interjection before the acknowledgement result.');

    // Push the subjects outside the strict cold tail. One deliberate history
    // page recovers them once, still in permanent id order and ACK-collapsed.
    await control('/seed-bulk', { room, count: 25 });
    await page.setViewportSize({ width: 1440, height: 500 });
    await openRoom(page, room);
    await expect(root).toHaveCount(0);
    await revealOlder(page, root);
    await expect(root).toHaveCount(1);
    await expect(interjection).toHaveCount(1);
    await expect(tail).toHaveCount(1);
    await expectIdOrder(orderedMain, 3);
    await expect(root).toContainText('First durable stretch');
    await expect(tail).toContainText('Second durable stretch');
    await expect(page.getByTestId('ack-continuator')).toHaveCount(1);
    await expect(page.getByTestId('ack-continuator')).toHaveAttribute('id', String(ids.ack.result));
    await expect(page.locator(`[id="${String(ids.ack.root)}"]`)).toHaveCount(0);

    const idsInDom = await page.locator('.nx-column > [id]').evaluateAll(
      (nodes) => nodes.map((node) => node.id),
    );
    expect(new Set(idsInDom).size).toBe(idsInDom.length);

    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target[0]}`))
      .toEqual([]);
  });

  // harn:assume missed-terminal-history-refreshes-through-combined-head ref=combined-history-head-regression
  test('a family finalized while backgrounded reconciles through combined history without a terminal journal read', async ({ page }) => {
    const { room } = await control<{ room: string }>('/stretch-room');
    const turn = await control<{ room: string; root: number }>('/stretch-turn', { room });
    const journalReads: number[] = [];
    const historyRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      const run = new RegExp(`^/api/rooms/${room}/runs/(\\d+)$`).exec(url.pathname);
      if (run) journalReads.push(Number(run[1]));
      if (url.pathname === `/api/rooms/${room}/transcript-history`) historyRequests.push(url.search);
    });
    await openRoom(page, room);
    await control('/stretch-step', { room, step: 'stretch', text: 'before background', own: false });
    await expect(page.locator('.nx-column')).toContainText('before background');
    await page.waitForTimeout(100);
    const readsBeforeSettlement = journalReads.filter((id) => id === turn.root).length;

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await control('/stretch-step', {
      room, step: 'stretch', text: 'completed while backgrounded', live: false,
    });
    await control('/stretch-step', { room, step: 'tools', live: false });
    await control('/stretch-step', { room, step: 'complete', live: false });
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      window.dispatchEvent(new Event('visibilitychange'));
    });

    await expect(page.locator('.nx-column')).toContainText('completed while backgrounded');
    await expect(page.getByTestId('tool-batch')).toHaveCount(1);
    await expect(page.locator('.nx-column').getByText('completed while backgrounded', { exact: false }))
      .toHaveCount(1);
    expect(journalReads.filter((id) => id === turn.root)).toHaveLength(readsBeforeSettlement);
    expect(historyRequests.length).toBeGreaterThanOrEqual(2);
  });
  // harn:end missed-terminal-history-refreshes-through-combined-head
});
// harn:end live-runs-settle-beside-paged-history-once
