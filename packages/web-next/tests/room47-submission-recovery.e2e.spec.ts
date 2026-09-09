import { expect, test, type Page } from '@playwright/test';
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
const SPA = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_SPA_PORT ?? '28139'}`;
async function control(path: string, body: unknown = {}): Promise<any> {
  const response = await fetch(CONTROL + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(await response.text()); return response.json();
}
async function open(page: Page, hosted: boolean) {
  // This suite retains the acknowledgement-only (pre-correlation) daemon journey.
  await control('/p6-capability', { mode: 'clear', correlations: false }); await control('/p6-fault');
  if (hosted) {
    await control('/relay-up'); const pairing = await control('/relay-pair');
    await page.addInitScript((url) => { (window as any).__CODOR_RELAY_URL = url; }, pairing.relayUrl);
    await page.goto(SPA);
    await page.getByTestId('pairing-code-0').evaluate((element, code) => {
      const data = new DataTransfer(); data.setData('text/plain', code);
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    }, pairing.code);
    await page.getByTestId('pairing-code-submit').click();
  } else await page.goto('/?token=next-e2e-token&room=eng');
  await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
  await page.getByTestId('room-link-eng').click();
  await expect.poll(() => page.evaluate(() => (window as any).__codor.postAcknowledgements)).toBe(true);
}
async function pending(page: Page, needle: string) {
  await control('/p6-fault', { point: 'silent', needle });
  await page.getByTestId('composer-input').fill(`@richard ${needle}`);
  await page.getByTestId('composer-input').press('Enter');
  await expect.poll(async () => (await control('/p6-evidence', { needle })).messages.length).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).__codor.submissionPending)).toBe(true);
  await control('/p6-fault');
}
async function reconnect(page: Page) {
  await page.evaluate(() => { (window as any).__codor.disconnect(); (window as any).__codor.reconnect(); });
  await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
}
for (const hosted of [false, true]) {
  const transport = hosted ? 'hosted' : 'direct';
  test(`${transport}: timed-out capability verification recovers the original pending id on the healthy connection`, async ({ page }) => {
    test.setTimeout(60_000); const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await open(page, hosted); const needle = `review-timeout-${transport}`;
    await pending(page, needle);
    await page.getByTestId('composer-input').fill('@richard newer edited draft');
    await control('/p6-capability', { mode: 'timeout', remaining: 1 }); await reconnect(page);
    await expect.poll(() => page.evaluate(() => (window as any).__codor.postAcknowledgements)).toBeUndefined();
    expect((await control('/p6-evidence', { needle })).attempts).toHaveLength(1);
    await expect(page.getByTestId('composer-send')).toBeDisabled();
    await expect.poll(() => page.evaluate(() => (window as any).__codor.submissionPending), { timeout: 20_000 }).toBe(false);
    const evidence = await control('/p6-evidence', { needle });
    expect(evidence.attempts).toHaveLength(2); expect(evidence.attempts[1]).toEqual(evidence.attempts[0]);
    expect(evidence.messages).toHaveLength(1);
    expect((await control('/p6-capability')).requests).toBe(2);
    await expect(page.getByTestId('composer-input')).toHaveValue('@richard newer edited draft');
    await expect(page.getByTestId('composer-send')).toBeEnabled(); expect(errors).toEqual([]);
  });
  test(`${transport}: verified downgrade offers guarded local waiting release and never resends automatically`, async ({ page }) => {
    test.setTimeout(60_000); await open(page, hosted); const needle = `review-downgrade-${transport}`;
    await pending(page, needle); await page.getByTestId('composer-input').fill('@richard preserve uncertain draft');
    await control('/p6-capability', { mode: 'unsupported', remaining: -1 }); await reconnect(page);
    const stop = page.getByRole('button', { name: 'Stop waiting', exact: true });
    await expect(stop).toBeVisible(); await expect(stop).toBeDisabled();
    await expect(page.getByTestId('submission-uncertain')).toContainText('does not cancel or resend');
    expect((await control('/p6-evidence', { needle })).attempts).toHaveLength(1);
    await page.getByRole('checkbox', { name: 'I checked delivery in the destination conversation' }).check(); await stop.click();
    await expect(page.getByTestId('composer-input')).toHaveValue('@richard preserve uncertain draft');
    await expect(page.getByTestId('composer-hint')).toContainText('not cancelled');
    await expect(page.getByTestId('composer-send')).toBeEnabled();
    expect((await control('/p6-evidence', { needle })).attempts).toHaveLength(1);
    const next = `@richard new intentional legacy ${transport}`;
    await page.getByTestId('composer-input').fill(next); await page.getByTestId('composer-input').press('Enter');
    await expect.poll(async () => (await control('/p6-evidence', { needle: next })).messages.length).toBe(1);
    const evidence = await control('/p6-evidence', { needle: next });
    expect(evidence.attempts).toHaveLength(1); expect(evidence.attempts[0].submission_id).toBeUndefined();
    await control('/p6-capability', { mode: 'clear' });
  });
}
for (const draft of ['@richard preserve this offline draft', '']) {
  test(`hosted: cached-to-live handover preserves ${draft ? 'typed' : 'edited-empty'} draft and reply`, async ({ page }) => {
    test.setTimeout(60_000); await open(page, true);
    await expect.poll(() => page.evaluate(async () => new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('codor-last-good-room-v1');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('rooms')) { db.close(); resolve(0); return; }
        const all = db.transaction('rooms', 'readonly').objectStore('rooms').getAll();
        all.onsuccess = () => { const size = all.result.length; db.close(); resolve(size); };
        all.onerror = () => { db.close(); reject(all.error); };
      };
    }))).toBeGreaterThan(0);
    await control('/relay-down'); await page.reload();
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('connection')).not.toHaveClass(/is-live/);
    await page.evaluate(() => {
      (window as any).__cachedConnector = (window as any).__codor;
    });
    // P4 intentionally disables Quote buttons while offline. Seed its existing
    // composition event to cover associated reply state, then type normally.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('nx-quote', {
      detail: { text: 'cached reply', replyTo: 7 },
    })));
    const reply = await page.getByTestId('composer-reply').textContent();
    await page.getByTestId('composer-input').fill('@richard temporary edit');
    await page.getByTestId('composer-input').fill(draft);
    await control('/relay-up'); await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => (window as any).__codor !== (window as any).__cachedConnector)).toBe(true);
    expect(await page.evaluate(() => (window as any).__codor.compositionOwner === (window as any).__cachedConnector.compositionOwner)).toBe(true);
    await expect(page.getByTestId('composer-input')).toHaveValue(draft);
    await expect(page.getByTestId('composer-reply')).toHaveText(reply!);
    expect(await page.evaluate(() => (window as any).__codor.submissionPending)).toBe(false);
    if (draft) expect((await control('/p6-evidence', { needle: draft })).messages).toHaveLength(0);
  });
}
