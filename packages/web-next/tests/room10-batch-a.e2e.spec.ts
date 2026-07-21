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

// ── Item 3: prose is real sanitized markdown, styled by nx- tokens. ────────
const MARKDOWN = [
  '## Deploy plan',
  '',
  'Ship **carefully** with *checks*:',
  '',
  '- step one',
  '- step two',
  '',
  '1. first',
  '2. second',
  '',
  '> keep the release window quiet',
  '',
  'Run `rollback.sh` if needed:',
  '',
  '```bash',
  'git push origin main --force-with-lease',
  '```',
  '',
  '[runbook](https://example.com/runbook)',
  '',
  '<img src=x onerror="window.__pwned = true">',
  '',
  '[bad](javascript:alert(1))',
].join('\n');

test.describe('markdown prose', () => {
  test('run and message prose render sanitized markdown structures', async ({ page }) => {
    // The text_delta covers the streamed run-prose path, not just final text.
    await enqueue([{
      kind: 'complete',
      final_text: MARKDOWN,
      items: [{ type: 'run.item', item_type: 'text_delta', payload: { text: MARKDOWN } }],
    }]);
    await openRoom(page);
    const input = page.getByTestId('composer-input');
    await expect(input).toHaveValue(/@\w+ /);
    await input.fill('@fable print the deploy plan with `inline code` and **bold text**');
    await input.press('Enter');

    // The agent's markdown lands as structure, not literal text.
    const run = page.locator('.nx-prose', { has: page.locator('h2') });
    await expect(run.locator('h2')).toHaveText('Deploy plan');
    await expect(run.locator('strong', { hasText: 'carefully' })).toBeVisible();
    await expect(run.locator('em', { hasText: 'checks' })).toBeVisible();
    await expect(run.locator('ul > li')).toHaveCount(2);
    await expect(run.locator('ol > li')).toHaveCount(2);
    await expect(run.locator('blockquote')).toContainText('keep the release window quiet');
    await expect(run.locator('pre code')).toContainText('git push origin main --force-with-lease');

    // Links open away from the room, painted by the token — not browser blue.
    const link = run.locator('a', { hasText: 'runbook' });
    await expect(link).toHaveAttribute('href', 'https://example.com/runbook');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    expect(await link.evaluate((node) => getComputedStyle(node).color)).toBe('rgb(21, 128, 61)');

    // Raw HTML and javascript: hrefs never survive the sanitizer.
    await expect(run.locator('img')).toHaveCount(0);
    await expect(run.locator('a[href^="javascript"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as { __pwned?: boolean }).__pwned)).toBeUndefined();

    // Human messages get the same treatment.
    const message = page.locator('.nx-prose', { hasText: 'print the deploy plan' });
    await expect(message.locator('code')).toHaveText('inline code');
    await expect(message.locator('strong')).toHaveText('bold text');

    // The markdown-heavy room stays axe-clean in both themes.
    await page.waitForTimeout(350);
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const light = await new AxeBuilder({ page }).analyze();
    expect(light.violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.waitForTimeout(350);
    const dark = await new AxeBuilder({ page }).analyze();
    expect(dark.violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
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
    }).then((res) => res.json() as Promise<{
      members: { member: { kind: string; handle: string; removed_ts?: number } }[];
    }>);
    const members = listed.members.map((entry) => entry.member);
    const extension = members.find((m) => m.kind === 'extension');
    expect(extension?.handle).toMatch(/^fable-ext-/);

    // …but never reaches the Members tab…
    await expect(page.getByTestId('member-fable')).toBeVisible();
    await expect(page.locator(`[data-testid="member-${extension!.handle}"]`)).toHaveCount(0);
    await expect(page.locator('.nx-member')).toHaveCount(
      // The daemon also returns its structural system member. The roster's
      // contract is narrower: active, addressable humans and agents only.
      members.filter((m) => m.removed_ts === undefined && (m.kind === 'human' || m.kind === 'agent')).length,
    );

    // …and the header count matches the visible roster exactly.
    const meter = await page.getByTestId('meter').textContent();
    const counted = Number(/^(\d+) members/.exec(meter ?? '')?.[1]);
    await expect(page.locator('.nx-member')).toHaveCount(counted);
  });
});
