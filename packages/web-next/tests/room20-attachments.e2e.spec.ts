import { expect, test, type Page } from '@playwright/test';

// The files room is agent-free (so an attachments-only, unaddressed send is
// allowed) and seeded with a message carrying a rendered image + a download chip.
const FILES = '/?room=files&token=next-e2e-token';

async function openRoom(page: Page): Promise<void> {
  await page.goto(FILES);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('message attachments', () => {
  test('a seeded message renders an inline image and a download chip', async ({ page }) => {
    await openRoom(page);
    const attachments = page.getByTestId('message-attachments').first();
    await expect(attachments).toBeVisible();

    // Image renders inline, its src pointing at the served endpoint.
    const image = attachments.locator('.nx-attach-image img');
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('src', /\/api\/rooms\/files\/attachments\/.+/);

    // The non-image renders as a download chip naming the file.
    const download = attachments.locator('.nx-attach-download', { hasText: 'notes.txt' });
    await expect(download).toBeVisible();
    await expect(download).toHaveAttribute('download', 'notes.txt');
  });

  test('attaching files in the composer and sending renders them in the transcript', async ({ page }) => {
    await openRoom(page);
    await page.setInputFiles('[data-testid="composer-file"]', [
      { name: 'shot.png', mimeType: 'image/png', buffer: PNG },
      { name: 'log.txt', mimeType: 'text/plain', buffer: Buffer.from('composer upload line\n') },
    ]);
    // Both uploads land as pending chips before send.
    await expect(page.getByTestId('attach-tray').locator('.nx-attach-chip')).toHaveCount(2);

    await page.getByTestId('composer-send').click();

    // The sent message renders the uploaded file as its own download chip.
    const uploaded = page.locator('.nx-attach-download', { hasText: 'log.txt' });
    await expect(uploaded).toBeVisible();
    await expect(page.getByTestId('attach-tray')).toHaveCount(0); // tray cleared after send
  });

  test('the transcript with attachments is axe-clean', async ({ page }) => {
    await openRoom(page);
    await expect(page.getByTestId('message-attachments').first()).toBeVisible();

    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.target[0]}`)).toEqual([]);
  });

  test('a deleted message shows a tombstone with no attachments', async ({ page }) => {
    await openRoom(page);
    // The seeded message (owner is the operator viewing here) can be deleted.
    const turn = page.locator('article.nx-turn', { hasText: 'here are the files' });
    await expect(turn.getByTestId('message-attachments')).toBeVisible();
    const id = (await turn.getAttribute('data-testid'))!.replace('msg-', '');

    await turn.hover();
    await page.getByTestId(`msg-${id}-delete`).click();
    await page.getByTestId('delete-confirm-go').click();

    await expect(page.getByTestId(`msg-${id}-deleted`)).toHaveText('[deleted]');
    await expect(page.getByTestId(`msg-${id}`).getByTestId('message-attachments')).toHaveCount(0);
  });
});
