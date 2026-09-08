import { expect, test, type Page } from '@playwright/test';
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
const SPA = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_SPA_PORT ?? '28139'}`;
const combination = process.env.CODOR_P6_COMBINATION ?? 'new-new';
const capable = combination === 'new-new';
async function control(path: string, body: unknown = {}): Promise<any> {
  const response = await fetch(CONTROL + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
async function paste(page: Page, code: string) {
  await page.getByTestId('pairing-code-0').evaluate((element, value) => {
    const data = new DataTransfer(); data.setData('text/plain', value);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, code);
  await page.getByTestId('pairing-code-submit').click();
}
async function open(page: Page, hosted: boolean) {
  if (hosted) {
    await control('/relay-up');
    const pairing = await control('/relay-pair');
    await page.addInitScript((url) => { (window as any).__CODOR_RELAY_URL = url; }, pairing.relayUrl);
    await page.goto(SPA + '/'); await paste(page, pairing.code);
  } else await page.goto('/?token=next-e2e-token&room=eng');
  await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
  await page.getByTestId('room-link-eng').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__codor?.postAcknowledgements === true)).toBe(capable);
}
async function send(page: Page, body: string) {
  await page.getByTestId('composer-input').fill(body);
  await expect(page.getByTestId('composer-send')).toBeEnabled();
  await page.getByTestId('composer-input').press('Enter');
}
async function reconnect(page: Page) {
  await page.evaluate(() => { (window as any).__codor.disconnect(); (window as any).__codor.reconnect(); });
  await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
}
for (const hosted of [false, true]) {
  const path = hosted ? 'hosted' : 'direct';
  test(`${combination} ${path}: real browser legacy/correlated posting and safe retry policy`, async ({ page }) => {
    test.setTimeout(90_000);
    await open(page, hosted);
    const needle = `p6-${combination}-${path}-compat`;
    await control('/p6-fault', { point: 'silent', needle });
    await send(page, `@richard ${needle}`);
    await expect.poll(async () => (await control('/p6-evidence', { needle })).messages.length).toBe(1);
    const before = await control('/p6-evidence', { needle });
    expect(before.attempts).toHaveLength(1);
    expect(Boolean(before.attempts[0].submission_id)).toBe(capable);
    const edit = `@richard edited-${needle}`;
    await page.getByTestId('composer-input').fill(edit);
    await control('/p6-fault'); await reconnect(page);
    if (capable) {
      await expect.poll(async () => (await control('/p6-evidence', { needle })).attempts.length).toBe(2);
      await expect.poll(() => page.evaluate(() => (window as any).__codor.submissionPending)).toBe(false);
    }
    await expect(page.getByTestId('composer-input')).toHaveValue(edit);
    const after = await control('/p6-evidence', { needle });
    expect(after.messages).toHaveLength(1);
    expect(after.attempts).toHaveLength(capable ? 2 : 1);
    if (capable) expect(after.attempts[1]).toEqual(after.attempts[0]);
  });
  if (capable) for (const point of ['before', 'after', 'lost-echo']) {
    test(`new-new ${path}: ${point} acceptance boundary creates exactly one message/fanout`, async ({ page }) => {
      test.setTimeout(90_000); await open(page, hosted);
      const needle = `p6-${path}-${point}`;
      await control('/p6-fault', { point, needle });
      await send(page, `@richard ${needle}`);
      await expect.poll(() => page.evaluate(() => (window as any).__codor.submissionPending), { timeout: 30_000 }).toBe(false);
      const proof = await control('/p6-evidence', { needle });
      expect(proof.messages).toHaveLength(1); expect(proof.deliveries).toHaveLength(1); // one ordinary human inbox delivery
      expect(proof.attempts).toHaveLength(point === 'lost-echo' ? 1 : 2);
      if (proof.attempts.length === 2) expect(proof.attempts[1]).toEqual(proof.attempts[0]);
      await expect(page.getByTestId('composer-input')).not.toHaveValue(`@richard ${needle}`);
      await control('/p6-fault');
    });
  }
}
if (capable) {
  test('direct: source room, edited draft and relative schedule remain immutable across reconnect', async ({ page }) => {
    await open(page, false);
    const needle = 'p6-schedule-owned';
    await control('/p6-fault', { point: 'silent', needle });
    await send(page, `[send_in=1h] @viewer ${needle}`);
    await expect.poll(async () => (await control('/p6-evidence', { needle })).attempts.length).toBe(1);
    await page.getByTestId('composer-input').fill('@viewer new edited source draft');
    await page.getByTestId('room-link-ops').click();
    await page.getByTestId('composer-input').fill('@richard another room draft');
    await control('/p6-fault'); await reconnect(page);
    await expect.poll(() => page.evaluate(() => (window as any).__codor.submissionPending)).toBe(false);
    await expect(page.getByTestId('composer-input')).toHaveValue('@richard another room draft');
    await page.getByTestId('room-link-eng').click();
    await expect(page.getByTestId('composer-input')).toHaveValue('@viewer new edited source draft');
    const proof = await control('/p6-evidence', { needle });
    expect(proof.attempts).toHaveLength(2); expect(proof.attempts[1]).toEqual(proof.attempts[0]);
    expect(proof.messages).toHaveLength(0);
    await page.getByTestId('composer-input').fill('');
    await page.getByTestId('room-link-ops').click();
    await page.getByTestId('room-link-eng').click();
    await expect(page.getByTestId('composer-input')).toHaveValue('');
  });
  test('hosted: an inactive computer keeps its pending send and edited draft out of the selected computer', async ({ page }) => {
    test.setTimeout(120_000); await open(page, true);
    const needle = 'p6-computer-A-pending';
    await control('/p6-fault', { point: 'silent', needle });
    await send(page, `@richard ${needle}`);
    await expect.poll(async () => (await control('/p6-evidence', { needle })).messages.length).toBe(1);
    await page.getByTestId('composer-input').fill('@richard edited on A');
    const pairing = await control('/relay-pair-b');
    await page.getByTestId('computer-add').click();
    await paste(page, pairing.code);
    await expect(page.getByTestId('computer-current')).toHaveAttribute('aria-label', /codor-host-b/, { timeout: 30_000 });
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/);
    await page.getByTestId('composer-input').fill('@richard draft on B');
    await control('/p6-fault'); await control('/relay-replace-host');
    await expect.poll(async () => (await control('/p6-evidence', { needle })).attempts.length, { timeout: 30_000 }).toBe(2);
    await expect(page.getByTestId('composer-input')).toHaveValue('@richard draft on B');
    expect((await control('/p6-evidence', { needle, computer: 'B' })).messages).toHaveLength(0);
    await page.getByRole('button', { name: /codor-host-a/ }).first().click();
    await expect(page.getByTestId('composer-input')).toHaveValue('@richard edited on A');
    expect((await control('/p6-evidence', { needle })).messages).toHaveLength(1);
  });
}

if (capable) for (const hosted of [false, true]) {
  test(`${hosted ? 'hosted' : 'direct'}: grouped fanout and uploaded attachment retry retain original identities`, async ({ page }) => {
    test.setTimeout(90_000); await open(page, hosted); await control('/p6-pause-group');
    await expect(page.getByRole('button', { name: 'Actions for @p6-alpha' })).toBeAttached();
    const needle = `p6-${hosted ? 'relay' : 'direct'}-group-upload`;
    await page.setInputFiles('[data-testid="composer-file"]', {
      name: needle + '.txt', mimeType: 'text/plain', buffer: Buffer.from('immutable attachment bytes'),
    });
    await expect(page.getByTestId('attach-tray').locator('.nx-attach-chip')).toHaveCount(1);
    await control('/p6-fault', { point: 'silent', needle });
    await send(page, `@p6-alpha @p6-beta ${needle}`);
    await expect.poll(async () => (await control('/p6-evidence', { needle })).messages.length).toBe(1);
    // A new attachment selection with the same textarea must also survive the
    // old acceptance; complete draft ownership is wider than string equality.
    await page.setInputFiles('[data-testid="composer-file"]', {
      name: 'new-selection.txt', mimeType: 'text/plain', buffer: Buffer.from('new draft attachment'),
    });
    await expect(page.getByTestId('attach-tray').locator('.nx-attach-chip')).toHaveCount(2);
    await control('/p6-fault'); await reconnect(page);
    await expect.poll(() => page.evaluate(() => (window as any).__codor.submissionPending)).toBe(false);
    const proof = await control('/p6-evidence', { needle });
    expect(proof.messages).toHaveLength(1); expect(proof.deliveries).toHaveLength(2);
    expect(new Set(proof.deliveries.map((delivery: any) => delivery.group_id)).size).toBe(1);
    expect(proof.deliveries[0].group_id).toBeTruthy();
    expect(proof.attempts).toHaveLength(2); expect(proof.attempts[1]).toEqual(proof.attempts[0]);
    expect(proof.messages[0].attachments.map((attachment: any) => attachment.id)).toEqual(proof.attempts[0].attachments);
    expect(proof.attempts[0].attachments).toHaveLength(1);
    await expect(page.getByTestId('attach-tray').locator('.nx-attach-chip')).toHaveCount(2);
    await expect(page.getByTestId('composer-input')).toHaveValue(`@p6-alpha @p6-beta ${needle}`);
  });
}

async function fakeMedia(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
    class Audio {
      sampleRate = 24000; destination = {}; state = 'running';
      async resume() {} async close() {}
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createScriptProcessor() {
        const node: any = { onaudioprocess: null, timer: undefined,
          connect() { node.timer = setInterval(() => node.onaudioprocess?.({
            inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.4) },
          }), 40); }, disconnect() { clearInterval(node.timer); } };
        return node;
      }
    }
    Object.assign(window, { AudioContext: Audio, webkitAudioContext: Audio });
  });
}
if (capable) for (const hosted of [false, true]) {
  test(`${hosted ? 'hosted' : 'direct'}: voice retry preserves metadata without retranscription and rejection retains editable text`, async ({ page }) => {
    test.setTimeout(90_000); await fakeMedia(page); await open(page, hosted);
    const before = await control('/p6-evidence', { needle: 'p6-unused' });
    const needle = `dictation ${before.voiceCalls + 1}`;
    await control('/p6-fault', { point: hosted ? 'reject' : 'silent', needle });
    await page.getByTestId('composer-input').fill('@viewer');
    await page.getByTestId('composer-mic').click();
    await expect(page.getByTestId('composer-dictation-panel')).toBeVisible();
    await page.waitForTimeout(250);
    await page.getByTestId('dictation-add').click();
    await page.getByTestId('dictation-send').click();
    await expect(page.getByTestId('composer-input')).toBeVisible();
    await expect.poll(async () => (await control('/p6-evidence', { needle })).attempts.length).toBe(1);
    if (hosted) {
      await expect(page.getByTestId('composer-hint')).toContainText('refused');
      await expect(page.getByTestId('composer-input')).toHaveValue(`@viewer ${needle}`);
      await page.getByTestId('composer-input').press('Enter');
    } else {
      await page.getByTestId('composer-input').fill('@viewer edited after voice send');
      await control('/p6-fault'); await reconnect(page);
    }
    await expect.poll(() => page.evaluate(() => (window as any).__codor.submissionPending)).toBe(false);
    const after = await control('/p6-evidence', { needle });
    expect(after.voiceCalls).toBe(before.voiceCalls + 1);
    expect(after.messages).toHaveLength(1); expect(after.attempts).toHaveLength(2);
    expect(after.messages[0].voice).toEqual(after.attempts[0].voice);
    expect(after.attempts[1].voice).toEqual(after.attempts[0].voice);
    if (hosted) expect(after.attempts[1].submission_id).not.toBe(after.attempts[0].submission_id);
    else {
      expect(after.attempts[1]).toEqual(after.attempts[0]);
      await expect(page.getByTestId('composer-input')).toHaveValue('@viewer edited after voice send');
    }
  });
}
