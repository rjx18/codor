import { expect, test, type Page } from '@playwright/test';

const ROOM = '/?room=eng&token=next-e2e-token';
// Specs whose subject IS a seeded message or run open the stable fixtures room:
// eng accretes as other specs post into it, so its boot fixtures fall outside the
// bounded cold tail and the spec would end up exercising paging, not itself.
const FIXTURES = '/?room=fixtures&token=next-e2e-token';
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

async function enqueue(turns: unknown[]): Promise<void> {
  const res = await fetch(`${CONTROL}/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turns }),
  });
  if (!res.ok) throw new Error(`enqueue failed: ${await res.text()}`);
}

async function completeAgent(handle: string, finalText: string): Promise<void> {
  const res = await fetch(`${CONTROL}/complete-agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, final_text: finalText, prompt: `update ${handle} default` }),
  });
  if (!res.ok) throw new Error(`complete agent failed: ${await res.text()}`);
}

async function openRoom(page: Page, url = ROOM): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

test.describe('composer addressing', () => {
  test('drafts open addressed to the latest finalized agent', async ({ page }) => {
    await openRoom(page);
    await expect(page.getByTestId('composer-input')).toHaveValue('@fable ');
  });

  test('seed follows hydrated defaults until the first manual keystroke', async ({ page }) => {
    await openRoom(page);
    const input = page.getByTestId('composer-input');
    await expect(input).toHaveValue('@fable ');

    await completeAgent('hydrate', 'Hydrated agent completed.');
    await expect(input).toHaveValue('@hydrate ');

    await input.pressSequentially('keep this draft');
    await completeAgent('restore', 'Default changed again.');
    await expect(input).toHaveValue('@hydrate keep this draft');
  });

  test('an unaddressed send is blocked with a friendly hint', async ({ page }) => {
    await openRoom(page);
    const input = page.getByTestId('composer-input');
    // Socket-open precedes the atomic room commit. Wait until the addressed
    // seed proves the member roster/default projection is ready before testing
    // the operator's deliberate removal of that recipient.
    await expect(input).toHaveValue(/@\w+ /);
    await input.fill('ship it please');
    await input.press('Enter');
    await expect(page.getByTestId('composer-hint')).toContainText('Say who this is for');
    await input.fill(''); // no message was posted
    await expect(page.locator('.nx-prose', { hasText: 'ship it please' })).toHaveCount(0);
  });

  test('the @ popover lists members and keyboard-inserts a mention', async ({ page }) => {
    await openRoom(page);
    const input = page.getByTestId('composer-input');
    // Socket-open precedes the atomic room commit. Clearing an already-empty
    // textarea fires no input event, so wait for the hydrated seed before the
    // deliberate clear locks the draft against later default-recipient updates.
    await expect(input).toHaveValue(/@\w+ /);
    await input.fill('');
    await input.pressSequentially('@mu');
    const popover = page.getByTestId('mention-popover');
    await expect(popover).toBeVisible();
    await expect(popover).toContainText('@muse');
    await input.press('Enter');
    await expect(input).toHaveValue('@muse ');
    await expect(popover).toBeHidden();
  });

  test('a sent message reaches its agent and earns the seen tick', async ({ page }) => {
    await enqueue([{ kind: 'complete', final_text: 'On it — summarizing now.' }]);
    await openRoom(page);
    const input = page.getByTestId('composer-input');
    // Socket-open precedes the atomic room commit. Under a full-suite build the
    // textarea can be visible while sending is still hydration-gated, so wait
    // for the seeded recipient before replacing it and pressing Enter.
    await expect(input).toHaveValue(/@\w+ /);
    await input.fill('@fable quick status line please');
    await input.press('Enter');
    await expect(input).toHaveValue('@fable '); // cleared, then re-seeded to the default recipient
    const sent = page.locator('article', { hasText: 'quick status line please' }).first();
    await expect(sent).toBeVisible();
    await expect(sent.locator('[data-testid$="-seen"]')).toHaveAttribute('data-seen', 'true');
    await expect(page.locator('.nx-prose', { hasText: 'On it — summarizing now.' })).toBeVisible();
  });

  test('quote inserts the line addressed to its author', async ({ page }) => {
    await openRoom(page, FIXTURES);
    const input = page.getByTestId('composer-input');
    await input.fill('');
    await page.getByTestId('msg-1').hover();
    await page.getByTestId('msg-1-quote').click();
    await expect(input).toHaveValue(/@richard > morning/);
  });
});

// harn:assume desktop-composer-groups-attach-and-send-bottom-right ref=composer-alignment-regression
test.describe('desktop composer alignment', () => {
  test('attach and send are one bottom-right group sharing a centre, and Enter still sends', async ({ page }) => {
    await openRoom(page);
    const input = page.getByTestId('composer-input');
    // A tall message distinguishes a bottom-right action group from controls that
    // each float to the growing bar's optical middle.
    await input.fill('one\ntwo\nthree\nfour\nfive');

    const attach = (await page.getByTestId('composer-attach').boundingBox())!;
    const send = (await page.getByTestId('composer-send').boundingBox())!;
    const bar = (await page.locator('.nx-composer-bar').boundingBox())!;
    const attachCenter = attach.y + attach.height / 2;
    const sendCenter = send.y + send.height / 2;
    // Attach and send share one centre line despite different heights.
    expect(Math.abs(attachCenter - sendCenter)).toBeLessThanOrEqual(1);
    // The group sits in the lower half of the tall bar — bottom-aligned, not centred.
    expect(sendCenter).toBeGreaterThan(bar.y + bar.height / 2);
    // ...and hugs the bar's right content edge.
    expect(bar.x + bar.width - (send.x + send.width)).toBeLessThanOrEqual(12);

    // Desktop keyboard behaviour is unchanged by the grouping: Shift+Enter
    // breaks the line. The send half runs in the isolated fixtures room, since
    // posting here would consume the queued turn the holds test depends on.
    await input.fill('@fable desktop line one');
    await input.press('Shift+Enter');
    await input.pressSequentially('desktop line two');
    await expect(input).toHaveValue('@fable desktop line one\ndesktop line two');
    await input.fill(''); // leave the shared room as found
  });

  test('Enter still sends on desktop', async ({ page }) => {
    await openRoom(page, FIXTURES);
    const input = page.getByTestId('composer-input');
    // Sending stays hydration-gated after socket-open, so wait for the seeded
    // recipient before replacing it — otherwise Enter lands on a disabled send
    // and the draft simply stays put.
    await expect(input).toHaveValue(/@\w+ /);
    // Addressed to the human owner so no agent turn starts: the FakeAdapter
    // queue is shared across specs running in parallel, and consuming a turn
    // here strands whichever spec enqueued it.
    await input.fill('@richard desktop enter sends');
    await input.press('Enter');
    // The draft re-seeds with a default recipient after a send, so the contract
    // is that the typed body left the box and posted — not that it is empty.
    await expect(input).not.toHaveValue(/desktop enter sends/);
    await expect(page.locator('article', { hasText: 'desktop enter sends' }).first()).toBeVisible();
  });
});
// harn:end desktop-composer-groups-attach-and-send-bottom-right

test.describe('channel header chrome', () => {
  test('the desktop header drops the redundant Channel settings button; the rail Settings still opens', async ({ page }) => {
    await openRoom(page);
    // The duplicate header button (which routed to the same global settings page)
    // is gone.
    await expect(page.getByTestId('room-settings')).toHaveCount(0);
    // The rail's single global Settings entry remains and navigates to settings.
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings/);
  });
});

test.describe('floating composer surfaces', () => {
  const WIDTHS = [390, 1024, 1440];

  const surfaceChrome = async (locator: import('@playwright/test').Locator) =>
    await locator.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        padding: parseFloat(style.paddingTop),
        border: parseFloat(style.borderTopWidth),
        radius: parseFloat(style.borderTopLeftRadius),
        background: style.backgroundColor,
      };
    });

  // The mobile width has no connection indicator, so these navigate without
  // openRoom's desktop-only assertion.
  const openAt = async (page: Page, width: number): Promise<void> => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(ROOM);
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.getByTestId('composer-input')).toBeVisible();
  };

  test('the mention picker is a padded, bordered surface that fits every width', async ({ page }) => {
    for (const width of WIDTHS) {
      await openAt(page, width);
      const input = page.getByTestId('composer-input');
      await input.fill('@fa');
      const picker = page.getByTestId('mention-popover');
      await expect(picker).toBeVisible();

      const chrome = await surfaceChrome(picker);
      expect(chrome.padding, `padding at ${String(width)}`).toBeGreaterThan(0);
      expect(chrome.border, `border at ${String(width)}`).toBeGreaterThan(0);
      expect(chrome.radius, `radius at ${String(width)}`).toBeGreaterThan(0);
      expect(chrome.background, `raised fill at ${String(width)}`).not.toBe('rgba(0, 0, 0, 0)');

      // Viewport-safe: never hangs off either edge.
      const box = (await picker.boundingBox())!;
      expect(box.x, `left edge at ${String(width)}`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `right edge at ${String(width)}`).toBeLessThanOrEqual(width);
      await input.fill('');
    }
  });

  test('the attachment tray stays inside the composer at every width', async ({ page }) => {
    for (const width of WIDTHS) {
      await openAt(page, width);
      await page.setInputFiles('[data-testid="composer-file"]', [
        { name: `staged-${String(width)}.txt`, mimeType: 'text/plain', buffer: Buffer.from('staged\n') },
      ]);
      const tray = page.getByTestId('attach-tray');
      await expect(tray).toBeVisible();

      const chrome = await surfaceChrome(tray);
      expect(chrome.padding, `padding at ${String(width)}`).toBeGreaterThan(0);
      expect(chrome.border, `border at ${String(width)}`).toBeGreaterThan(0);
      expect(chrome.radius, `radius at ${String(width)}`).toBeGreaterThan(0);

      // It is the composer's tray, so it may not grow wider than the composer.
      const trayBox = (await tray.boundingBox())!;
      const barBox = (await page.locator('.nx-composer-bar').first().boundingBox())!;
      expect(trayBox.width, `tray width at ${String(width)}`)
        .toBeLessThanOrEqual(barBox.width + 1);
      expect(trayBox.x, `tray left at ${String(width)}`).toBeGreaterThanOrEqual(barBox.x - 1);
      expect(trayBox.x + trayBox.width, `tray right at ${String(width)}`)
        .toBeLessThanOrEqual(barBox.x + barBox.width + 1);

      await page.reload(); // drop the staged file before the next width
      await expect(page.getByTestId('timeline')).toBeVisible();
      await expect(page.getByTestId('attach-tray')).toHaveCount(0);
    }
  });

  test('both surfaces stay visibly separate from the composer in dark theme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openRoom(page);
    const input = page.getByTestId('composer-input');
    await input.fill('@fa');
    await expect(page.getByTestId('mention-popover')).toBeVisible();
    await page.setInputFiles('[data-testid="composer-file"]', [
      { name: 'dark.txt', mimeType: 'text/plain', buffer: Buffer.from('dark\n') },
    ]);

    const fill = async (selector: string) =>
      await page.locator(selector).first().evaluate((node) => getComputedStyle(node).backgroundColor);
    const bar = await fill('.nx-composer-bar');
    const picker = await fill('[data-testid="mention-popover"]');
    const tray = await fill('[data-testid="attach-tray"]');

    // Raised, not a black slab, and distinct from the surface beneath them.
    expect(picker).not.toBe(bar);
    expect(tray).not.toBe(bar);
    expect(picker).not.toBe('rgb(0, 0, 0)');
    expect(tray).not.toBe('rgb(0, 0, 0)');

    // Axe with both surfaces actually open, not merely on the resting screen.
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target[0]}`))
      .toEqual([]);
    await input.fill('');
  });
});

test.describe('typing chip spacing', () => {
  test('working chips keep a measured gap above the composer and stay sticky', async ({ page }) => {
    // Read-only against the fixture's permanently running @scout turn: this
    // test enqueues nothing, posts nothing and stops nothing, so it cannot
    // consume a fake turn another spec is waiting on. An earlier version of it
    // did exactly that and took room5's reply with it.
    await openRoom(page);
    const bar = page.locator('.nx-typing-bar');
    await expect(bar).toBeVisible();
    // The chip carries initials, not the handle, so assert the working agent's
    // chip is present rather than matching display text.
    await expect(bar.locator('.nx-typing-agent')).toHaveCount(1);

    // The external gap that keeps the pill clear of the composer is the margin
    // below the sticky bar. Assert it directly and deterministically — a
    // bounding-box delta is timing-sensitive across the sticky/scroll interaction
    // (it reads 0 mid-relayout), which the widened margin does not change.
    const margin = await page.evaluate(() => {
      const chips = document.querySelector('.nx-typing-bar');
      return chips ? parseFloat(getComputedStyle(chips).marginBottom) : -1;
    });
    // Phase 2 widened it from --sp-3 (12px) to --sp-5 (22px).
    expect(margin).toBeGreaterThanOrEqual(20);

    // Sticky survives scrolling the transcript.
    await page.getByTestId('timeline').evaluate((node) => { node.scrollTop = 0; });
    await expect(bar).toBeVisible();
  });
});

test.describe('holds', () => {
  test('the banner names the held delivery and Release runs it', async ({ page }) => {
    await enqueue([{ kind: 'complete', final_text: 'Keys rotated.' }]);
    await openRoom(page);
    const banner = page.getByTestId('hold-banner');
    await expect(banner).toContainText('Held for @fable');
    await banner.locator('button', { hasText: 'Release' }).click();
    await expect(banner).toBeHidden();
    await expect(page.locator('.nx-prose', { hasText: 'Keys rotated.' })).toBeVisible();
  });
});

test.describe('asks', () => {
  test('answering an approval resolves it durably and the card leaves', async ({ page }) => {
    await openRoom(page);
    const card = page.locator('.nx-ask');
    await expect(card).toBeVisible();
    await card.locator('button', { hasText: 'Allow' }).click();
    await expect(card).toBeHidden();
    await expect(page.locator('.nx-prose', { hasText: 'push Allow' })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.locator('.nx-ask')).toHaveCount(0); // resolution survived the reload
  });
});

test.describe('inbox', () => {
  test('the badge count opens onto matching rows that mark read and jump', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('inbox-toggle').click();
    const panel = page.getByTestId('inbox-panel');
    await expect(panel).toBeVisible();
    const badge = page.getByTestId('inbox-badge');
    if (await badge.isVisible()) {
      const count = Number(await badge.textContent());
      await expect(panel.locator('.nx-inbox-row')).toHaveCount(count);
      await panel.locator('.nx-inbox-row').first().click();
      await expect(panel).toBeHidden();
    } else {
      await expect(panel.getByTestId('inbox-empty')).toBeVisible();
    }
  });
});

test.describe('search', () => {
  test('results jump to the permalinked message', async ({ page }) => {
    await openRoom(page, FIXTURES);
    await page.getByTestId('toggle-message-search').click();
    await page.getByTestId('search-input').fill('staging deploy');
    const hit = page.getByTestId('search-hit-2');
    await expect(hit).toContainText('staging deploy is green');
    await hit.click();
    await expect(page.getByTestId('search-overlay')).toBeHidden();
    await expect(page).toHaveURL(/#2$/);
    await expect(page.getByTestId('msg-2')).toBeInViewport();
  });
});

test.describe('reduced motion', () => {
  test('expanding evidence and jumping still work without animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openRoom(page, FIXTURES);
    const batch = page.getByTestId('tool-batch');
    await batch.locator('.nx-batch-line').click();
    await expect(batch.locator('.nx-tool')).toHaveCount(2);
  });
});
