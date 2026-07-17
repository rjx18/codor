import { expect, test, type Page } from '@playwright/test';

const ROOM = '/?room=eng&token=next-e2e-token';
const TOKEN = 'next-e2e-token';
const API = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_API_PORT ?? '28137'}`;
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

async function enqueue(turns: unknown[]): Promise<void> {
  const res = await fetch(`${CONTROL}/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turns }),
  });
  if (!res.ok) throw new Error(`enqueue failed: ${await res.text()}`);
}

async function openRoom(page: Page): Promise<void> {
  await page.goto(ROOM);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

// ── Item 9: the composer bar owns its paint — every text surface inside it is
// fully transparent so the bar's rounded corners never mask an opaque square.
async function composerSurfacesTransparent(page: Page): Promise<void> {
  const backgrounds = await page.evaluate(() =>
    [...document.querySelectorAll('.nx-composer-bar textarea, .nx-composer-bar input')]
      .map((node) => getComputedStyle(node).backgroundColor),
  );
  expect(backgrounds.length).toBeGreaterThan(0);
  for (const background of backgrounds) expect(background).toBe('rgba(0, 0, 0, 0)');
}

test.describe('composer transparency — desktop', () => {
  test('input surfaces stay transparent in light and dark', async ({ page }) => {
    await openRoom(page);
    await composerSurfacesTransparent(page);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await composerSurfacesTransparent(page);
  });
});

test.describe('composer transparency — mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('input surfaces stay transparent in light and dark on the canvas bar', async ({ page }) => {
    // The connection pill lives in the rail, which the mobile room surface hides.
    await page.goto(ROOM);
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.getByTestId('msg-1')).toBeVisible();
    await composerSurfacesTransparent(page);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await composerSurfacesTransparent(page);
  });
});

test.describe('members tab', () => {
  test('extension members stay out of the roster and the header count', async ({ page }) => {
    // A turn that reports a subagent: the daemon mints a kind=extension member.
    await enqueue([{
      kind: 'complete',
      final_text: 'helper finished the survey',
      items: [{ type: 'extension.started', parent: 'native-fable', ext_member: 'subagent-alpha', description: 'survey helper' }],
    }]);
    await openRoom(page);
    const input = page.getByTestId('composer-input');
    await expect(input).toHaveValue(/@\w+ /); // hydrated — safe to type over
    await input.fill('@fable send your helper over the survey');
    await input.press('Enter');
    await expect(page.locator('.nx-prose', { hasText: 'helper finished the survey' })).toBeVisible();

    // The extension member truly exists server-side…
    const listed = await fetch(`${API}/api/rooms/eng/members`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }).then((res) => res.json() as Promise<{ members: { member: { kind: string; handle: string } }[] }>);
    const members = listed.members.map((entry) => entry.member);
    const extension = members.find((m) => m.kind === 'extension');
    expect(extension?.handle).toMatch(/^fable-ext-/);

    // …but never reaches the Members tab…
    await expect(page.getByTestId('member-fable')).toBeVisible();
    await expect(page.locator(`[data-testid="member-${extension!.handle}"]`)).toHaveCount(0);
    await expect(page.locator('.nx-member')).toHaveCount(
      members.filter((m) => m.kind !== 'extension').length,
    );

    // …and the header count matches the visible roster exactly.
    const meter = await page.getByTestId('meter').textContent();
    const counted = Number(/^(\d+) members/.exec(meter ?? '')?.[1]);
    await expect(page.locator('.nx-member')).toHaveCount(counted);
  });
});
