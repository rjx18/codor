import { expect, test, type Page } from '@playwright/test';

// The Preview tab is a bounded gallery combining durable produced artifacts, the
// room's message attachments, and embedded run images. Artifacts are fetched from
// an authenticated room-scoped endpoint, so the durable feed is intercepted here
// to render a deterministic raster/document/inert mix without a live snapshot.
const FILES = '/?room=files&token=next-e2e-token';
const DESIGN = '/?room=design&token=next-e2e-token';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// Durable artifacts get the highest source ids so they sort to the front of the
// newest-first gallery ahead of the seeded attachments.
const ARTIFACTS = [
  { id: 'a'.repeat(32), name: 'chart.png', media_type: 'image/png', size: PNG.length, source_message_id: 9003, produced_at: '2026-07-22T00:00:03.000Z' },
  { id: 'b'.repeat(32), name: 'report.pdf', media_type: 'application/pdf', size: 2048, source_message_id: 9002, produced_at: '2026-07-22T00:00:02.000Z' },
  { id: 'c'.repeat(32), name: 'diagram.svg', media_type: 'image/svg+xml', size: 512, source_message_id: 9001, produced_at: '2026-07-22T00:00:01.000Z' },
];

async function stubArtifacts(page: Page, room: string, artifacts: typeof ARTIFACTS): Promise<void> {
  // The serve endpoint (…/artifacts/<id>) must be registered first so the list
  // endpoint's stricter match does not swallow it.
  await page.route(new RegExp(`/api/rooms/${room}/artifacts/[^/?]+`), (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.route(new RegExp(`/api/rooms/${room}/artifacts(\\?.*)?$`), (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ artifacts }) }));
}

async function openPreview(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
  await page.getByTestId('context-tab-preview').click();
}

test.describe('preview gallery', () => {
  test('combines durable artifacts, message attachments, and classifies by type', async ({ page }) => {
    await stubArtifacts(page, 'files', ARTIFACTS);
    await openPreview(page, FILES);

    const gallery = page.getByTestId('preview-gallery');
    await expect(gallery).toBeVisible();

    // Raster thumbnails: the durable chart plus the seeded diagram.png attachment.
    const thumbs = gallery.getByTestId('preview-thumb');
    await expect(thumbs).toHaveCount(2);
    // The durable artifact sorts first and its <img> resolves the served endpoint.
    await expect(thumbs.first().locator('img')).toHaveAttribute('src', /\/api\/rooms\/files\/artifacts\/a+\?token=/);

    // Documents: the pdf artifact and the seeded notes.txt attachment render as cards.
    await expect(gallery.getByTestId('preview-doc').filter({ hasText: 'report.pdf' })).toBeVisible();
    await expect(gallery.getByTestId('preview-doc').filter({ hasText: 'notes.txt' })).toBeVisible();

    // svg is active content: it is NEVER an inline image — only an inert download.
    const inert = gallery.getByTestId('preview-inert').filter({ hasText: 'diagram.svg' });
    await expect(inert).toBeVisible();
    await expect(inert.locator('img')).toHaveCount(0);
    await expect(inert.locator('a')).toHaveAttribute('download', 'diagram.svg');
  });

  test('a raster thumbnail opens an accessible lightbox that closes on Escape', async ({ page }) => {
    await stubArtifacts(page, 'files', ARTIFACTS);
    await openPreview(page, FILES);

    const opener = page.getByTestId('preview-gallery').getByTestId('preview-thumb').first();
    // The durable artifact sorts first once the stubbed feed loads; wait for it so
    // .first() is chart.png rather than the seeded attachment that renders sooner.
    await expect(opener.locator('img')).toHaveAttribute('src', /\/api\/rooms\/files\/artifacts\/a+/);
    await opener.click();

    const lightbox = page.getByTestId('preview-lightbox');
    await expect(lightbox).toBeVisible();
    await expect(lightbox).toHaveAttribute('aria-modal', 'true');
    await expect(lightbox).toContainText('chart.png');
    // Fit image plus open/download affordances that address the served endpoint.
    await expect(lightbox.locator('.nx-lightbox-stage img')).toBeVisible();
    await expect(lightbox.getByRole('link', { name: 'Download' })).toHaveAttribute('download', 'chart.png');
    await expect(lightbox.getByRole('link', { name: 'Open' })).toHaveAttribute('href', /\/api\/rooms\/files\/artifacts\/a+/);

    // Escape closes the lightbox and returns focus to the thumbnail that opened it.
    await page.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('the close button dismisses the lightbox', async ({ page }) => {
    await stubArtifacts(page, 'files', ARTIFACTS);
    await openPreview(page, FILES);

    await page.getByTestId('preview-gallery').getByTestId('preview-thumb').first().click();
    await expect(page.getByTestId('preview-lightbox')).toBeVisible();
    await page.getByTestId('preview-lightbox-close').click();
    await expect(page.getByTestId('preview-lightbox')).toHaveCount(0);
  });

  test('an empty room shows the preview empty state', async ({ page }) => {
    await stubArtifacts(page, 'design', []);
    await openPreview(page, DESIGN);
    await expect(page.getByTestId('preview-empty')).toBeVisible();
    await expect(page.getByTestId('preview-gallery')).toHaveCount(0);
  });

  test('the gallery and open lightbox are axe-clean', async ({ page }) => {
    await stubArtifacts(page, 'files', ARTIFACTS);
    await openPreview(page, FILES);
    await expect(page.getByTestId('preview-gallery')).toBeVisible();

    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const gallery = await new AxeBuilder({ page }).analyze();
    expect(gallery.violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);

    const lightbox = page.getByTestId('preview-lightbox');
    await page.getByTestId('preview-gallery').getByTestId('preview-thumb').first().click();
    await expect(lightbox).toBeVisible();
    // Let the modal enter-animation settle so axe measures resting opacity, not a
    // mid-fade composite (which blends fg/bg and reports false-low contrast).
    await lightbox.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
    const audit = await new AxeBuilder({ page }).analyze();
    expect(audit.violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
  });
});

// The `preview` room is seeded through the REAL finalization snapshot path: an agent
// produces chart.png, the daemon snapshots it, and the source file is deleted — so
// these run without stubbing and prove durability end to end.
const PREVIEW = '/?room=preview&token=next-e2e-token';

test.describe('preview real backend (durable snapshots + inert classification)', () => {
  test('opens a durably snapshotted artifact after its source file was removed', async ({ page }) => {
    await openPreview(page, PREVIEW);
    const thumb = page.getByTestId('preview-gallery').getByTestId('preview-thumb').first();
    await expect(thumb.locator('img')).toHaveAttribute('src', /\/api\/rooms\/preview\/artifacts\//);
    await thumb.click();

    const img = page.getByTestId('preview-lightbox').locator('.nx-lightbox-stage img');
    await expect(img).toHaveAttribute('src', /\/api\/rooms\/preview\/artifacts\//);
    // The bytes served from the durable store actually decode — the source file is gone.
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  });

  test('renders a non-raster embedded run image as an inert card, never an <img>', async ({ page }) => {
    await openPreview(page, PREVIEW);
    const inert = page.getByTestId('preview-gallery').getByTestId('preview-inert').first();
    await expect(inert).toBeVisible();
    await expect(inert.locator('img')).toHaveCount(0); // svg is downloaded, never inlined
  });

  test('surfaces a path-free per-run storage-failure notice', async ({ page }) => {
    await openPreview(page, PREVIEW);
    const notice = page.getByTestId('preview-error');
    await expect(notice).toBeVisible();
    await expect(notice).not.toContainText('/'); // no path leaks into the notice
  });

  test('remounts Preview on room switch, dropping the previous room state', async ({ page }) => {
    await openPreview(page, PREVIEW);
    await expect(page.getByTestId('preview-error')).toBeVisible();

    // SPA-switch to a room with no artifacts/errors — the previous room's state must
    // not linger (the room-keyed remount clears it with no stale frame).
    await page.getByTestId('room-link-eng').click();
    await page.getByTestId('context-tab-preview').click();
    await expect(page.getByTestId('preview-error')).toHaveCount(0);
    await expect(page.locator('img[src*="/rooms/preview/artifacts/"]')).toHaveCount(0);
  });
});
