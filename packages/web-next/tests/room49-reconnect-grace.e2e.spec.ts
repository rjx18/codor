import { expect, test, type Page } from '@playwright/test';
const CONTROL=`http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT??'28138'}`;
const SPA=`http://127.0.0.1:${process.env.CODOR_NEXT_E2E_SPA_PORT??'28139'}`;
async function control(path:string,body:unknown={}):Promise<any>{
  const response=await fetch(CONTROL+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok)throw new Error(await response.text());return response.json();
}
async function paste(page:Page,code:string){
  await page.getByTestId('pairing-code-0').evaluate((node,value)=>{const data=new DataTransfer();data.setData('text/plain',value);
    node.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));},code);
  await page.getByTestId('pairing-code-submit').click();
}
async function open(page:Page,hosted:boolean){
  await control('/app-offline',{offline:false});await control('/p6-fault');
  await control('/p6-capability',{mode:'clear',correlations:true});
  if(hosted){await control('/relay-up');const pairing=await control('/relay-pair');
    await page.addInitScript(url=>{(window as any).__CODOR_RELAY_URL=url;},pairing.relayUrl);
    await page.goto(SPA);await paste(page,pairing.code);
  }else await page.goto('/?token=next-e2e-token&room=eng');
  await expect(page.getByTestId('composer-input')).toBeVisible({timeout:30000});
  await expect(page.getByTestId('connection')).toHaveAttribute('data-transport-connected','true');
  await expect.poll(()=>page.evaluate(()=>(window as any).__codor.localSendAllowed)).toBe(true);
  await expect(page.getByTestId('reconnecting-pill')).toHaveCount(0);
}
const outage=(hosted:boolean,down:boolean)=>control(hosted?(down?'/relay-down-a-only':'/relay-up'):'/app-offline',{offline:down});
async function send(page:Page,body:string){await page.getByTestId('composer-input').fill(body);
  await expect(page.getByTestId('composer-send')).toBeEnabled();await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('composer-input')).toHaveValue('');}

for(const hosted of [false,true])for(const long of [false,true]){
  test(`${hosted?'hosted':'direct'} ${long?'long':'brief'} outage keeps local sends independent of readiness`,async({page})=>{
    test.setTimeout(60000);await open(page,hosted);
    const needle=`grace-${hosted}-${long}`;
    await page.evaluate(()=>{
      const seen:string[]=[];(window as any).__graceLabels=seen;
      new MutationObserver(()=>{const label=document.querySelector('[data-testid="connection"]')?.textContent??'';seen.push(label);})
        .observe(document.querySelector('[data-testid="connection"]')!,{subtree:true,attributes:true,childList:true,characterData:true});
    });
    await outage(hosted,true);
    const indicator=page.getByTestId('connection');
    await expect(indicator).toHaveAttribute('data-transport-connected','false');
    await expect(indicator).toHaveAttribute('data-reconnect-grace','true');
    await expect(indicator).toHaveText('Connected');
    await expect(page.getByTestId('reconnecting-pill')).toHaveCount(0);
    expect(await page.evaluate(()=>(window as any).__codor.post('must not reach the wire'))).toBe(false);
    await send(page,`@richard ${needle} first`);await send(page,`@richard ${needle} second`);
    await expect(page.getByTestId(/^outgoing-/)).toHaveCount(2);
    expect((await control('/p6-evidence',{needle})).attempts).toHaveLength(0);
    await expect(page.getByRole('button',{name:'Actions for @scout'})).toBeDisabled();
    if(long){
      await expect(indicator).toHaveText('Disconnected',{timeout:7000});
      await send(page,`@richard ${needle} third`);
    }else await page.waitForTimeout(1200);
    await page.getByTestId('composer-input').fill('@richard next unsent draft');
    await outage(hosted,false);
    await expect(indicator).toHaveAttribute('data-transport-connected','true',{timeout:30000});
    await expect(page.getByTestId(/^outgoing-/)).toHaveCount(0,{timeout:30000});
    await expect(page.getByTestId('composer-input')).toHaveValue('@richard next unsent draft');
    const proof=await control('/p6-evidence',{needle});
    expect(proof.messages).toHaveLength(long?3:2);expect(proof.attempts).toHaveLength(long?3:2);
    expect(new Set(proof.attempts.map((post:any)=>post.submission_id)).size).toBe(long?3:2);
    expect(proof.messages.map((message:any)=>message.body)).toEqual([
      `@richard ${needle} first`,`@richard ${needle} second`,...(long?[`@richard ${needle} third`]:[]),
    ]);
    if(!long)expect(await page.evaluate(()=>(window as any).__graceLabels.some((label:string)=>label.includes('Disconnected')))).toBe(false);
  });
}

test('queued A never writes through warm B and B draft survives A recovery',async({page})=>{
  test.setTimeout(90000);await open(page,true);
  const pairing=await control('/relay-pair-b');await page.getByTestId('computer-add').click();await paste(page,pairing.code);
  await expect(page.getByTestId('computer-current')).toHaveAttribute('aria-label',/codor-host-b/);
  await page.getByRole('button',{name:/codor-host-a/}).first().click();
  await expect(page.getByTestId('connection')).toHaveAttribute('data-transport-connected','true');
  await control('/relay-down-a-only');await expect(page.getByTestId('connection')).toHaveAttribute('data-transport-connected','false');
  const needle='owned-A-queue';await send(page,`@richard ${needle}`);
  await page.getByRole('button',{name:/codor-host-b/}).first().click();
  await expect(page.getByTestId('connection')).toHaveAttribute('data-transport-connected','true');
  await page.getByTestId('composer-input').fill('@richard retained B draft');
  await control('/relay-up');
  await expect.poll(async()=>(await control('/p6-evidence',{needle})).messages.length,{timeout:30000}).toBe(1);
  expect((await control('/p6-evidence',{needle,computer:'B'})).messages).toHaveLength(0);
  await expect(page.getByTestId('composer-input')).toHaveValue('@richard retained B draft');
  await page.getByRole('button',{name:/codor-host-a/}).first().click();
  await expect(page.getByTestId('timeline')).toContainText(needle);await expect(page.getByTestId(/^outgoing-/)).toHaveCount(0);
});

test('an uncertain accepted send keeps its ID before a newer never-sent record',async({page})=>{
  await open(page,false);const needle='uncertain-then-queued';
  await control('/p6-fault',{point:'silent',needle});await send(page,`@richard ${needle} first`);
  await expect.poll(async()=>(await control('/p6-evidence',{needle})).messages.length).toBe(1);
  await control('/app-offline',{offline:true});await expect(page.getByTestId('connection')).toHaveAttribute('data-transport-connected','false');
  await send(page,`@richard ${needle} second`);
  expect((await control('/p6-evidence',{needle})).attempts).toHaveLength(1);
  await control('/p6-fault');await control('/app-offline',{offline:false});
  await expect(page.getByTestId(/^outgoing-/)).toHaveCount(0,{timeout:30000});
  const proof=await control('/p6-evidence',{needle});expect(proof.messages).toHaveLength(2);
  const first=proof.attempts.filter((post:any)=>post.body.endsWith('first'));
  expect(new Set(first.map((post:any)=>post.submission_id)).size).toBe(1);
  expect(proof.attempts.filter((post:any)=>post.body.endsWith('second'))).toHaveLength(1);
  expect(proof.messages[0].body).toContain('first');expect(proof.messages[1].body).toContain('second');
});

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

test('a transcription admitted online can finish into the local queue without retranscribing',async({page})=>{
  await fakeMedia(page);await open(page,false);
  const before=await control('/p6-evidence',{needle:'voice-unused'});
  const needle=`dictation ${before.voiceCalls+1}`;
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let entered=false;
  await page.route('**/api/voice/transcribe',async route=>{entered=true;await held;await route.continue();});
  await page.getByTestId('composer-input').fill('@richard preserved draft');
  await page.getByTestId('composer-mic').click();await page.waitForTimeout(250);
  await page.getByTestId('dictation-add').click();await page.getByTestId('dictation-send').click();
  await expect.poll(()=>entered).toBe(true);
  try {await control('/app-offline',{offline:true});await expect(page.getByTestId('connection')).toHaveAttribute('data-transport-connected','false');}
  finally {release();}
  await expect(page.getByTestId(/^outgoing-/)).toHaveCount(1);
  expect((await control('/p6-evidence',{needle})).attempts).toHaveLength(0);
  await expect(page.getByTestId('composer-input')).toHaveValue('@richard preserved draft');
  await control('/app-offline',{offline:false});await expect(page.getByTestId(/^outgoing-/)).toHaveCount(0,{timeout:30000});
  const after=await control('/p6-evidence',{needle});expect(after.voiceCalls).toBe(before.voiceCalls+1);
  expect(after.attempts).toHaveLength(1);expect(after.messages).toHaveLength(1);
  expect(after.messages[0].voice).toEqual(after.attempts[0].voice);
});

test('never-sent records wait through a downgrade and dispatch only after support returns',async({page})=>{
  await open(page,false);const needle='queued-downgrade';
  await control('/app-offline',{offline:true});await expect(page.getByTestId('connection')).toHaveAttribute('data-transport-connected','false');
  await send(page,`@richard ${needle}`);
  const id=(await page.getByTestId(/^outgoing-/).getAttribute('data-testid'))!.slice('outgoing-'.length);
  await control('/p6-capability',{mode:'unsupported',remaining:-1});await control('/app-offline',{offline:false});
  await expect.poll(()=>page.evaluate(()=>(window as any).__codor.postAcknowledgements)).toBe(false);
  await expect(page.getByTestId(/^outgoing-/)).toContainText('compatible');
  expect((await control('/p6-evidence',{needle})).attempts).toHaveLength(0);
  await control('/p6-capability',{mode:'clear',correlations:true});
  await page.evaluate(()=>{(window as any).__codor.disconnect();(window as any).__codor.reconnect();});
  await expect(page.getByTestId(/^outgoing-/)).toHaveCount(0,{timeout:30000});
  const proof=await control('/p6-evidence',{needle});expect(proof.messages).toHaveLength(1);
  expect(proof.attempts).toHaveLength(1);expect(proof.attempts[0].submission_id).toBe(id);
});
