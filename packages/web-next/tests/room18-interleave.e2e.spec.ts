import { expect, test, type Page } from '@playwright/test';

// The interleave room isolates a single agent (@weaver) so the test can drive a
// live run of two prose stretches, drop a human message between them via the
// control port, and prove the writer gives both stretches permanent chronology.
const INTERLEAVE = '/?room=interleave&token=next-e2e-token';
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

interface Progress {
  runId: number | null;
  status: string | null;
  blocks: number;
  outputIds: number[];
}

async function control<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${await res.text()}`);
  return res.json() as Promise<T>;
}

const progress = (): Promise<Progress> =>
  control<Progress>('/run-progress', { room: 'interleave', handle: 'weaver' });

async function pollUntil(pred: (p: Progress) => boolean, timeoutMs = 15_000): Promise<Progress> {
  const start = Date.now();
  for (;;) {
    const snapshot = await progress();
    if (pred(snapshot)) return snapshot;
    if (Date.now() - start > timeoutMs) throw new Error(`run-progress never satisfied: ${JSON.stringify(snapshot)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function openRoom(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

test.describe('mid-run interleave', () => {
  test('a human message posted between two run blocks lands between them', async ({ page }) => {
    await openRoom(page, INTERLEAVE);

    // Two distinct prose blocks — an empty reasoning summary between them breaks
    // text_delta coalescing (and is itself dropped from the transcript), so the
    // run presents two blocks. The delay leaves a real window to interject.
    await control('/enqueue', {
      turns: [
        {
          kind: 'complete',
          final_text: 'First half streamed before the interjection. Second half streamed after the interjection.',
          item_delay_ms: 1000,
          items: [
            { type: 'run.item', item_type: 'text_delta', payload: { text: 'First half streamed before the interjection.' } },
            { type: 'run.item', item_type: 'reasoning_summary', payload: { text: '' } },
            { type: 'run.item', item_type: 'text_delta', payload: { text: 'Second half streamed after the interjection.' } },
          ],
        },
      ],
    });

    await control('/start-run', { room: 'interleave', handle: 'weaver', prompt: 'stream two blocks' });

    // Journaling is live per event: wait until block one is journaled but block
    // two has not yet streamed, then drop the interjection so its timestamp falls
    // strictly between the two blocks.
    const started = await pollUntil((p) => p.blocks >= 1);
    const interjection = await control<{ id: number }>('/post-chat', {
      room: 'interleave', body: 'interjecting between the two blocks',
    });

    // Let the run finish so its now-finalized blocks flatten around the interjection.
    const completed = await pollUntil((p) => p.status === 'completed');
    expect(completed.outputIds).toHaveLength(2);
    expect(completed.outputIds[0]).toBe(started.runId);

    // Reload to assert the durable, re-fetched ordering rather than a live frame.
    await openRoom(page, INTERLEAVE);
    const turns = page.locator('.nx-column > .nx-turn');
    await expect(turns.filter({ hasText: 'Second half streamed' })).toBeVisible();
    const texts = await turns.allTextContents();
    const indexOf = (part: string) => texts.findIndex((text) => text.includes(part));

    expect(indexOf('First half streamed')).toBeGreaterThanOrEqual(0);
    expect(indexOf('First half streamed')).toBeLessThan(indexOf('interjecting between the two blocks'));
    expect(indexOf('interjecting between the two blocks')).toBeLessThan(indexOf('Second half streamed'));

    // The lifecycle root and later output are separate permanent messages. The
    // operator row sits between their immutable ids; no hard UI grouping can
    // pull the root down when the continuation lands.
    const rootId = completed.outputIds[0]!;
    const tailId = completed.outputIds[1]!;
    expect(rootId).toBeLessThan(interjection.id);
    expect(interjection.id).toBeLessThan(tailId);
    const root = page.locator(`article[id="${String(rootId)}"]`);
    const tail = page.locator(`article[id="${String(tailId)}"]`);
    await expect(root).toHaveCount(1);
    await expect(tail).toHaveCount(1);
    await expect(root.locator('.nx-permalink')).toHaveText(`#${String(rootId)}`);
    await expect(tail.locator('.nx-permalink')).toHaveText(`#${String(tailId)}`);
    await expect(root).not.toHaveClass(/is-grouped/);
    await expect(tail).not.toHaveClass(/is-grouped/);

    // Permanent output rows must not introduce duplicate DOM ids.
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
  });
});
