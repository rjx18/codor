import { expect, type Page } from '@playwright/test';

import { BASE, CONTROL } from './ports.js';

export { BASE };
export const ROOM = '/?room=eng&token=e2e-token';

export async function control(path: string, body: unknown = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${await res.text()}`);
  return await res.json() as Record<string, unknown>;
}

// harn:assume web-theme-accessible-modes ref=axe-room-matrix-shared
// The real gate behaviour lives here, guarded, rather than in the thin per-file callers:
// how each state is reached, how every dialog is dismissed before the next scan, and how
// axe runs once transitions have settled. Each spec file supplies only its theme, against
// its own fresh daemon, so nothing durable crosses a matrix.

export async function scan(page: Page): Promise<string[]> {
  // Let transitions settle. axe composites what it sees, so a panel caught mid-fade reports
  // the blend as a contrast failure the settled surface does not have.
  await page.waitForTimeout(350);
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.map(
    (v) => `${v.id} [${String(v.impact)}] ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
}

async function open(page: Page, url = ROOM): Promise<void> {
  // No addInitScript here: the theme is installed once by the caller before the first
  // navigation, and same-origin localStorage persists across every goto that follows.
  await page.goto(url);
}

/**
 * Scans every read-only room, dialog, settings, ledger and pairing state in one theme,
 * dismissing each dialog by its own control - never leaning on Escape, which does not
 * close the removal confirmation or the create dialog behind the folder picker. Returns
 * every violation found, tagged by state.
 */
export async function sweepRoomStates(page: Page, theme: 'light' | 'dark'): Promise<string[]> {
  // One init script for the whole sweep. It fires on every navigation and sets the same
  // value, so nothing accumulates and nothing depends on init-script order.
  await page.addInitScript((t) => {
    localStorage.setItem('codor-theme', t);
  }, theme);

  const found: string[] = [];
  const record = async (state: string): Promise<void> => {
    // Prove the document is actually in the theme this scan is recorded under - the label
    // must reflect the rendered page, not a loop variable.
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const v of await scan(page)) found.push(`${theme}/${state}: ${v}`);
  };

  await open(page);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await record('room:baseline');

  await page.getByTestId('toggle-message-search').click();
  await expect(page.getByTestId('message-search')).toBeVisible();
  await record('room:search');
  await page.getByTestId('toggle-message-search').click();
  await expect(page.getByTestId('message-search')).toHaveCount(0);

  await page.getByTestId('composer-input').fill('@a');
  await expect(page.getByTestId('mention-popup')).toBeVisible();
  await record('room:mention-popup');
  await page.getByTestId('composer-input').fill('');
  await expect(page.getByTestId('mention-popup')).toHaveCount(0);

  await page.getByTestId('spawn-agent').click();
  await expect(page.getByTestId('spawn-dialog')).toBeVisible();
  await record('dlg:spawn');

  // Spawn, kill and offer to remove - the only path to the removal alertdialog. The
  // handle is theme-unique so a collision cannot suffix and break the flow.
  const handle = `t${theme}`;
  await page.getByTestId('spawn-handle').fill(handle);
  await page.getByTestId('spawn-submit').click();
  await expect(page.getByTestId(`member-${handle}`)).toBeVisible();
  await page.getByTestId(`member-${handle}-toggle`).click();
  await page.getByTestId(`kill-${handle}`).click();
  await page.getByTestId(`remove-${handle}`).click();
  const removeConfirm = page.getByTestId(`remove-${handle}-confirm`);
  await expect(removeConfirm).toBeVisible();
  await record('dlg:remove-member');
  // Escape does NOT close this confirmation; dismiss it by its own Cancel button.
  await removeConfirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(removeConfirm).toHaveCount(0);

  await page.getByTestId('create-room').click();
  await expect(page.getByTestId('create-room-dialog')).toBeVisible();
  await record('dlg:create-channel');
  await page.getByTestId('browse-folders').click();
  await expect(page.getByTestId('folder-picker')).toBeVisible();
  await record('dlg:folder-picker');
  // One Escape closes only the folder picker, leaving the create dialog open. Close each.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('folder-picker')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('create-room-dialog')).toHaveCount(0);

  await page.evaluate(() => window.__codor.disconnect());
  await record('room:offline');
  await page.evaluate(() => window.__codor.reconnect());
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  await open(page, '/?room=eng&token=e2e-observer-token');
  await expect(page.getByTestId('read-only-room')).toBeVisible();
  await record('room:read-only');

  // Mobile.
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await page.getByTestId('open-room-drawer').click();
  await expect(page.getByTestId('room-drawer')).toBeVisible();
  await record('mob:drawer');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('room-drawer')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open channel context' }).click();
  await expect(page.getByTestId('context-sheet')).toBeVisible();
  await record('mob:context-sheet');
  await page.setViewportSize({ width: 1440, height: 900 });

  // Ledger: docked inspector, overlay inspector, and the note dialog.
  await control('/ledger-graph-init');
  await open(page, '/ledger?room=eng&token=e2e-token');
  await expect(page.getByTestId('ledger-graph-surface')).toBeVisible();
  await page.getByTestId('ledger-node-launch-plan').click();
  await record('ledger:docked');
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.reload();
  await page.getByTestId('ledger-node-launch-plan').click();
  await record('ledger:overlay');
  await page.setViewportSize({ width: 1440, height: 900 });

  await control('/ledger-init');
  await open(page);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await page.getByTestId('ledger-ref-risk-limits').first().click();
  await expect(page.getByTestId('ledger-note-dialog')).toBeVisible();
  await record('ledger:note-dialog');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('ledger-note-dialog')).toHaveCount(0);

  // The inbox needs something waiting in it.
  await control('/seed-history');
  await open(page);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
  await record('room:history+ask');
  await page.getByTestId('inbox-badge').click();
  await expect(page.getByTestId('inbox-panel')).toBeVisible();
  await record('room:inbox');

  // The real 390 mobile matrix, in this theme: each distinct state is driven and asserted to
  // exist before axe composites it, rather than collapsing several into one scan. History speaker
  // grouping, a pending ask card, a seeded running run whose tool rows collapse behind a summary,
  // a held delivery, then the drawer and the context sheet - genuinely on a phone, not scanned
  // back at 1440.
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  // harn:assume web-room-visual-hierarchy-matches-soft-editorial-reference ref=soft-editorial-speaker-grouping-390
  // The unframed mobile prose timeline groups a run of same-speaker messages: a continuation row
  // must exist before axe scans the history state.
  await expect(page.locator('.wr-message.is-grouped').first()).toBeVisible();
  // harn:end web-room-visual-hierarchy-matches-soft-editorial-reference
  await record('mob:history');

  // A genuinely pending ask card at the tail: enqueue an ask and trigger it from the phone
  // composer while the agent is idle, then leave it unanswered so the card stays on the phone.
  await control('/enqueue', {
    turns: [{
      kind: 'ask',
      prompt: 'Approve the pocket deploy?',
      options: ['Allow once', 'Deny'],
      replyPrefix: 'answered ',
    }],
  });
  await page.getByTestId('composer-input').fill('@alpha approve the pocket deploy');
  await page.getByTestId('composer-send').click();
  await expect(page.locator('.wr-ask-card')).toBeVisible();
  await record('mob:ask');

  // A seeded running run whose tool rows collapse behind a summary; it re-hydrates on the reload.
  const seeded = await control('/seed-running-run');
  const runId = String(seeded.run);
  await control('/hold', { body: '@alpha resume the pocket flow' });
  await open(page);
  await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');

  // harn:assume normalized-run-items-presented-live ref=live-run-prose-390
  // A running run keeps its live prose visible on the phone even while its tools are collapsed.
  await expect(page.getByTestId(`run-${runId}`)).toContainText('Tracing the pocket flow');
  // harn:end normalized-run-items-presented-live
  // harn:assume normalized-run-items-presented-live ref=collapsed-run-tools-390
  // ...and those tool rows are collapsed behind one summary line, not a framed evidence list.
  await expect(page.getByTestId(`run-${runId}-tools-collapsed`)).toBeVisible();
  // harn:end normalized-run-items-presented-live
  await record('mob:running-run');

  await expect(page.getByTestId('hold-banner')).toBeVisible();
  await record('mob:hold');

  await page.getByTestId('open-room-drawer').click();
  await expect(page.getByTestId('room-drawer')).toBeVisible();
  await record('mob:drawer');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('room-drawer')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open channel context' }).click();
  await expect(page.getByTestId('context-sheet')).toBeVisible();
  await record('mob:context');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 900 });

  for (const section of ['appearance', 'notifications', 'brakes', 'relay', 'devices', 'privacy']) {
    await open(page, `/settings?room=eng&token=e2e-token#${section}`);
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await record(`settings:${section}`);
  }

  await open(page, '/pair');
  await expect(page.getByTestId('pairing-page')).toBeVisible();
  await record('pairing');

  return found;
}
// harn:end web-theme-accessible-modes
