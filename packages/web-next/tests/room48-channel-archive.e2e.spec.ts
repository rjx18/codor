import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const TOKEN = 'next-e2e-token';
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
const SPA_ORIGIN = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_SPA_PORT ?? '28139'}`;

async function control<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`control ${path} failed: ${response.status}`);
  return (await response.json()) as T;
}

async function pasteCode(page: Page, code: string): Promise<void> {
  await page.getByTestId('pairing-code-0').evaluate((element, pasted) => {
    const data = new DataTransfer();
    data.setData('text/plain', pasted);
    element.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  }, code);
}

const computerButton = (page: Page, label: string) =>
  page.getByRole('button', { name: new RegExp(label) }).first();

async function delayArchiveDispatch(page: Page, delayMs = 350): Promise<void> {
  await page.addInitScript((delay) => {
    const runtime = window as unknown as {
      __archiveActions?: Array<{ room?: string; ref?: string }>;
      __archiveSendInstalled?: boolean;
    };
    runtime.__archiveActions = [];
    if (runtime.__archiveSendInstalled) return;
    runtime.__archiveSendInstalled = true;
    const nativeSend = window.WebSocket.prototype.send;
    window.WebSocket.prototype.send = function send(
      this: WebSocket,
      data: string | ArrayBufferLike | Blob | ArrayBufferView,
    ): void {
      let frame: { type?: unknown; room?: unknown; ref?: unknown; act?: { act?: unknown }} | undefined;
      try { frame = JSON.parse(String(data)) as typeof frame; } catch { /* not a JSON app frame */ }
      if (frame?.type === 'act' && frame.act?.act === 'archive_room') {
        const socket = this;
        window.setTimeout(() => {
          try {
            nativeSend.call(socket, data);
            runtime.__archiveActions?.push({
              room: typeof frame?.room === 'string' ? frame.room : undefined,
              ref: typeof frame?.ref === 'string' ? frame.ref : undefined,
            });
          } catch { /* the socket closed before this delayed test write */ }
        }, delay);
        return;
      }
      nativeSend.call(this, data);
    };
  }, delayMs);
}

async function delayNextHostedWrite(page: Page, delayMs = 350): Promise<void> {
  await page.evaluate((delay) => {
    const runtime = window as unknown as {
      __delayNextHostedWrite?: boolean;
      __hostedSendPatched?: boolean;
      __hostedDelayedWrites?: number;
    };
    runtime.__delayNextHostedWrite = true;
    runtime.__hostedDelayedWrites = 0;
    if (runtime.__hostedSendPatched) return;
    runtime.__hostedSendPatched = true;
    const nativeSend = window.WebSocket.prototype.send;
    window.WebSocket.prototype.send = function send(
      this: WebSocket,
      data: string | ArrayBufferLike | Blob | ArrayBufferView,
    ): void {
      if (!runtime.__delayNextHostedWrite) {
        nativeSend.call(this, data);
        return;
      }
      runtime.__delayNextHostedWrite = false;
      const socket = this;
      window.setTimeout(() => {
        try {
          nativeSend.call(socket, data);
          runtime.__hostedDelayedWrites = (runtime.__hostedDelayedWrites ?? 0) + 1;
        } catch { /* the socket closed before this delayed test write */ }
      }, delay);
    };
  }, delayMs);
}

async function prepareHostedPage(page: Page, relayUrl: string): Promise<void> {
  await page.addInitScript((url) => {
    (window as unknown as { __CODOR_RELAY_URL?: string }).__CODOR_RELAY_URL = url;
    const NativeWebSocket = window.WebSocket;
    const runtime = window as unknown as {
      __relaySessionDials?: Record<string, number>;
      __codorRelayAppOpens?: Array<{ session: string; generation: number }>;
    };
    runtime.__relaySessionDials = {};
    runtime.__codorRelayAppOpens = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(target: string | URL, protocols?: string | string[]) {
        super(target, protocols);
        const value = String(target);
        if (value.includes('/v1/session/')) {
          const counts = (window as unknown as {
            __relaySessionDials: Record<string, number>;
          }).__relaySessionDials;
          counts[value] = (counts[value] ?? 0) + 1;
        }
      }
    };
  }, relayUrl);
}

async function openRoom(page: Page, room: string, token = TOKEN, expectConnection = true): Promise<void> {
  await page.goto(`/?room=${room}&token=${token}`);
  await expect(page.getByTestId('timeline')).toBeVisible();
  if (expectConnection) await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

async function confirmArchive(page: Page, room: string): Promise<void> {
  await page.getByTestId(`room-menu-trigger-${room}`).click();
  await page.getByTestId(`archive-channel-open-${room}`).click();
  await expect(page.getByTestId(`archive-channel-confirm-${room}`)).toBeVisible();
  await page.getByTestId(`archive-channel-confirm-${room}`).click();
}

// harn:assume channel-archive-menu-is-viewport-safe-and-accessible ref=channel-archive-menu-a11y-regression
test.describe('channel archive context menu', () => {
  test('opens from the row without navigation and cancel returns focus', async ({ page }) => {
    await openRoom(page, 'research');
    const trigger = page.getByTestId('room-menu-trigger-research');
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('channel-archive-menu-research')).toBeVisible();
    await expect(page).toHaveURL(/room=research/);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('channel-archive-menu-research')).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await page.getByTestId('room-link-research').click({ button: 'right' });
    await expect(page.getByTestId('channel-archive-menu-research')).toBeVisible();
    await expect(page).toHaveURL(/room=research/);
    await page.getByTestId('archive-channel-open-research').click();
    await page.getByTestId('archive-channel-cancel-research').click();
    await expect(page.getByTestId('room-link-research')).toBeVisible();
  });

  // harn:assume channel-archive-ui-captures-source-and-authoritative-result ref=channel-archive-discovery-regression
  test('archives an inactive channel while preserving the active draft', async ({ page }) => {
    await openRoom(page, 'eng');
    const draft = page.getByTestId('composer-input');
    await draft.fill('keep this draft while another channel is archived');
    await confirmArchive(page, 'design');
    await expect(page.getByTestId('room-link-design')).toHaveCount(0);
    await expect(page.locator('.nx-chat-title h1')).toHaveText('Engineering');
    await expect(draft).toHaveValue('keep this draft while another channel is archived');

    await page.reload();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.getByTestId('room-link-design')).toHaveCount(0);
  });

  test('archives the active channel and selects another authorized channel', async ({ page }) => {
    await openRoom(page, 'trash');
    await confirmArchive(page, 'trash');
    await expect(page.getByTestId('room-link-trash')).toHaveCount(0);
    await expect(page.locator('.nx-chat-title h1')).not.toHaveText('Trash');
    await expect(page.getByTestId('timeline')).toBeVisible();
  });

  test('coalesces a double activation into one archive result', async ({ page }) => {
    await delayArchiveDispatch(page);
    await openRoom(page, 'preview');
    await page.getByTestId('room-menu-trigger-preview').click();
    await page.getByTestId('archive-channel-open-preview').click();
    const confirm = page.getByTestId('archive-channel-confirm-preview');
    // Dispatch both activations in one browser task while the first action is
    // still pending. The menu may close as soon as the authoritative result
    // arrives, so waiting for the first click to settle would no longer test
    // duplicate suppression.
    await confirm.evaluate((element) => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await expect.poll(() => page.evaluate(() => (
      (window as unknown as { __archiveActions: Array<{ room?: string; ref?: string }> }).__archiveActions.length
    ))).toBe(1);
    await expect(page.getByTestId('room-link-preview')).toHaveCount(0);
    await expect(page.locator('[data-testid^="archive-channel-error-"]')).toHaveCount(0);
    expect(await page.evaluate(() => (
      (window as unknown as { __archiveActions: Array<{ room?: string; ref?: string }> }).__archiveActions
    ))).toEqual([{ room: 'preview', ref: expect.any(String) }]);
  });

  // harn:assume archive-pending-result-is-source-owned ref=archive-source-settlement-regression
  test('settles an active archive after the confirmation menu is dismissed', async ({ page }) => {
    await delayArchiveDispatch(page);
    await openRoom(page, 'research');
    await page.getByTestId('room-menu-trigger-research').click();
    await page.getByTestId('archive-channel-open-research').click();
    await page.getByTestId('archive-channel-confirm-research').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('channel-archive-menu-research')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (
      (window as unknown as { __archiveActions: Array<unknown> }).__archiveActions.length
    ))).toBe(1);
    await expect(page.getByTestId('room-link-research')).toHaveCount(0);
    await expect(page.locator('.nx-chat-title h1')).not.toHaveText('Research');
  });
  // harn:end archive-pending-result-is-source-owned

  test('does not expose archive to an unauthorized human', async ({ page }) => {
    await openRoom(page, 'eng', 'next-e2e-viewer-token');
    await expect(page.getByTestId('room-menu-trigger-eng')).toHaveCount(0);
    await expect(page.getByTestId('room-link-eng')).toBeVisible();
  });

  test('refuses archive while the source connection is offline', async ({ page }) => {
    await delayArchiveDispatch(page);
    await openRoom(page, 'ops');
    await page.evaluate(() => (window as unknown as { __codor?: { disconnect(): void } }).__codor?.disconnect());
    const trigger = page.getByTestId('room-menu-trigger-ops');
    await trigger.click();
    await page.getByTestId('archive-channel-open-ops').click();
    await page.getByTestId('archive-channel-confirm-ops').click();
    await expect(page.getByTestId('archive-channel-error-ops')).toContainText('disconnected');
    await expect(page.getByTestId('room-link-ops')).toBeVisible();
    expect(await page.evaluate(() => (
      (window as unknown as { __archiveActions: Array<unknown> }).__archiveActions.length
    ))).toBe(0);

    // A definite local refusal must release the source-owned single-flight
    // guard so reconnecting and explicitly retrying can submit one action.
    await page.evaluate(() => (window as unknown as { __codor?: { reconnect(): void } }).__codor?.reconnect());
    await expect(page.getByTestId('connection')).toHaveText(/Connected/, { timeout: 30_000 });
    await page.getByTestId('room-menu-trigger-ops').click();
    await page.getByTestId('archive-channel-open-ops').click();
    await page.getByTestId('archive-channel-confirm-ops').click();
    await expect.poll(() => page.evaluate(() => (
      (window as unknown as { __archiveActions: Array<unknown> }).__archiveActions.length
    ))).toBe(1);
    await expect(page.getByTestId('room-link-ops')).toHaveCount(0);
  });

  test('keeps the menu inside a phone viewport and passes Axe', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openRoom(page, 'hydration', TOKEN, false);
    await page.getByTestId('mobile-back').click();
    const trigger = page.getByTestId('room-menu-trigger-hydration');
    await trigger.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByTestId('channel-archive-menu-hydration');
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    const report = await new AxeBuilder({ page }).include('[data-testid="channel-archive-menu-hydration"]').analyze();
    expect(report.violations.map((violation) => violation.id)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  });

  // harn:assume hosted-empty-channel-shell-preserves-session-navigation ref=hosted-empty-shell-regression
  test('keeps hosted computer navigation through a last-channel archive and in-place creation', async ({ page }) => {
    test.setTimeout(240_000);
    await control('/relay-up');
    const a = await control<{ code: string; relayUrl: string }>('/relay-pair');
    await prepareHostedPage(page, a.relayUrl);
    await page.goto(`${SPA_ORIGIN}/`);
    await expect(page.getByTestId('landing-page')).toBeVisible();
    await pasteCode(page, a.code);
    await page.getByTestId('pairing-code-submit').click();
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect(page.getByTestId('computer-current')).toHaveAttribute('aria-label', /codor-host-a/);

    await control('/relay-up-b');
    const b = await control<{ code: string }>('/relay-pair-b');
    await page.getByTestId('computer-add').click();
    await pasteCode(page, b.code);
    await page.getByTestId('pairing-code-submit').click();
    await expect(page.getByTestId('computer-current')).toHaveAttribute('aria-label', /codor-host-b/, { timeout: 30_000 });
    await expect(page.getByTestId('room-link-eng')).toBeVisible({ timeout: 30_000 });

    const appOpensBeforeArchive = await page.evaluate(() => (
      (window as unknown as { __codorRelayAppOpens: Array<unknown> }).__codorRelayAppOpens.length
    ));
    await page.getByTestId('room-menu-trigger-eng').click();
    await page.getByTestId('archive-channel-open-eng').click();
    await delayNextHostedWrite(page);
    await page.getByTestId('archive-channel-confirm-eng').click();
    await computerButton(page, 'codor-host-a').click();
    await expect(page.getByTestId('computer-current')).toHaveAttribute('aria-label', /codor-host-a/);
    await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });
    const draft = page.getByTestId('composer-input');
    await draft.fill('keep the other computer draft');
    await expect(draft).toHaveValue('keep the other computer draft');
    await expect.poll(() => page.evaluate(() => (
      (window as unknown as { __hostedDelayedWrites: number }).__hostedDelayedWrites
    ))).toBe(1);
    await computerButton(page, 'codor-host-b').click();
    await expect(page.getByTestId('hosted-empty-shell')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('computer-switcher')).toBeVisible();
    await expect(page.locator('.nx-computer-avatar-list > [role="listitem"]')).toHaveCount(2);
    expect(await page.evaluate(() => (window as unknown as { __codor?: unknown }).__codor)).toBeUndefined();
    expect(await page.evaluate(() => (
      (window as unknown as { __codorRelayAppOpens: Array<unknown> }).__codorRelayAppOpens.length
    ))).toBe(appOpensBeforeArchive);

    // Both paired sessions remain in the same document and the empty B shell
    // can navigate to A and back without inventing an empty-room connector.
    await computerButton(page, 'codor-host-a').click();
    await expect(page.getByTestId('computer-current')).toHaveAttribute('aria-label', /codor-host-a/);
    await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });
    await computerButton(page, 'codor-host-b').click();
    await expect(page.getByTestId('hosted-empty-shell')).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => (window as unknown as { __codor?: unknown }).__codor)).toBeUndefined();

    await page.reload();
    await expect(page.getByTestId('hosted-empty-shell')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('computer-switcher')).toBeVisible();
    await computerButton(page, 'codor-host-a').click();
    await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });
    await computerButton(page, 'codor-host-b').click();
    await expect(page.getByTestId('hosted-empty-shell')).toBeVisible({ timeout: 30_000 });

    // Existing onboarding is completed in place on B. The callback refreshes
    // the same paired entry; it must not navigate or require a new pairing.
    await page.getByTestId('first-channel-name').fill('Recovered B');
    await page.getByTestId('first-folder-alpha-project').click();
    await page.getByTestId('first-channel-create').click();
    await expect(page.getByTestId('room-view')).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/room=recovered-b/);
    await expect(page.getByTestId('room-link-recovered-b')).toBeVisible({ timeout: 30_000 });
  });
  // harn:end hosted-empty-channel-shell-preserves-session-navigation
});
// harn:end channel-archive-ui-captures-source-and-authoritative-result
// harn:end channel-archive-menu-is-viewport-safe-and-accessible
