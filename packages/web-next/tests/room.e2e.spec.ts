import { expect, test, type Page } from '@playwright/test';

const ROOM = '/?room=eng&token=next-e2e-token';

async function openRoom(page: Page): Promise<void> {
  await page.goto(ROOM);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

async function openChronology(page: Page): Promise<void> {
  await page.goto('/?room=chronology&token=next-e2e-token');
  await expect(page.getByTestId('timeline')).toBeVisible();
}

test.describe('rail anatomy', () => {
  test('rows carry preview, working, attention, and unread states from the summary', async ({ page }) => {
    // Research has one incoming collaborator message after the owner's durable
    // cursor baseline; the owner's own newer post remains the preview but does
    // not count as unread.
    await openRoom(page);

    const research = page.getByTestId('room-link-research');
    await expect(research).toContainText('@richard: first pass: recall is fine');
    await expect(research.locator('.nx-unread')).toHaveText('1');

    const ops = page.getByTestId('room-link-ops');
    await expect(ops.locator('.nx-row-preview.is-error')).toHaveText('agent needs attention');

    const design = page.getByTestId('room-link-design');
    await expect(design).toContainText('@richard: new pricing page comps');
    await expect(design.locator('.nx-row-preview.is-error')).toHaveCount(0);
    await expect(design.locator('.nx-unread')).toHaveCount(0);

    // The live run keeps eng working, and working rooms sort first.
    const eng = page.getByTestId('room-link-eng');
    await expect(eng.locator('.nx-row-working')).toContainText('working');
    await expect(page.locator('.nx-rail-list .nx-row').first()).toHaveText(/Engineering/);
  });
});

test.describe('header', () => {
  test('shows the title, Live pill, and one faint stats line', async ({ page }) => {
    await openRoom(page);
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Engineering');
    await expect(page.locator('.nx-chat-header .nx-status')).toHaveText(/Live/);
    await expect(page.getByTestId('meter')).toHaveText(
      /^\d+ members · \d+ turns · [\d.,KM]+ tokens · \$\d+\.\d{2} today$/,
    );
  });
});

test.describe('transcript grouping', () => {
  test('chronological sort happens before same-sender grouping', async ({ page }) => {
    await openChronology(page);
    await expect(page.getByText('morning chronology marker')).toBeVisible();
    const turns = page.locator('.nx-column > .nx-turn');
    const texts = await turns.allTextContents();
    const indexOf = (part: string) => texts.findIndex((text) => text.includes(part));

    // This probe was inserted later by id, but its timestamp lies between m1/m2.
    expect(indexOf('morning chronology marker')).toBeLessThan(indexOf('chronology probe between'));
    expect(indexOf('chronology probe between')).toBeLessThan(indexOf('staging chronology marker'));
    const first = page.locator('article', { hasText: 'morning chronology marker' });
    await expect(first.locator('.nx-turn-meta')).toHaveCount(1);
    await expect(page.locator('article', { hasText: 'chronology probe between' })).toHaveClass(/is-grouped/);
    await expect(page.locator('article', { hasText: 'staging chronology marker' })).toHaveClass(/is-grouped/);
    // m3 came 18 minutes later from the same sender: fresh header.
    const fresh = page.locator('article', { hasText: 'later chronology marker' });
    await expect(fresh).not.toHaveClass(/is-grouped/);
    await expect(fresh.locator('.nx-turn-meta')).toHaveCount(1);

    // A finalized run follows ended_ts even though @muse's chat has a newer id;
    // the still-running @scout turn stays behind a chat posted after it began.
    expect(indexOf('chronology muse before')).toBeLessThan(indexOf('chronology completed run'));
    // The running turn no longer prints an in-row "running ·" line — the sticky
    // typing pill is the sole activity surface now — so its position is read
    // from the row itself.
    await expect(page.locator('.nx-run[data-run-status="running"]')).toHaveCount(1);
    const positions = await page.locator('.nx-column > .nx-turn').evaluateAll((nodes) => ({
      after: nodes.findIndex((node) => node.textContent?.includes('chronology chat after the running')),
      running: nodes.findIndex((node) => node.querySelector('.nx-run[data-run-status="running"]') !== null),
    }));
    expect(positions.after).toBeGreaterThanOrEqual(0);
    expect(positions.running).toBeGreaterThan(positions.after);
  });
});

test.describe('run evidence', () => {
  test('tool activity collapses to an aggregate line and expands to bordered cards', async ({ page }) => {
    await openRoom(page);
    const batch = page.getByTestId('tool-batch');
    const line = batch.locator('.nx-batch-line');
    await expect(line).toHaveText(/Ran 2 tools · wrote 1 file \+2 −1/);
    await expect(batch.locator('.nx-tool')).toHaveCount(0); // collapsed by default

    await line.click();
    await expect(batch.locator('.nx-tool')).toHaveCount(2);
    await expect(batch.locator('.nx-tool').first()).toContainText('pnpm test --filter auth');
    await expect(batch.locator('.nx-tool').nth(1)).toContainText('session.ts');

    await line.click();
    await expect(batch.locator('.nx-tool')).toHaveCount(0);
  });

  test('run prose flows once as turn content — never duplicated by final text', async ({ page }) => {
    await openRoom(page);
    const runBody = page.locator('[data-testid^="run-"]').first();
    await expect(runBody.locator('.nx-prose', { hasText: 'Queue is short' })).toHaveCount(1);
  });

  test('sequence text blocks share one turn header and each own a copy action', async ({ page }) => {
    await openRoom(page);
    const run = page.locator('article', { hasText: 'Queue is short' }).first();
    const blocks = run.locator('.nx-run-block');
    await expect(run.locator('.nx-turn-meta')).toHaveCount(1);
    await expect(run.locator(':scope > .nx-chip')).toHaveCount(1);
    await expect(blocks).toHaveCount(2);
    await expect(blocks.locator('[aria-label="Copy run block"]')).toHaveCount(2);
    await expect(blocks.filter({ hasText: 'Reasoning' })).toHaveCount(0);
    await blocks.first().hover();
    await expect(blocks.first().locator('.nx-run-block-actions')).toHaveCSS('opacity', '1');
  });
});

test.describe('interaction cards', () => {
  test('a pending approval renders its command detail and answerable options', async ({ page }) => {
    await openRoom(page);
    const card = page.locator('.nx-ask');
    await expect(card).toContainText('Approval needed');
    await expect(card).toContainText('Run `git push origin main`?');
    await expect(card.locator('.nx-ask-detail')).toHaveText('git push origin main');
    // Enabled but NOT clicked here — the interactions spec owns the answer flow.
    await expect(card.locator('button', { hasText: 'Allow' })).toBeEnabled();
  });
});

test.describe('held deliveries', () => {
  test('a held delivery surfaces as a system row naming the hold', async ({ page }) => {
    await openRoom(page);
    await expect(page.locator('.nx-system', { hasText: 'held' }))
      .toContainText('operator asked to wait for the release window');
  });
});

test.describe('accessibility', () => {
  test('the room is axe-clean in light and dark', async ({ page }) => {
    await openRoom(page);
    const { default: AxeBuilder } = await import('@axe-core/playwright');

    await page.waitForTimeout(350);
    const light = await new AxeBuilder({ page }).analyze();
    expect(light.violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);

    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.waitForTimeout(350);
    const dark = await new AxeBuilder({ page }).analyze();
    expect(dark.violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
  });
});
