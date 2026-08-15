import { expect, test, type Page } from '@playwright/test';

const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
const SPA_ORIGIN = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_SPA_PORT ?? '28139'}`;
const HYDRATION = '/?room=hydration&token=next-e2e-token';

async function control<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`control ${path} failed: ${String(response.status)}`);
  return (await response.json()) as T;
}

async function pasteCode(page: Page, code: string): Promise<void> {
  await page.getByTestId('pairing-code-0').evaluate((element, pasted) => {
    const data = new DataTransfer();
    data.setData('text/plain', pasted);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, code);
}

async function pairLive(page: Page, shortBoot = false): Promise<void> {
  await control('/relay-up');
  const { code, relayUrl } = await control<{ code: string; relayUrl: string }>('/relay-pair');
  await page.addInitScript(({ url, short }) => {
    const runtime = window as unknown as Record<string, unknown>;
    runtime.__CODOR_RELAY_URL = url;
    runtime.__codorRelayHttp = [];
    runtime.__codorRelayAppOpens = [];
    runtime.__codorRoomSubscribes = [];
    if (short) {
      runtime.__CODOR_SESSION_BOOT_MS = 200;
      runtime.__CODOR_SESSION_REQUEST_MS = 300;
    }
  }, { url: relayUrl, short: shortBoot });
  await page.goto(`${SPA_ORIGIN}/`);
  await pasteCode(page, code);
  await page.getByTestId('pairing-code-submit').click();
  await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
}

// harn:assume hosted-managed-bootstrap-reacts-to-late-readiness ref=reactive-managed-bootstrap-regression
// harn:assume hosted-background-rooms-hydrate-metadata-until-promoted ref=background-room-promotion-regression
test.describe('hosted smooth startup budgets', () => {
  test('uses manager-owned bootstrap requests and promotes one zero-history room once', async ({ page }) => {
    test.setTimeout(120_000);
    await pairLive(page);
    await expect.poll(async () => await page.evaluate(() => (
      (window as unknown as { __codorRelayHttp: Array<{ target: string }> }).__codorRelayHttp
        .filter((entry) => entry.target.includes('/transcript-history')).length
    ))).toBe(1);

    const before = await page.evaluate(() => ({
      http: (window as unknown as { __codorRelayHttp: unknown[] }).__codorRelayHttp,
      app: (window as unknown as { __codorRelayAppOpens: unknown[] }).__codorRelayAppOpens,
      subscriptions: (window as unknown as { __codorRoomSubscribes: unknown[] }).__codorRoomSubscribes,
    })) as {
      http: Array<{ target: string; durationMs: number; bytes: number; status?: number }>;
      app: unknown[];
      subscriptions: Array<{ room: string; hydrateLimit: number; sinceSeq: number }>;
    };
    const matching = (path: string): number => before.http.filter((entry) => entry.target.startsWith(path)).length;
    expect(matching('/api/auth/challenge')).toBe(1);
    expect(matching('/api/auth/session')).toBe(1);
    expect(matching('/api/rooms/summary')).toBe(1);
    expect(matching('/api/client-compatibility')).toBe(0);
    expect(before.http.filter((entry) => entry.target.includes('/transcript-history'))).toHaveLength(1);
    expect(before.app).toHaveLength(1);
    expect(before.subscriptions.find((entry) => entry.room === 'eng' && entry.hydrateLimit === 20)).toBeTruthy();
    expect(before.subscriptions.find((entry) => entry.room === 'design' && entry.hydrateLimit === 0)).toBeTruthy();

    await page.getByTestId('room-link-design').click();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect.poll(async () => await page.evaluate(() => (
      (window as unknown as {
        __codorRoomSubscribes: Array<{ room: string; hydrateLimit: number }>;
      }).__codorRoomSubscribes.filter((entry) => entry.room === 'design' && entry.hydrateLimit === 20).length
    ))).toBe(1);
    await page.getByTestId('room-link-eng').click();
    await page.getByTestId('room-link-design').click();
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (
      (window as unknown as {
        __codorRoomSubscribes: Array<{ room: string; hydrateLimit: number }>;
      }).__codorRoomSubscribes.filter((entry) => entry.room === 'design' && entry.hydrateLimit === 20).length
    ))).toBe(1);

    console.info('[hosted-startup-browser-metrics]', JSON.stringify({
      requests: before.http.length,
      responseBytes: before.http.reduce((total, entry) => total + entry.bytes, 0),
      requestDurationMs: Number(before.http.reduce((total, entry) => total + entry.durationMs, 0).toFixed(1)),
      appSockets: before.app.length,
      hydrationBudgets: before.subscriptions.reduce<Record<string, number>>((counts, entry) => {
        const key = String(entry.hydrateLimit);
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      }, {}),
    }));
  });

  // harn:assume floating-room-loading-pill-uses-existing-priority ref=floating-pill-browser-regression
  // harn:assume prioritized-room-loading-pill-uses-existing-readiness ref=loading-pill-browser-regression
  test('shows one prioritized loading pill for direct history work', async ({ page }) => {
    test.setTimeout(120_000);
    let releaseHead = (): void => undefined;
    const headHeld = new Promise<void>((resolve) => { releaseHead = resolve; });
    let releaseCursor = (): void => undefined;
    const cursorHeld = new Promise<void>((resolve) => { releaseCursor = resolve; });
    let headWasHeld = false;
    let cursorWasHeld = false;
    await page.route('**/api/rooms/hydration/transcript-history*', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.has('cursor')) {
        cursorWasHeld = true;
        const response = await route.fetch();
        await cursorHeld;
        await route.fulfill({ response });
        return;
      }
      if (!headWasHeld) {
        headWasHeld = true;
        await headHeld;
      }
      await route.continue();
    });

    await control('/seed-runs', { count: 180 });
    await page.goto(HYDRATION);
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect.poll(() => headWasHeld).toBe(true);
    const pill = page.getByTestId('reconnecting-pill');
    await expect(pill).toHaveAttribute('data-loading-state', 'syncing', { timeout: 30_000 });
    await expect(pill).toHaveClass(/nx-loading-pill/);
    await expect(pill.getByTestId('loading-pill-spinner')).toBeVisible();
    expect(await pill.evaluate((element) => getComputedStyle(element).position)).toBe('absolute');
    await expect(pill).toHaveText('Syncing messages');
    await expect(page.locator('[data-loading-state]')).toHaveCount(1);
    releaseHead();
    await expect(pill).toHaveCount(0, { timeout: 30_000 });

    const timeline = page.getByTestId('timeline');
    await timeline.evaluate((node) => {
      node.scrollTop = 0;
      for (let index = 0; index < 12; index += 1) node.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(() => cursorWasHeld).toBe(true);
    await expect(pill).toHaveAttribute('data-loading-state', 'older', { timeout: 30_000 });
    await expect(pill).toHaveClass(/nx-loading-pill/);
    await expect(pill.getByTestId('loading-pill-spinner')).toBeVisible();
    await expect(page.locator('[data-loading-state]')).toHaveCount(1);
    releaseCursor();
    await expect(pill).toHaveCount(0, { timeout: 30_000 });
  });
  // harn:end prioritized-room-loading-pill-uses-existing-readiness
  // harn:end floating-room-loading-pill-uses-existing-priority

  // harn:assume hosted-last-good-room-cache-is-bounded-read-only-projection ref=hosted-last-good-room-regression
  // harn:assume readable-reconnecting-room-never-admits-mutation ref=nonmodal-reconnecting-regression
  // harn:assume readable-reconnecting-room-never-admits-mutation ref=offline-composer-http-regression
  test('a cold cached reload is readable within one second and live truth replaces it in place', async ({ page }) => {
    test.setTimeout(120_000);
    const mediaMutations: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST'
        && (/\/attachments(?:\?|$)/.test(request.url()) || request.url().includes('/api/voice/transcribe'))) {
        mediaMutations.push(request.url());
      }
    });
    await pairLive(page);
    await expect(page.getByTestId('composer-mic')).toHaveCount(1);
    const liveInput = page.getByTestId('composer-input');
    const retainedDraft = '@viewer preserve retained draft';
    await liveInput.fill(retainedDraft);
    await control('/relay-down');
    const reconnectingPill = page.getByTestId('reconnecting-pill');
    await expect(reconnectingPill).toBeVisible({ timeout: 30_000 });
    await expect(reconnectingPill).toHaveAttribute('data-loading-state', 'reconnecting');
    await expect(reconnectingPill).toHaveClass(/nx-loading-pill/);
    await expect(reconnectingPill.getByTestId('loading-pill-spinner')).toBeVisible();
    await page.evaluate(() => {
      const mic = document.querySelector<HTMLButtonElement>('[data-testid="composer-mic"]')!;
      // Bypass the presentation guard to prove the action boundary itself.
      mic.disabled = false;
      mic.click();
    });
    await page.waitForTimeout(100);
    expect(mediaMutations).toEqual([]);
    await expect(liveInput).toHaveValue(retainedDraft);
    await expect(page.getByTestId('composer-dictation-panel')).toHaveCount(0);
    await control('/relay-up');
    await expect(page.getByTestId('reconnecting-pill')).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(async () => await page.evaluate(async () => {
      const opened = indexedDB.open('codor-last-good-room-v1');
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        opened.onsuccess = () => resolve(opened.result);
        opened.onerror = () => reject(opened.error);
      });
      const count = await new Promise<number>((resolve, reject) => {
        const request = database.transaction('rooms').objectStore('rooms').count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      database.close();
      return count;
    })).toBeGreaterThan(0);
    const retained = (await page.locator('[data-transcript-unit] .nx-prose').first().textContent())?.trim();
    expect(retained).toBeTruthy();

    await control('/relay-down');
    const started = Date.now();
    await page.reload();
    await expect(page.getByTestId('reconnecting-pill')).toBeVisible({ timeout: 1_000 });
    const cachedRenderMs = Date.now() - started;
    expect(cachedRenderMs).toBeLessThan(1_000);
    await expect(page.getByTestId('timeline')).toContainText(retained!);
    await expect(page.getByTestId('connection')).toHaveClass(/is-error/);
    await expect(page.getByTestId('composer-send')).toBeDisabled();
    await expect(page.getByTestId('toggle-message-search')).toBeEnabled();
    await page.evaluate(() => { (window as unknown as { __cachedDocument?: boolean }).__cachedDocument = true; });

    const input = page.getByTestId('composer-input');
    const draft = '@viewer keep this offline draft';
    await input.fill(draft);
    await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
      const file = new File(['offline'], 'offline.txt', { type: 'text/plain' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer }));
      input.closest('footer')?.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    });
    await page.getByTestId('composer-file').setInputFiles({
      name: 'selected-offline.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('offline'),
    });
    await page.waitForTimeout(100);
    expect(mediaMutations).toEqual([]);
    await expect(input).toHaveValue(draft);
    await expect(page.getByTestId('attach-tray')).toHaveCount(0);

    await control('/relay-up');
    await expect(page.getByTestId('reconnecting-pill')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/);
    expect(await page.evaluate(() => (window as unknown as { __cachedDocument?: boolean }).__cachedDocument)).toBe(true);
    await input.fill('@viewer current evidence restored');
    await expect(page.getByTestId('composer-send')).toBeEnabled();
    console.info('[hosted-cached-render-metrics]', JSON.stringify({ cachedRenderMs }));
  });

  // harn:assume combined-history-opening-sync-stays-cold ref=hosted-cache-replay-browser-regression
  // harn:assume transcript-tail-follow-has-one-prepaint-owner ref=transcript-prepaint-geometry-regression
  test('cached hosted replay never appends an older row or moves the transcript while typing', async ({ page }) => {
    test.setTimeout(120_000);
    await pairLive(page);
    await expect.poll(async () => await page.evaluate(async () => {
      const opened = indexedDB.open('codor-last-good-room-v1');
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        opened.onsuccess = () => resolve(opened.result);
        opened.onerror = () => reject(opened.error);
      });
      const count = await new Promise<number>((resolve, reject) => {
        const request = database.transaction('rooms').objectStore('rooms').count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      database.close();
      return count;
    })).toBeGreaterThan(0);

    await control('/relay-down');
    await expect(page.getByTestId('reconnecting-pill')).toBeVisible({ timeout: 30_000 });
    const probe = await page.evaluate(async () => {
      const opened = indexedDB.open('codor-last-good-room-v1');
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        opened.onsuccess = () => resolve(opened.result);
        opened.onerror = () => reject(opened.error);
      });
      const transaction = database.transaction('rooms', 'readwrite');
      const store = transaction.objectStore('rooms');
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = store.getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const key = keys[0];
      if (key === undefined) throw new Error('missing cached computer snapshot');
      const snapshot = await new Promise<any>((resolve, reject) => {
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const candidates = snapshot.history.units.flatMap((unit: any, index: number) => {
        if (unit.kind !== 'message') return [];
        const message = snapshot.history.messages[unit.message_id];
        return message?.kind === 'chat' && message.deleted !== true
          ? [{ id: unit.message_id as number, body: message.body as string, index }]
          : [];
      });
      if (candidates.length < 2) throw new Error('cached head needs two ordinary rows');
      const removed = candidates.at(-2)!;
      const later = candidates.at(-1)!;
      snapshot.history.units.splice(removed.index, 1);
      delete snapshot.history.messages[removed.id];
      await new Promise<void>((resolve, reject) => {
        const request = store.put(snapshot, key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      return { removed, later };
    });

    await page.reload();
    await expect(page.getByTestId('reconnecting-pill')).toBeVisible({ timeout: 1_000 });
    await expect(page.getByTestId(`msg-${String(probe.later.id)}`)).toBeVisible();
    await expect(page.getByTestId(`msg-${String(probe.removed.id)}`)).toHaveCount(0);
    await page.evaluate(({ removedId }) => {
      const runtime = window as unknown as {
        __hostedReplay?: {
          liveReplayCount: number;
          gaps: number[];
          stopped: boolean;
          observer: MutationObserver;
        };
      };
      const state = {
        liveReplayCount: 0,
        gaps: [] as number[],
        stopped: false,
        observer: undefined as unknown as MutationObserver,
      };
      const capture = (): void => {
        const row = document.querySelector<HTMLElement>(`[data-testid="msg-${String(removedId)}"]`);
        if (row !== null && row.dataset.transcriptUnit === undefined) state.liveReplayCount += 1;
      };
      state.observer = new MutationObserver(capture);
      state.observer.observe(document.querySelector('[data-testid="timeline"]')!, {
        childList: true,
        subtree: true,
      });
      const sample = (): void => {
        if (state.stopped) return;
        const timeline = document.querySelector<HTMLElement>('[data-testid="timeline"]');
        if (timeline) state.gaps.push(timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight);
        capture();
        requestAnimationFrame(sample);
      };
      runtime.__hostedReplay = state;
      requestAnimationFrame(sample);
    }, { removedId: probe.removed.id });

    await control('/relay-up');
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect(page.getByTestId(`msg-${String(probe.removed.id)}`)).toHaveAttribute(
      'data-transcript-unit',
      `message:${String(probe.removed.id)}`,
    );
    const input = page.getByTestId('composer-input');
    await input.fill('one\ntwo\nthree\nfour\nfive\nsix');
    await input.fill('one');
    await page.waitForTimeout(300);
    const evidence = await page.evaluate(() => {
      const state = (window as unknown as {
        __hostedReplay: {
          liveReplayCount: number;
          gaps: number[];
          stopped: boolean;
          observer: MutationObserver;
        };
      }).__hostedReplay;
      state.stopped = true;
      state.observer.disconnect();
      return { liveReplayCount: state.liveReplayCount, gaps: state.gaps };
    });
    expect(evidence.liveReplayCount).toBe(0);
    expect(evidence.gaps.length).toBeGreaterThan(5);
    expect(Math.max(...evidence.gaps)).toBeLessThanOrEqual(2);
    expect(Math.min(...evidence.gaps)).toBeGreaterThanOrEqual(-1);
  });
  // harn:end transcript-tail-follow-has-one-prepaint-owner
  // harn:end combined-history-opening-sync-stays-cold
  // harn:end readable-reconnecting-room-never-admits-mutation
  // harn:end readable-reconnecting-room-never-admits-mutation
  // harn:end hosted-last-good-room-cache-is-bounded-read-only-projection

  test('a cacheless active host that returns late enters the same document automatically', async ({ page }) => {
    test.setTimeout(120_000);
    await pairLive(page, true);
    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase('codor-last-good-room-v1');
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('last-good database remained open'));
      });
    });
    await control('/relay-down');
    await page.reload();
    await expect(page.getByTestId('recovery')).toBeVisible({ timeout: 10_000 });
    await page.evaluate(() => { (window as unknown as { __lateReadyDocument?: boolean }).__lateReadyDocument = true; });
    await control('/relay-up');
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect(page.getByTestId('recovery')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __lateReadyDocument?: boolean }).__lateReadyDocument)).toBe(true);
  });
});
// harn:end hosted-background-rooms-hydrate-metadata-until-promoted
// harn:end hosted-managed-bootstrap-reacts-to-late-readiness

// harn:assume transcript-tail-follow-has-one-prepaint-owner ref=transcript-prepaint-geometry-regression
test('direct and hosted transcript geometry keeps one pre-paint tail owner', async ({ page }) => {
  test.setTimeout(120_000);
  const sampleTail = async (key: string): Promise<void> => page.evaluate((sampleKey) => {
    const samples: number[] = [];
    const runtime = window as unknown as { __tailFrameGaps: Record<string, number[]> };
    runtime.__tailFrameGaps ??= {};
    runtime.__tailFrameGaps[sampleKey] = samples;
    let remaining = 24;
    const sample = (): void => {
      const node = document.querySelector<HTMLElement>('[data-testid="timeline"]');
      if (node) samples.push(node.scrollHeight - node.scrollTop - node.clientHeight);
      remaining -= 1;
      if (remaining > 0) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, key);
  const finishSample = async (key: string): Promise<number[]> => {
    await page.waitForTimeout(500);
    return page.evaluate((sampleKey) => (
      (window as unknown as { __tailFrameGaps: Record<string, number[]> }).__tailFrameGaps[sampleKey] ?? []
    ), key);
  };

  for (const viewport of [
    { label: 'desktop', width: 1280, height: 800 },
    { label: 'phone', width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/?room=eng&token=next-e2e-token');
    await expect(page.getByTestId('timeline')).toBeVisible();
    const timeline = page.getByTestId('timeline');
    const input = page.getByTestId('composer-input');
    await expect.poll(() => timeline.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
      .toBeLessThan(4);

    const frameGroups: Record<string, number[]> = {};
    await sampleTail(`${viewport.label}-ordinary`);
    await input.fill('');
    await input.pressSequentially('ordinary characters', { delay: 4 });
    frameGroups.ordinary = await finishSample(`${viewport.label}-ordinary`);

    await sampleTail(`${viewport.label}-newlines`);
    await input.fill('one\ntwo\nthree\nfour\nfive\nsix');
    frameGroups.newlines = await finishSample(`${viewport.label}-newlines`);

    await sampleTail(`${viewport.label}-shrink`);
    await input.fill('one');
    frameGroups.shrink = await finishSample(`${viewport.label}-shrink`);

    await sampleTail(`${viewport.label}-paste`);
    // fill() models a single paste-sized replacement without the timing noise
    // of typing each character; wrapping and the eight-row clamp are real.
    await input.fill('pasted wrapped content '.repeat(90));
    frameGroups.paste = await finishSample(`${viewport.label}-paste`);

    for (const [action, samples] of Object.entries(frameGroups)) {
      expect(samples.length, `${viewport.label} ${action} frame samples`).toBeGreaterThan(10);
      expect(Math.max(...samples), `${viewport.label} ${action} bottom gap`).toBeLessThanOrEqual(2);
      expect(Math.min(...samples), `${viewport.label} ${action} bottom overshoot`).toBeGreaterThanOrEqual(-1);
    }

    await input.fill('one');
    const anchor = await timeline.evaluate((node) => {
      node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 220);
      node.dispatchEvent(new Event('scroll'));
      const viewportBox = node.getBoundingClientRect();
      const row = [...node.querySelectorAll<HTMLElement>('[data-transcript-unit]')]
        .find((candidate) => candidate.getBoundingClientRect().bottom > viewportBox.top);
      if (!row?.dataset.transcriptUnit) throw new Error('missing visible transcript anchor');
      return {
        unit: row.dataset.transcriptUnit,
        offset: row.getBoundingClientRect().top - viewportBox.top,
        gap: node.scrollHeight - node.scrollTop - node.clientHeight,
      };
    });
    expect(anchor.gap).toBeGreaterThanOrEqual(120);
    await input.fill('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine');
    await input.fill('one');
    await page.waitForTimeout(200);
    const restoredOffset = await page.locator(`[data-transcript-unit="${anchor.unit}"]`).evaluate((row) =>
      row.getBoundingClientRect().top
      - document.querySelector('[data-testid="timeline"]')!.getBoundingClientRect().top);
    expect(Math.abs(restoredOffset - anchor.offset), `${viewport.label} unpinned anchor movement`)
      .toBeLessThanOrEqual(2);
    console.info('[composer-geometry]', JSON.stringify({ viewport, frameGroups, anchor, restoredOffset }));
  }

  const directResources = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => ({
    name: entry.name,
    duration: Number(entry.duration.toFixed(1)),
    bytes: (entry as PerformanceResourceTiming).transferSize,
  })).filter((entry) => entry.name.includes('/api/')));
  console.info('[direct-startup-browser-metrics]', JSON.stringify({
    requests: directResources.length,
    responseBytes: directResources.reduce((total, entry) => total + entry.bytes, 0),
    requestDurationMs: Number(directResources.reduce((total, entry) => total + entry.duration, 0).toFixed(1)),
  }));
});
// harn:end transcript-tail-follow-has-one-prepaint-owner
