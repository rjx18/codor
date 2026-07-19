import { expect, test, type Locator, type Page } from '@playwright/test';

import { revealOlder } from './history.js';

const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

interface ContinuationIds {
  room: string;
  main: { trigger: number; root: number; interjection: number; tail: number };
  ack: { trigger: number; root: number; interjection: number; result: number };
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

async function expectIdOrder(rows: Locator, count: number): Promise<void> {
  const boxes = await Promise.all(Array.from({ length: count }, (_, index) =>
    rows.nth(index).boundingBox()));
  expect(boxes.every((box) => box !== null)).toBe(true);
  for (let index = 1; index < boxes.length; index++) {
    expect(boxes[index - 1]!.y).toBeLessThan(boxes[index]!.y);
  }
}

test.describe('durable continuation writer', () => {
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
});
