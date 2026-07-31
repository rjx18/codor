import { expect, test, type Page } from '@playwright/test';

const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
const SPA_ORIGIN = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_SPA_PORT ?? '28139'}`;

async function control<T = unknown>(path: string): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error(`control ${path} failed: ${response.status}`);
  return (await response.json()) as T;
}

async function pasteCode(page: Page, code: string): Promise<void> {
  await page.getByTestId('pairing-code-0').evaluate((element, pasted) => {
    const data = new DataTransfer();
    data.setData('text/plain', pasted);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, code);
}

test.describe('startup recovery (boot path)', () => {
  test('a paired relay browser booting against a down host shows the recovery card, not landing', async ({ page }) => {
    test.setTimeout(120_000);
    await control('/relay-up');
    const { code, relayUrl } = await control<{ code: string; relayUrl: string }>('/relay-pair');
    await page.addInitScript((url) => {
      const w = window as unknown as Record<string, unknown>;
      w.__CODOR_RELAY_URL = url;
      w.__CODOR_RECOVERY_GRACE_MS = 300;
      w.__CODOR_RECOVERY_EXTENDED_MS = 1_500;
    }, relayUrl);
    await page.goto(`${SPA_ORIGIN}/`);
    await expect(page.getByTestId('landing-page')).toBeVisible();
    await pasteCode(page, code);
    await page.getByTestId('pairing-code-submit').click();
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });

    // Host drops, then reload: the boot must reach its channels through a dead tunnel,
    // fail, and show the SAME recovery card (fullscreen) — never the "never paired"
    // landing, never the terse old StartupUnavailable.
    await control('/relay-down');
    await page.reload();

    await expect(page.getByTestId('recovery')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('landing-page')).toHaveCount(0);
    await expect(page.getByTestId('recovery-repair')).toBeVisible();
    // Re-pair drops to code entry.
    await page.getByTestId('recovery-repair').click();
    await expect(page.getByTestId('pairing-code-0')).toBeVisible({ timeout: 15_000 });
  });

  test('the boot recovery card retries successfully once the host returns', async ({ page }) => {
    test.setTimeout(120_000);
    await control('/relay-up');
    const { code, relayUrl } = await control<{ code: string; relayUrl: string }>('/relay-pair');
    await page.addInitScript((url) => {
      const w = window as unknown as Record<string, unknown>;
      w.__CODOR_RELAY_URL = url;
      w.__CODOR_RECOVERY_GRACE_MS = 300;
      w.__CODOR_RECOVERY_EXTENDED_MS = 1_500;
    }, relayUrl);
    await page.goto(`${SPA_ORIGIN}/`);
    await expect(page.getByTestId('landing-page')).toBeVisible();
    await pasteCode(page, code);
    await page.getByTestId('pairing-code-submit').click();
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });

    // Boot against a down host → recovery card.
    await control('/relay-down');
    await page.reload();
    await expect(page.getByTestId('recovery')).toBeVisible({ timeout: 30_000 });

    // The agent comes back; "Retry now" reloads into a healthy boot that reaches the
    // channel and goes live — the honest offline screen has a working way out.
    await control('/relay-up');
    await page.getByTestId('recovery-retry').click();
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
  });

  test('pairing falls back to the alias when the primary relay URL is blocked (P7)', async ({ page }) => {
    test.setTimeout(120_000);
    await control('/relay-up');
    const { code, relayUrl } = await control<{ code: string; relayUrl: string }>('/relay-pair');
    await page.addInitScript((url) => {
      const w = window as unknown as Record<string, unknown>;
      w.__CODOR_RELAY_URL = 'ws://127.0.0.1:9'; // blocked primary: nothing listens there
      w.__CODOR_RELAY_ALIAS = url; // the alias member passes
    }, relayUrl);
    await page.goto(`${SPA_ORIGIN}/`);
    await expect(page.getByTestId('landing-page')).toBeVisible();
    await pasteCode(page, code);
    await page.getByTestId('pairing-code-submit').click();
    // The claim dies instantly on the dead primary, retries through the alias,
    // and the recorded dial_url winner carries the SESSION too — fully live,
    // across the post-pairing reload.
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
  });

  test('a genuinely-unpaired browser still gets the landing page, never the recovery card', async ({ page }) => {
    test.setTimeout(60_000);
    // Relay is CONFIGURED (hosted origin) but this browser has NEVER paired — no relay
    // record, so relayActive() is false. The item-4 edit (kill silent fall-to-landing)
    // must NOT turn a genuinely-unpaired browser into a recovery card: it still lands.
    await control('/relay-up');
    const { relayUrl } = await control<{ relayUrl: string }>('/relay-pair');
    await page.addInitScript((url) => {
      (window as unknown as { __CODOR_RELAY_URL?: string }).__CODOR_RELAY_URL = url;
    }, relayUrl);
    await page.goto(`${SPA_ORIGIN}/`);
    await expect(page.getByTestId('landing-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('recovery')).toHaveCount(0);
  });

  test('a device-offline boot card reloads itself when connectivity returns', async ({ page }) => {
    test.setTimeout(120_000);
    await control('/relay-up');
    const { code, relayUrl } = await control<{ code: string; relayUrl: string }>('/relay-pair');
    await page.addInitScript((url) => {
      const w = window as unknown as Record<string, unknown>;
      w.__CODOR_RELAY_URL = url;
      w.__CODOR_RECOVERY_GRACE_MS = 300;
      w.__CODOR_RECOVERY_EXTENDED_MS = 1_500;
      // Drive navigator.onLine from a sessionStorage flag (real network stays up; we
      // only spoof the classifier input) so the card's reload can land ONLINE, not loop.
      Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        get: () => sessionStorage.getItem('__offline') !== '1',
      });
    }, relayUrl);
    await page.goto(`${SPA_ORIGIN}/`);
    await expect(page.getByTestId('landing-page')).toBeVisible();
    await pasteCode(page, code);
    await page.getByTestId('pairing-code-submit').click();
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });

    // Boot device-offline: spoof onLine false AND drop the host, then reload → the boot
    // fails and classifies device-offline (the device's own network wins over agent-absent).
    await control('/relay-down');
    await page.evaluate(() => sessionStorage.setItem('__offline', '1'));
    await page.reload();
    await expect(page.getByTestId('recovery')).toHaveAttribute('data-recovery-state', 'device-offline', { timeout: 30_000 });

    // Connectivity returns. Plant a window sentinel a real navigation clears, then clear
    // the offline flag, bring the host back, and fire a REAL `online` event (not a
    // direct reload call). The card's own listener must catch it and reload: the boot
    // then goes live AND the sentinel is gone — proving the real event → listener →
    // reload → healthy-boot chain, not a flag check. (The spoof fakes only
    // navigator.onLine; the network was up throughout — a true offline can't even load
    // the SW-less harness, so the device-offline BOOT card would be unreachable.)
    await control('/relay-up');
    await page.evaluate(() => { (window as unknown as { __preReload?: boolean }).__preReload = true; });
    await page.evaluate(() => {
      sessionStorage.setItem('__offline', '0');
      window.dispatchEvent(new Event('online'));
    });
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    expect(await page.evaluate(() => (window as unknown as { __preReload?: boolean }).__preReload)).toBeUndefined();
  });
});
