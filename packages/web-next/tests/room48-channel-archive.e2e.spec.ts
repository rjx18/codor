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
// harn:assume archive-terminal-results-release-source-admission ref=archive-terminal-results-regression
test.describe('channel archive context menu', () => {
  type HostedArchiveOperation = {
    computer: string;
    room: string;
    ref: string;
    phase: 'admitted' | 'dispatched';
  };
  type CrossComputerFixture = {
    aTarget: string;
    aRemaining: string;
    bTarget: string;
    bRemaining: string;
  };

  async function openCrossComputerFixture(page: Page, suffix: string, targetExisting = false): Promise<CrossComputerFixture> {
    await control('/relay-up');
    await control('/relay-up-b');
    const fixture = await control<CrossComputerFixture>('/archive-cross-computer-fixture', { suffix, targetExisting });
    const a = await control<{ code: string; relayUrl: string }>('/relay-pair');
    await prepareHostedPage(page, a.relayUrl);
    await page.goto(`${SPA_ORIGIN}/`);
    await expect(page.getByTestId('landing-page')).toBeVisible();
    await pasteCode(page, a.code);
    await page.getByTestId('pairing-code-submit').click();
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect(page.getByTestId('computer-current')).toHaveAttribute('aria-label', /codor-host-a/);

    const b = await control<{ code: string }>('/relay-pair-b');
    await page.getByTestId('computer-add').click();
    await pasteCode(page, b.code);
    await page.getByTestId('pairing-code-submit').click();
    await expect(page.getByTestId('computer-current')).toHaveAttribute('aria-label', /codor-host-b/, { timeout: 30_000 });
    await expect(page.getByTestId(`room-link-${fixture.bTarget}`)).toBeVisible({ timeout: 30_000 });
    return fixture;
  }

  async function instrumentHostedArchive(page: Page, computer: string, room: string, delayMs = 0): Promise<void> {
    await page.evaluate(({ source, targetRoom, delay }) => {
      const runtime = window as unknown as {
        __codor?: {
          actForRoom?: (room: string, act: unknown, ref?: string) => boolean;
        };
        __archiveOperations?: HostedArchiveOperation[];
      };
      const connector = runtime.__codor;
      const actForRoom = connector?.actForRoom;
      if (actForRoom === undefined) throw new Error('active hosted connector cannot be instrumented');
      const native = actForRoom.bind(connector);
      runtime.__archiveOperations ??= [];
      connector.actForRoom = (target, act, ref) => {
        const isArchive = typeof act === 'object' && act !== null
          && (act as { act?: unknown }).act === 'archive_room';
        if (target === targetRoom && isArchive) {
          const operation: HostedArchiveOperation = {
            computer: source,
            room: target,
            ref: String(ref ?? ''),
            phase: 'admitted',
          };
          runtime.__archiveOperations!.push(operation);
          if (delay > 0) {
            window.setTimeout(() => {
              operation.phase = 'dispatched';
              native(target, act, ref);
            }, delay);
            return true;
          }
          operation.phase = 'dispatched';
        }
        return native(target, act, ref);
      };
    }, { source: computer, targetRoom: room, delay: delayMs });
  }

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
    const trigger = page.getByTestId('room-menu-trigger-ops');
    await trigger.click();
    await page.getByTestId('archive-channel-open-ops').click();
    await page.evaluate(() => (window as unknown as { __codor?: { disconnect(): void } }).__codor?.disconnect());
    const confirm = page.getByTestId('archive-channel-confirm-ops');
    await expect(trigger).toBeDisabled();
    await expect(confirm).toBeDisabled();
    // Bypass only P3's DOM guard to retain the independent action-refusal proof.
    await confirm.evaluate((button) => { (button as HTMLButtonElement).disabled = false; (button as HTMLButtonElement).click(); });
    await expect(page.getByTestId('archive-channel-error-ops')).toContainText('disconnected');
    await expect(page.getByTestId('room-link-ops')).toBeVisible();
    expect(await page.evaluate(() => (
      (window as unknown as { __archiveActions: Array<unknown> }).__archiveActions.length
    ))).toBe(0);
    await page.keyboard.press('Escape');

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

  // These source-owned fixture rooms are intentionally created after the
  // last-channel case: the harness daemon is shared for the file, and the
  // last-channel proof must observe B with only its seeded eng room.
  test('releases a settled background archive before another computer acts', async ({ page }) => {
    test.setTimeout(240_000);
    const fixture = await openCrossComputerFixture(page, `success-${Date.now()}`);
    await page.getByTestId(`room-link-${fixture.bTarget}`).click();
    await expect(page).toHaveURL(new RegExp(`room=${fixture.bTarget}`));
    await instrumentHostedArchive(page, 'B', fixture.bTarget, 800);
    await confirmArchive(page, fixture.bTarget);

    // Change source before the delayed B operation settles. The fixture state
    // is the authoritative boundary; no source rail revisit is used here.
    await computerButton(page, 'codor-host-a').click();
    await expect(page.getByTestId('computer-current')).toHaveAttribute('aria-label', /codor-host-a/);
    await expect.poll(() => page.evaluate(() => (
      (window as unknown as { __archiveOperations: HostedArchiveOperation[] }).__archiveOperations
        .find((operation) => operation.computer === 'B')?.phase
    ))).toBe('dispatched');
    await expect.poll(async () => (await control<{ archived_ts: string | null }>('/archive-b-room-state', {
      room: fixture.bTarget,
    })).archived_ts).not.toBeNull();

    // B is not revisited between operations. A's action must be admitted and
    // settled even though B's terminal success is still source-owned.
    await instrumentHostedArchive(page, 'A', fixture.aTarget);
    await confirmArchive(page, fixture.aTarget);
    await expect.poll(() => page.evaluate(() => (
      (window as unknown as { __archiveOperations: HostedArchiveOperation[] }).__archiveOperations
        .filter((operation) => operation.computer === 'A' && operation.room !== undefined)
        .filter((operation) => operation.phase === 'dispatched').length
    ))).toBe(1);
    await expect(page.getByTestId(`room-link-${fixture.aTarget}`)).toHaveCount(0);
    expect(await page.evaluate(() => (
      (window as unknown as { __archiveOperations: HostedArchiveOperation[] }).__archiveOperations
        .map((operation) => ({ computer: operation.computer, room: operation.room, ref: operation.ref }))
    ))).toEqual([
      { computer: 'B', room: fixture.bTarget, ref: expect.any(String) },
      { computer: 'A', room: fixture.aTarget, ref: expect.any(String) },
    ]);

    // The successful inactive source retained its fallback root for later
    // activation; this also proves source reconciliation was not discarded.
    await computerButton(page, 'codor-host-b').click();
    await expect(page.getByTestId('computer-current')).toHaveAttribute('aria-label', /codor-host-b/);
    await expect(page).not.toHaveURL(new RegExp(`room=${fixture.bTarget}`));
    await expect(page).not.toHaveURL(/room=undefined/);
    await expect(page.getByTestId(`room-link-${fixture.bRemaining}`)).toBeVisible();
    await expect(page.getByTestId(`room-link-${fixture.bTarget}`)).toHaveCount(0);
  });

  test('keeps an inactive source refusal visible while a second source archives', async ({ page }) => {
    test.setTimeout(240_000);
    const fixture = await openCrossComputerFixture(page, `refusal-${Date.now()}`);
    await page.getByTestId(`room-link-${fixture.bTarget}`).click();
    await instrumentHostedArchive(page, 'B', fixture.bTarget, 800);
    await confirmArchive(page, fixture.bTarget);
    await computerButton(page, 'codor-host-a').click();
    await expect(page.getByTestId('computer-current')).toHaveAttribute('aria-label', /codor-host-a/);

    // The captured B target was authorized when confirmed. Demote it before
    // the delayed send so the real correlated server refusal is deterministic.
    await control('/archive-b-demote-owner', { room: fixture.bTarget });
    await expect.poll(() => page.evaluate(() => (
      (window as unknown as { __archiveOperations: HostedArchiveOperation[] }).__archiveOperations
        .find((operation) => operation.computer === 'B')?.phase
    ))).toBe('dispatched');

    // A remains independently actionable while B's refusal is still in flight.
    await instrumentHostedArchive(page, 'A', fixture.aTarget);
    await confirmArchive(page, fixture.aTarget);
    await expect.poll(() => page.evaluate(() => (
      (window as unknown as { __archiveOperations: HostedArchiveOperation[] }).__archiveOperations
        .filter((operation) => operation.computer === 'A' && operation.phase === 'dispatched').length
    ))).toBe(1);
    await expect(page.getByTestId(`room-link-${fixture.aTarget}`)).toHaveCount(0);

    // Only now revisit B; the source-owned refusal must remain observable and
    // retryable, rather than being replaced by A's success.
    await computerButton(page, 'codor-host-b').click();
    await expect(page.getByTestId('computer-current')).toHaveAttribute('aria-label', /codor-host-b/);
    await expect(page.getByTestId(`archive-channel-error-${fixture.bTarget}`)).toContainText(/forbidden|owner|archive/i, {
      timeout: 30_000,
    });
    await expect(page.getByTestId(`room-link-${fixture.bTarget}`)).toBeVisible();
    expect(await page.evaluate(() => (
      (window as unknown as { __archiveOperations: HostedArchiveOperation[] }).__archiveOperations
        .map((operation) => operation.computer)
    ))).toEqual(['B', 'A']);
  });
});
// harn:end archive-terminal-results-release-source-admission
// harn:end channel-archive-ui-captures-source-and-authoritative-result
// harn:end channel-archive-menu-is-viewport-safe-and-accessible
