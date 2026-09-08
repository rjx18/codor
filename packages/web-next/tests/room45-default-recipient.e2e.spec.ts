import { expect, test } from '@playwright/test';
const controlUrl = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
async function control(path: string) {
  const response = await fetch(`${controlUrl}${path}`, { method: 'POST', body: '{}' });
  expect(response.ok).toBe(true);
  return response.json();
}

test('terminal reply identity agrees with server fallback and preserves an edited composer', async ({ page }) => {
  const supportFrames: string[] = [];
  page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
    const text = payload.toString();
    if (text.includes('"type":"room_support"')) supportFrames.push(text);
  }));
  const fixture = await control('/default-recipient-fixture');
  expect(fixture).toMatchObject({ root: 2455, interrupted: 2457, result: 2462 });
  expect(fixture.defaultId).toBe(fixture.investigatorId);
  expect(fixture.plainRecipients).toEqual([fixture.investigatorId]);
  expect(fixture.replyRecipients).toEqual([fixture.solId]);
  await page.goto('/?room=default-recipient&token=next-e2e-token');
  const composer = page.getByTestId('composer-input');
  await expect(composer).toHaveValue('@investigator ');
  await composer.pressSequentially('keep my edited draft');
  const changed = await control('/default-recipient-change');
  expect(changed.defaultId).toBe(fixture.solId);
  await expect.poll(() => supportFrames.some((frame) =>
    frame.includes(`"latest_finalized_agent_id":"${fixture.solId}"`))).toBe(true);
  await expect(composer).toHaveValue('@investigator keep my edited draft');
});
