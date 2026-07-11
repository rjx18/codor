import { expect, test } from '@playwright/test';

const CONTROL = 'http://127.0.0.1:8138';

async function enqueue(finalText: string): Promise<void> {
  const response = await fetch(`${CONTROL}/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turns: [{ kind: 'complete', final_text: finalText }] }),
  });
  if (!response.ok) throw new Error(`enqueue failed: ${await response.text()}`);
}

// harn:assume literal-draft-recipient-visible-before-send ref=composer-browser-regression
test('composer materializes defaults once and offers parser-backed member mentions', async ({ page, request }) => {
  const room = `composer-${String(Date.now())}`;
  const authorization = { authorization: 'Bearer e2e-token' };
  const created = await request.post('/api/rooms', {
    headers: authorization,
    data: {
      id: room,
      name: 'Composer semantics',
      cwd: process.cwd(),
      owner: { handle: 'richard', display_name: 'Richard' },
      starting_agent: { harness: 'fake', handle: 'codor' },
    },
  });
  expect(created.ok()).toBe(true);
  for (const [handle, purpose] of [
    ['tester', 'Runs tests'],
    ['writer', 'Writes docs'],
  ] as const) {
    const spawned = await request.post(`/api/rooms/${room}/members`, {
      headers: authorization,
      data: { harness: 'fake', handle, purpose, cwd: process.cwd() },
    });
    expect(spawned.ok()).toBe(true);
  }

  await page.goto(`/?room=${room}&token=e2e-token`);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  const input = page.getByTestId('composer-input');
  await expect(page.getByTestId('implied-recipient')).toHaveCount(0);

  await input.fill('n');
  await expect(input).toHaveValue('n');
  await input.fill('');

  await enqueue('@richard codor ready');
  await input.fill('@codor establish the default');
  await page.getByTestId('composer-send').click();
  await expect(page.getByText('@richard codor ready')).toBeVisible();

  await input.fill('h');
  await expect(input).toHaveValue('@codor h');
  await input.fill('h');
  await input.pressSequentially('ello');
  await expect(input).toHaveValue('hello');
  await page.getByTestId('composer-send').click();
  await expect(input).toHaveValue('');

  await input.fill('n');
  await expect(input).toHaveValue('@codor n');
  await input.fill('');

  await input.fill('@t');
  await expect(page.getByTestId('mention-popup')).toBeVisible();
  await expect(page.getByTestId('mention-option-tester')).toBeVisible();
  await expect(page.getByTestId('mention-option-writer')).toHaveCount(0);
  await input.press('Enter');
  await expect(input).toHaveValue('@tester ');

  await input.fill('');
  await input.fill('@');
  await expect(page.getByTestId('mention-popup')).toBeVisible();
  await input.press('Escape');
  await expect(page.getByTestId('mention-popup')).toHaveCount(0);

  await input.fill('');
  await page.getByTestId('composer-mention').click();
  await page.getByTestId('mention-option-writer').click();
  await expect(input).toHaveValue('@writer ');
});
// harn:end literal-draft-recipient-visible-before-send
