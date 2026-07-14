import { expect, test } from '@playwright/test';

import { CONTROL } from './ports.js';

test.use({ viewport: { width: 1440, height: 900 } });

const ROOM = '/?room=eng&token=e2e-token';

async function control(path: string, body: unknown = {}): Promise<void> {
  const res = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${await res.text()}`);
}

// harn:assume literal-draft-effective-recipient-visible ref=composer-autocomplete-semantics
test('the composer announces its suggestions without claiming a role it cannot have', async ({ page }) => {
  await page.goto(ROOM);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  const input = page.getByTestId('composer-input');
  // A textarea may not carry aria-expanded; that state belongs to the button.
  await expect(input).not.toHaveAttribute('aria-expanded', /.*/);
  await expect(input).toHaveAttribute('aria-autocomplete', 'list');
  await expect(page.getByTestId('composer-mention')).toHaveAttribute('aria-expanded', 'false');

  await input.fill('@al');
  await expect(page.getByTestId('mention-popup')).toBeVisible();

  // The popup is the list the textbox controls, and the highlighted member is its
  // active descendant - the two things a textbox is allowed to say.
  await expect(input).toHaveAttribute('aria-controls', 'composer-mentions');
  await expect(input).toHaveAttribute('aria-activedescendant', /^mention-/);
  await expect(page.getByTestId('composer-mention')).toHaveAttribute('aria-expanded', 'true');

  // The open state a screen reader actually hears.
  await expect(page.getByTestId('composer-mention-status')).toHaveText(/member suggestion/);
});
// harn:end literal-draft-effective-recipient-visible

// harn:assume web-spawn-dialog-exposes-canonical-agent-controls ref=spawn-dialog-semantics
test('the spawn modal is a dialog, traps focus, and sits exactly where it did', async ({ page }) => {
  await page.goto(ROOM);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  await page.getByTestId('spawn-agent').click();
  const dialog = page.getByTestId('spawn-dialog');
  await expect(dialog).toBeVisible();

  // The role must sit on an element allowed to carry it - a form is not.
  await expect(dialog).toHaveJSProperty('tagName', 'DIV');
  await expect(dialog).toHaveAttribute('role', 'dialog');
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(page.getByRole('dialog', { name: 'Spawn agent' })).toBeVisible();

  // The form still submits, and still draws no box of its own.
  const form = dialog.locator('form.wr-spawn-form');
  await expect(form).toHaveCount(1);
  await expect(form).toHaveCSS('display', 'contents');

  // Geometry: the dialog is centred in the viewport and keeps its capped width.
  const box = (await dialog.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(640);
  const centre = box.x + box.width / 2;
  expect(Math.abs(centre - 1440 / 2)).toBeLessThanOrEqual(1);

  // The trap still cycles inside the dialog, and Escape still closes it.
  await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
// harn:end web-spawn-dialog-exposes-canonical-agent-controls

// harn:assume web-shell-responsive-three-pane ref=unique-landmark-names
test('every landmark in the shell is distinguishable by name', async ({ page }) => {
  await page.goto(ROOM);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  // The suite depends on this name; it must survive the labelling.
  await expect(page.getByRole('navigation', { name: 'Channels' })).toBeVisible();

  const landmarks = await page.evaluate(() =>
    [...document.querySelectorAll('aside')]
      .filter((el) => el.checkVisibility())
      .map((el) => `${el.getAttribute('role') ?? 'complementary'}:${el.getAttribute('aria-label') ?? ''}`),
  );
  expect(landmarks.every((name) => !name.endsWith(':'))).toBe(true);
  expect(new Set(landmarks).size).toBe(landmarks.length);
});
// harn:end web-shell-responsive-three-pane

// harn:assume web-glass-theme-accessible-modes ref=theme-contrast-values
test('the two light paths resolve identically, and the repaired tokens hold AA', async ({ page }) => {
  const read = async () =>
    page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return {
        faint: s.getPropertyValue('--wr-faint').trim(),
        emerald: s.getPropertyValue('--wr-emerald').trim(),
        amber: s.getPropertyValue('--wr-amber').trim(),
      };
    });

  // Light by explicit choice.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => { localStorage.setItem('codor-theme', 'light'); });
  await page.goto(ROOM);
  const explicitLight = await read();

  // Light by system preference, with no stored choice.
  await page.context().clearCookies();
  const fresh = await page.context().newPage();
  await fresh.emulateMedia({ colorScheme: 'light' });
  await fresh.addInitScript(() => { localStorage.setItem('codor-theme', 'system'); });
  await fresh.goto(ROOM);
  const systemLight = await fresh.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    return {
      faint: s.getPropertyValue('--wr-faint').trim(),
      emerald: s.getPropertyValue('--wr-emerald').trim(),
      amber: s.getPropertyValue('--wr-amber').trim(),
    };
  });

  // The light palette is authored twice in the stylesheet. If the two ever drift,
  // an explicit light choice and a system light preference stop agreeing.
  expect(systemLight).toEqual(explicitLight);
  expect(explicitLight.emerald).toBe('#31692a');
  expect(explicitLight.amber).toBe('#7d5b00');

  // And the dark neutral that could not hold AA on the raised surfaces.
  const dark = await fresh.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    return getComputedStyle(document.documentElement).getPropertyValue('--wr-faint').trim();
  });
  expect(dark).toBe('#8a8d93');
});
// harn:end web-glass-theme-accessible-modes

// harn:assume web-room-rail-creates-owner-room ref=create-channel-semantics
test('the create-channel modal is a dialog, traps focus, and sits exactly where it did', async ({ page }) => {
  await page.goto(ROOM);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  await page.getByTestId('create-room').click();
  const dialog = page.getByTestId('create-room-dialog');
  await expect(dialog).toBeVisible();

  // Same defect as the spawn dialog: ARIA does not allow role=dialog on a form.
  await expect(dialog).toHaveJSProperty('tagName', 'DIV');
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(page.getByRole('dialog', { name: 'Create channel' })).toBeVisible();

  const form = dialog.locator('form.wr-channel-form');
  await expect(form).toHaveCount(1);
  await expect(form).toHaveCSS('display', 'contents');

  // The wrapper must inherit the box the form owned, or the modal silently moves.
  const box = (await dialog.boundingBox())!;
  const centre = box.x + box.width / 2;
  expect(Math.abs(centre - 1440 / 2)).toBeLessThanOrEqual(1);

  await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
// harn:end web-room-rail-creates-owner-room

// harn:assume web-shell-responsive-three-pane ref=mobile-drawer-semantics
test('the mobile drawer is a dialog on an element allowed to be one, and still dismisses', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(ROOM);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  await page.getByTestId('open-room-drawer').click();
  const drawer = page.getByTestId('room-drawer');
  await expect(drawer).toBeVisible();

  // An <aside> may not carry role=dialog; a <section> may.
  await expect(drawer).toHaveJSProperty('tagName', 'SECTION');
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  await expect(page.getByRole('dialog', { name: 'Channels' })).toBeVisible();

  // Focus is still managed inside it, and Escape still closes it.
  await expect(drawer.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
});
// harn:end web-shell-responsive-three-pane

// harn:assume graph-derived-from-vault-links-readonly ref=ledger-graph-semantics
test('the ledger exposes its nodes, and its inspector is valid docked and overlaid', async ({ page }) => {
  await control('/ledger-graph-init');

  // Wide: the inspector is docked, so it is a complementary landmark.
  await page.goto('/ledger?room=eng&token=e2e-token');
  await expect(page.getByTestId('ledger-graph-surface')).toBeVisible();

  // role=img is atomic; the node buttons inside it were unreachable. A group may have them.
  const svg = page.locator('[data-testid="ledger-graph-surface"] svg');
  await expect(svg).toHaveAttribute('role', 'group');
  await expect(page.getByTestId('ledger-node-launch-plan')).toBeVisible();

  await page.getByTestId('ledger-node-launch-plan').click();
  const inspector = page.getByTestId('ledger-inspector');
  await expect(inspector).toHaveJSProperty('tagName', 'SECTION');
  await expect(inspector).toHaveAttribute('role', 'complementary');

  // Narrow: the same element overlays, and must now be a named dialog.
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.reload();
  await page.getByTestId('ledger-node-launch-plan').click();
  await expect(inspector).toHaveAttribute('role', 'dialog');
  await expect(inspector).toHaveAttribute('aria-modal', 'true');
  await expect(page.getByRole('dialog', { name: 'Selected ledger note' })).toBeVisible();
});
// harn:end graph-derived-from-vault-links-readonly
