import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
const SPA = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_SPA_PORT ?? '28139'}`;
async function control(path: string, body: unknown = {}): Promise<any> {
  const response = await fetch(CONTROL + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(await response.text()); return response.json();
}
async function open(page: Page, hosted: boolean) {
  await control('/p6-capability', { mode: 'clear', correlations: true });
  await control('/p6-fault');
  if (hosted) {
    await control('/relay-up'); const pairing = await control('/relay-pair');
    await page.addInitScript(url => { (window as any).__CODOR_RELAY_URL = url; }, pairing.relayUrl);
    await page.goto(SPA);
    await page.getByTestId('pairing-code-0').evaluate((element, code) => {
      const data = new DataTransfer(); data.setData('text/plain', code);
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    }, pairing.code);
    await page.getByTestId('pairing-code-submit').click();
  } else await page.goto('/?token=next-e2e-token&room=eng');
  // Wait through pairing navigation and initial hydration before driving input.
  await expect(page.getByTestId('composer-input')).toBeVisible({timeout:30_000});
  await expect(page.getByTestId('composer-input')).toHaveValue(/^@\w+ /);
  await expect.poll(() => page.evaluate(() => (window as any).__codor.postCorrelations)).toBe(true);
  await expect(page.getByTestId('reconnecting-pill')).toHaveCount(0);
}
for (const hosted of [false, true]) {
  test(`${hosted ? 'hosted' : 'direct'} HTTP history adopts a committed send before its lost receipt`, async ({ page }) => {
    await open(page, hosted);
    const needle = `http-first-${hosted}`;
    await control('/p6-fault', { point: 'silent', needle });
    await page.getByTestId('composer-input').fill(`@richard ${needle}`);
    await page.getByTestId('composer-input').press('Enter');
    await expect(page.getByTestId(/^outgoing-/)).toHaveCount(1);
    await expect.poll(async () => (await control('/p6-evidence', { needle })).messages.length).toBe(1);
    await page.getByTestId('room-link-files').click();
    await page.getByTestId('room-link-eng').click();
    // A healthy managed activation intentionally reuses its warm head. Use the
    // existing foreground reconciliation, not a new request on every send.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(page.getByTestId(/^outgoing-/)).toHaveCount(0);
    await expect(page.getByTestId('timeline').locator('article').filter({ hasText: needle })).toHaveCount(1);
    expect((await control('/p6-evidence', { needle })).attempts).toHaveLength(1);
    await control('/p6-fault');
  });
  test(`${hosted ? 'hosted' : 'direct'} acceptance before echo survives replay without duplication`, async ({ page }) => {
    await open(page, hosted);
    const needle = `ack-first-${hosted}`;
    await control('/p6-fault', { point: 'echo-only', needle });
    await page.getByTestId('composer-input').fill(`@richard ${needle}`);
    await page.getByTestId('composer-input').press('Enter');
    await expect(page.getByTestId(/^outgoing-/).getByLabel('Accepted by the server')).toBeVisible();
    await control('/p6-fault');
    await page.evaluate(() => { (window as any).__codor.disconnect(); (window as any).__codor.reconnect(); });
    await expect(page.getByTestId(/^outgoing-/)).toHaveCount(0);
    await expect(page.getByTestId('timeline').locator('article').filter({ hasText: needle })).toHaveCount(1);
  });
  test(`${hosted ? 'hosted' : 'direct'} pending downgrade stays uncertain without replaying`, async ({ page }) => {
    await open(page, hosted);
    const needle = `optimistic-downgrade-${hosted}`;
    await control('/p6-fault', { point: 'silent', needle });
    await page.getByTestId('composer-input').fill(`@richard ${needle}`);
    await page.getByTestId('composer-input').press('Enter');
    await expect.poll(async () => (await control('/p6-evidence', { needle })).messages.length).toBe(1);
    await control('/p6-capability', { mode: 'unsupported', remaining: -1 });
    await page.evaluate(() => { (window as any).__codor.disconnect(); (window as any).__codor.reconnect(); });
    await expect.poll(() => page.evaluate(() => (window as any).__codor.postAcknowledgements)).toBe(false);
    await expect(page.getByTestId(/^outgoing-/).getByRole('button', { name: 'Resend', exact: true })).toBeDisabled();
    expect((await control('/p6-evidence', { needle })).attempts).toHaveLength(1);
    await control('/p6-fault');
  });
  test(`${hosted ? 'hosted' : 'direct'} immediate identical sends and sender identity`, async ({ page }) => {
    await open(page, hosted);
    const needle = `optimistic-${hosted}`;
    await control('/p6-fault', { point: 'delay', needle });
    for (let n = 0; n < 2; n++) {
      await page.getByTestId('composer-input').fill(`@richard ${needle}`);
      await page.getByTestId('composer-input').press('Enter');
      await expect(page.getByTestId('composer-input')).toHaveValue('');
    }
    await expect(page.getByTestId(/^outgoing-/)).toHaveCount(2);
    await page.getByTestId('composer-input').fill('newer edited draft');
    await control('/p6-fault');
    await expect(page.getByTestId(/^outgoing-/)).toHaveCount(0);
    await expect(page.getByTestId('timeline').locator('article').filter({ hasText: needle })).toHaveCount(2);
    await expect(page.getByTestId('composer-input')).toHaveValue('newer edited draft');
    const evidence = await control('/p6-evidence', { needle });
    expect(evidence.messages).toHaveLength(2);
    expect(new Set(evidence.attempts.map((post: any) => post.submission_id)).size).toBe(2);
  });
  test(`${hosted ? 'hosted' : 'direct'} lost acknowledgement and failed row resend`, async ({ page }) => {
    await open(page, hosted);
    const needle = `lost-ack-${hosted}`;
    await control('/p6-fault', { point: 'ack-only', needle });
    await page.getByTestId('composer-input').fill(`@richard ${needle}`);
    await page.getByTestId('composer-input').press('Enter');
    await expect(page.getByTestId('composer-input')).toHaveValue('');
    await expect(page.getByTestId('timeline').locator('article').filter({ hasText: needle })).toHaveCount(1);
    await expect(page.getByTestId(/^outgoing-/)).toHaveCount(0);
    const failed = `refused-${hosted}`;
    await page.setInputFiles('[data-testid="composer-file"]', { name:'retry.txt', mimeType:'text/plain', buffer:Buffer.from('same uploaded bytes') });
    await expect(page.getByTestId('attach-tray').locator('.nx-attach-chip')).toHaveCount(1);
    await control('/p6-fault', { point: 'reject', needle: failed });
    await page.getByTestId('composer-input').fill(`@richard ${failed}`);
    await page.getByTestId('composer-input').press('Enter');
    const row = page.getByTestId(/^outgoing-/).filter({ hasText: failed });
    await expect(row.getByLabel('Send failed')).toBeVisible();
    await row.getByRole('button', { name: 'Resend', exact: true }).click();
    await expect(row).toHaveCount(0);
    const proof = await control('/p6-evidence', { needle: failed });
    expect(proof.messages).toHaveLength(1);
    expect(proof.attempts).toHaveLength(2);
    expect(proof.attempts[1]).toEqual(proof.attempts[0]);
    expect(proof.messages[0].attachments.map((attachment:any)=>attachment.id)).toEqual(proof.attempts[0].attachments);
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

test('hosted voice refusal retries the frozen recording without another transcription', async ({page}) => {
  await fakeMedia(page); await open(page,true);
  const before = await control('/p6-evidence',{needle:'not-a-recording'});
  const needle = `dictation ${before.voiceCalls + 1}`;
  await control('/p6-fault',{point:'reject',needle});
  await page.getByTestId('composer-input').fill('@viewer unrelated draft');
  await page.getByTestId('composer-mic').click();
  await expect(page.getByTestId('composer-dictation-panel')).toBeVisible();
  await page.waitForTimeout(250);
  await page.getByTestId('dictation-add').click();
  await page.getByTestId('dictation-send').click();
  const row = page.getByTestId(/^outgoing-/).filter({hasText:needle});
  await expect(row.getByLabel('Send failed')).toBeVisible();
  await expect(page.getByTestId('composer-input')).toHaveValue('@viewer unrelated draft');
  await row.getByRole('button',{name:'Resend',exact:true}).click();
  await expect(row).toHaveCount(0);
  const after = await control('/p6-evidence',{needle});
  expect(after.messages).toHaveLength(1); expect(after.attempts).toHaveLength(2);
  expect(after.attempts[1]).toEqual(after.attempts[0]);
  expect(after.voiceCalls).toBe(before.voiceCalls+1);
  expect(after.messages[0].voice).toEqual(after.attempts[0].voice);
});

test('editing a qualified recipient moves the pending row to the newly selected child', async ({page}) => {
  await open(page,false);
  await page.getByTestId('room-link-workspace').click();
  const {registered}=await control('/wt-registered',{room:'workspace'});
  const review=registered.find((entry:any)=>entry.branch==='feature/review');
  const plan=registered.find((entry:any)=>entry.branch==='feature/plan');
  const needle='review-edited-target';
  await control('/p6-fault',{point:'reject',needle});
  await page.getByTestId('composer-input').fill(`~${review.alias}:@reviewer ${needle}`);
  await page.getByTestId('composer-input').press('Enter');
  const row=page.getByTestId(/^outgoing-/).filter({hasText:needle});
  await row.getByRole('button',{name:'Edit',exact:true}).click();
  await row.getByLabel('Edit unsent message').fill(`~missing:@planner ${needle}`);
  await row.getByRole('button',{name:'Send edited message'}).click();
  await expect(row.getByRole('alert')).toBeVisible();
  expect((await control('/p6-evidence',{needle})).attempts).toHaveLength(1);
  await row.getByLabel('Edit unsent message').fill(`~${plan.alias}:@planner ${needle} edited`);
  await control('/p6-fault',{point:'delay',needle});
  await row.getByRole('button',{name:'Send edited message'}).click();
  await expect.poll(async()=>(await control('/p6-evidence',{needle})).attempts.length).toBe(2);
  await page.getByTestId(`worktree-link-${plan.id}`).click();
  await expect(page.getByTestId(/^outgoing-/).filter({hasText:needle})).toHaveCount(1);
  await control('/p6-fault');
  await expect(page.getByTestId(/^outgoing-/)).toHaveCount(0);
  const proof=await control('/p6-evidence',{needle});
  expect(proof.messages.filter((message:any)=>message.kind==='chat').map((message:any)=>message.room)).toEqual([plan.conversation_id]);
});

for (const capability of ['supported','unknown','unsupported','ack-only'] as const) {
  test(`delayed edit lookup rechecks ${capability} capability before dispatch`, async ({page}) => {
    await open(page,false);
    const needle=`review-delayed-${capability}`;
    await page.setInputFiles('[data-testid="composer-file"]',{name:'held-media.txt',mimeType:'text/plain',buffer:Buffer.from('preserve me')});
    await expect(page.getByTestId('attach-tray').locator('.nx-attach-chip')).toHaveCount(1);
    await control('/p6-fault',{point:'reject',needle});
    await page.getByTestId('composer-input').fill(`@richard ${needle} original`);
    await page.getByTestId('composer-input').press('Enter');
    const row=page.getByTestId(/^outgoing-/).filter({hasText:needle});
    const originalId=await row.getAttribute('data-testid');
    await row.getByRole('button',{name:'Edit',exact:true}).click();
    const edited=`@richard ${needle} edited`;
    await row.getByLabel('Edit unsent message').fill(edited);
    let release!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;});
    let entered=false;
    await page.route('**/api/rooms/eng/routing-targets',async route=>{entered=true;await held;await route.continue();});
    await row.getByRole('button',{name:'Send edited message'}).click();
    await expect.poll(()=>entered).toBe(true);
    try {
      if (capability!=='supported') {
        await control('/p6-capability',{mode:capability==='unknown'?'timeout':capability==='ack-only'?'clear':'unsupported',remaining:-1,
          correlations:capability!=='ack-only'});
        await page.evaluate(()=>{(window as any).__codor.disconnect();(window as any).__codor.reconnect();});
        await expect.poll(()=>page.evaluate(()=>(window as any).__codor.postAcknowledgements)).toBe(capability==='unknown'?undefined:capability==='ack-only');
        await expect.poll(()=>page.evaluate(()=>(window as any).__codor.postCorrelations)).toBe(false);
      }
    } finally { release(); }
    if (capability!=='supported') {
      await expect(row.getByRole('alert')).toContainText('support');
      await expect(row).toHaveAttribute('data-testid',originalId!);
      await expect(row.getByLabel('Edit unsent message')).toHaveValue(edited);
      await expect(row).toContainText('held-media.txt');
      expect((await control('/p6-evidence',{needle})).attempts).toHaveLength(1);
      expect((await control('/p6-evidence',{needle})).messages).toHaveLength(0);
      await control('/p6-capability',{mode:'clear',correlations:true});
      await page.evaluate(()=>{(window as any).__codor.disconnect();(window as any).__codor.reconnect();});
      await expect.poll(()=>page.evaluate(()=>(window as any).__codor.postCorrelations)).toBe(true);
      await row.getByRole('button',{name:'Send edited message'}).evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
    }
    await expect(row).toHaveCount(0);
    const proof=await control('/p6-evidence',{needle});
    expect(proof.attempts).toHaveLength(2); expect(proof.messages).toHaveLength(1);
    expect(proof.attempts[1].submission_id).toBeTruthy();
    expect(proof.attempts[1].submission_id).not.toBe(proof.attempts[0].submission_id);
    expect(proof.attempts[1].attachments).toEqual(proof.attempts[0].attachments);
  });
}

test.describe('edited browser-local schedules', () => {
  test.use({timezoneId:'America/Los_Angeles'});
  test('a refused friendly-clock edit keeps its browser instant with a new ID', async ({page}) => {
    await open(page,false);
    const needle = 'review-timezone-edit';
    const accepted: any[] = [];
    page.on('websocket',socket=>socket.on('framereceived',({payload})=>{
      try { const frame=JSON.parse(String(payload)); if(frame.type==='post_accepted') accepted.push(frame); } catch { /* binary tunnel */ }
    }));
    // Capture the existing socket too through the ordinary compatibility proof:
    // reconnect once before sending, without changing submission semantics.
    await page.evaluate(()=>{(window as any).__codor.disconnect();(window as any).__codor.reconnect();});
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/);
    await expect.poll(()=>page.evaluate(()=>(window as any).__codor.postCorrelations)).toBe(true);
    await control('/p6-fault',{point:'reject',needle});
    await page.getByTestId('composer-input').fill(`[send_at=11:59PM] @fable ${needle}`);
    await page.getByTestId('composer-input').press('Enter');
    const row=page.getByTestId(/^outgoing-/).filter({hasText:needle});
    await row.getByRole('button',{name:'Edit',exact:true}).click();
    await row.getByLabel('Edit unsent message').fill(`[send_at=11:59PM] @fable ${needle} edited`);
    await row.getByRole('button',{name:'Send edited message'}).click();
    await expect.poll(async()=>(await control('/p6-evidence',{needle})).attempts.length).toBe(2);
    const {attempts}=await control('/p6-evidence',{needle});
    const instant=attempts[0].body.match(/^\[send_at=([^\]]+)\]/)[1];
    expect(instant).toMatch(/T23:59:00-0[78]:00$/); // Los Angeles, including winter CI runs
    expect(attempts[1].body).toBe(`[send_at=${instant}] @fable ${needle} edited`);
    expect(attempts[1].submission_id).not.toBe(attempts[0].submission_id);
    await expect.poll(()=>accepted.find(frame=>frame.submission_id===attempts[1].submission_id)?.outcome.due_ts).toBe(new Date(instant).toISOString());
  });
});

test('mobile outgoing status is accessible and does not move an unpinned reader', async ({ page }) => {
  await page.setViewportSize({ width:390, height:600 });
  await control('/live-chat', {room:'eng',body:'Unpinned reader fixture.\n\n'.repeat(100),route:false});
  await open(page,false);
  const timeline = page.getByTestId('timeline');
  await timeline.evaluate(node => { node.scrollTop = 200; node.dispatchEvent(new Event('scroll')); });
  const before = await timeline.evaluate(node => node.scrollTop);
  await control('/p6-fault', { point:'delay', needle:'mobile-outgoing' });
  await page.getByTestId('composer-input').fill('@richard mobile-outgoing');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId(/^outgoing-/)).toHaveCount(1);
  expect(Math.abs((await timeline.evaluate(node => node.scrollTop)) - before)).toBeLessThanOrEqual(2);
  expect((await new AxeBuilder({page}).include('[data-testid^="outgoing-"]').withTags(['wcag2a','wcag2aa']).analyze()).violations).toEqual([]);
  await control('/p6-fault');
});
