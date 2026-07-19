import { expect, test, type Locator, type Page } from '@playwright/test';

import { revealOlder } from './history.js';

const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

interface ContinuationIds { room: string; root: number; interjection: number; tail: number }

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

async function expectIdOrder(rows: Locator): Promise<void> {
  const boxes = await Promise.all([0, 1, 2].map((index) => rows.nth(index).boundingBox()));
  expect(boxes.every((box) => box !== null)).toBe(true);
  expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y);
  expect(boxes[1]!.y).toBeLessThan(boxes[2]!.y);
}

test.describe('durable continuation reader', () => {
  test('live and reloaded rows stay #1/#2/#3 with evidence on its permanent output row', async ({ page }) => {
    // A room of this repetition's own, opened BEFORE the rows exist, so their
    // arrival is genuinely live and the ids are always 1/2/3.
    const { room } = await control<{ room: string }>('/continuation-room');
    await openRoom(page, room);
    const ids = await control<ContinuationIds>('/seed-continuation', { room });
    expect(ids).toEqual({ room, root: 1, interjection: 2, tail: 3 });

    const root = page.locator('article[id="1"]');
    const interjection = page.locator('article[id="2"]');
    const tail = page.locator('article[id="3"]');
    await expect(tail).toBeVisible();
    await expectIdOrder(page.locator('article[id="1"], article[id="2"], article[id="3"]'));

    await expect(root).toContainText('First durable stretch');
    await expect(root).not.toContainText('Second durable stretch');
    await expect(interjection).toContainText('Operator interjection');
    await expect(tail).toContainText('Second durable stretch');
    await expect(tail).not.toContainText('First durable stretch');

    await expect(root.locator('.nx-permalink')).toHaveText('#1');
    await expect(interjection.locator('.nx-permalink')).toHaveText('#2');
    await expect(tail.locator('.nx-permalink')).toHaveText('#3');
    await expect(root.locator('.nx-turn-meta')).toHaveCount(1);
    await expect(tail.locator('.nx-turn-meta')).toHaveCount(1);
    await expect(root).not.toHaveClass(/is-grouped/);
    await expect(tail).not.toHaveClass(/is-grouped/);

    // Both tools stay in one batch even though an empty reasoning summary sits
    // between call/result evidence. No tool evidence leaks onto continuation #3.
    const batch = root.getByTestId('tool-batch');
    await expect(batch).toHaveCount(1);
    await batch.locator('.nx-batch-line').click();
    await expect(batch.locator('.nx-tool')).toHaveCount(2);
    await expect(tail.getByTestId('tool-batch')).toHaveCount(0);
    await expect(root.locator('[aria-label="Copy run block"]')).toHaveCount(1);
    await expect(tail.locator('[aria-label="Copy run block"]')).toHaveCount(1);
    await expect(page.getByText('Reasoning', { exact: true })).toHaveCount(0);

    // Push the three subjects outside the strict cold tail. One deliberate
    // history page must recover them once, still in permanent id order.
    await control('/seed-bulk', { room, count: 25 });
    await page.setViewportSize({ width: 1440, height: 500 });
    await openRoom(page, room);
    await expect(root).toHaveCount(0);
    await revealOlder(page, root);
    await expect(root).toHaveCount(1);
    await expect(interjection).toHaveCount(1);
    await expect(tail).toHaveCount(1);
    await expectIdOrder(page.locator('article[id="1"], article[id="2"], article[id="3"]'));
    await expect(root).toContainText('First durable stretch');
    await expect(tail).toContainText('Second durable stretch');

    const idsInDom = await page.locator('.nx-column > [id]').evaluateAll(
      (nodes) => nodes.map((node) => node.id),
    );
    expect(new Set(idsInDom).size).toBe(idsInDom.length);

    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target[0]}`))
      .toEqual([]);
  });
});
