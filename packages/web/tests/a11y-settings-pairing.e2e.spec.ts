import { expect, test, type Browser, type Page } from '@playwright/test';

import { BASE, CONTROL } from './ports.js';
import { scan } from './a11y-shared.js';

// harn:assume web-theme-accessible-modes ref=axe-settings-pairing-matrix
// harn:assume web-settings-pairing-match-soft-editorial-reference ref=soft-editorial-settings-pairing-axe
type Theme = 'light' | 'dark';
type Viewport = { width: 1440 | 390; height: number };
type SettingsState = {
  name: string;
  reach(
    page: Page,
    room: string,
    browser: Browser,
    theme: Theme,
    viewport: Viewport,
  ): Promise<string[]>;
};

let fixtureSequence = 0;

async function control<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function createRoom(label: string): Promise<string> {
  fixtureSequence += 1;
  const room = `axe-p4-${String(fixtureSequence)}-${label}`;
  const response = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { authorization: 'Bearer e2e-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      id: room,
      name: `Axe ${label}`,
      owner: { handle: 'richard', display_name: 'Richard' },
    }),
  });
  if (!response.ok) throw new Error(`room fixture failed: ${await response.text()}`);
  return room;
}

async function revokeFixtureDevice(deviceId: string): Promise<void> {
  const response = await fetch(`${BASE}/api/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer e2e-token' },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`device cleanup failed: ${await response.text()}`);
  }
}

async function pairFreshDevice(page: Page): Promise<string> {
  const offer = await control<{ url: string }>('/pair-offer');
  await page.goto(offer.url);
  await expect(page.getByTestId('pairing-offer-state')).toBeVisible();
  await page.getByTestId('confirm-pair-browser').click();
  await expect(page.getByTestId('confirm-pair-browser')).toHaveText('Paired');
  return (await page.evaluate(() => window.__codorCrypto.identity())).device_id;
}

async function expectTheme(page: Page, theme: Theme): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  expect(await page.evaluate(() => getComputedStyle(document.body).letterSpacing)).toBe('normal');
}

test('every distinct Settings and Pairing state is axe-clean in both themes at desktop and phone widths', async ({ browser }) => {
  test.setTimeout(240_000);
  const found: string[] = [];
  const viewports: Viewport[] = [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ];

  const settingsStates: readonly SettingsState[] = [
    {
      name: 'appearance',
      reach: async (page: Page, room: string): Promise<string[]> => {
        await page.goto(`/settings?room=${room}&token=e2e-token#appearance`);
        await expect(page).toHaveURL(/#appearance$/);
        await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
        await expect(page.getByTestId('theme-system')).toHaveAttribute('role', 'radio');
        return [];
      },
    },
    {
      name: 'brakes',
      reach: async (page: Page, room: string): Promise<string[]> => {
        await page.goto(`/settings?room=${room}&token=e2e-token#brakes`);
        await expect(page).toHaveURL(/#brakes$/);
        await expect(page.getByRole('heading', { name: 'Channel brakes', exact: true })).toBeVisible();
        await expect(page.getByTestId('turn-brake-enabled')).not.toBeChecked();
        await expect(page.getByTestId('spend-brake-enabled')).not.toBeChecked();
        return [];
      },
    },
    {
      name: 'relay-expanded',
      reach: async (page: Page, room: string): Promise<string[]> => {
        await page.goto(`/settings?room=${room}&token=e2e-token#relay`);
        const toggle = page.getByTestId('open-relay-pairing');
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(page.getByTestId('relay-pairing')).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Relay can see' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Relay never sees' })).toBeVisible();
        return [];
      },
    },
    {
      name: 'devices-offer',
      reach: async (page: Page, room: string): Promise<string[]> => {
        const device = await pairFreshDevice(page);
        await page.goto(`/settings?room=${room}&token=e2e-token#devices`);
        await expect(page.getByTestId(`device-${device}`)).toBeVisible();
        await page.getByTestId('pair-another-device').click();
        await expect(page.getByTestId('pairing-offer')).toBeVisible();
        await expect(page.getByTestId('settings-pairing-qr')).toBeVisible();
        return [device];
      },
    },
    {
      name: 'device-revoke-confirmation',
      reach: async (page: Page, room: string, browserInstance: Browser, theme: Theme, viewport: Viewport): Promise<string[]> => {
        const current = await pairFreshDevice(page);
        const secondContext = await browserInstance.newContext({
          baseURL: BASE,
          viewport,
          colorScheme: theme,
          reducedMotion: 'reduce',
        });
        const second = await secondContext.newPage();
        await second.addInitScript((choice) => localStorage.setItem('codor-theme', choice), theme);
        const other = await pairFreshDevice(second);
        await secondContext.close();

        await page.goto(`/settings?room=${room}&token=e2e-token#devices`);
        await expect(page.getByTestId(`device-${other}`)).toBeVisible();
        await page.getByTestId(`device-action-${other}`).click();
        await expect(page.getByTestId(`confirm-revoke-${other}`)).toBeVisible();
        await expect(page.getByText('Revoke this device?', { exact: true })).toBeVisible();
        return [current, other];
      },
    },
    {
      name: 'privacy',
      reach: async (page: Page, room: string): Promise<string[]> => {
        await page.goto(`/settings?room=${room}&token=e2e-token#privacy`);
        await expect(page).toHaveURL(/#privacy$/);
        await expect(page.getByRole('heading', { name: 'Privacy', exact: true })).toBeVisible();
        await expect(page.getByText('Local plaintext, content-blind relay.')).toBeVisible();
        return [];
      },
    },
    {
      name: 'browser-unpaired',
      reach: async (page: Page, room: string): Promise<string[]> => {
        const device = await pairFreshDevice(page);
        await page.goto(`/settings?room=${room}&token=e2e-token#devices`);
        await page.getByTestId(`device-action-${device}`).click();
        await page.getByTestId('confirm-unpair-browser').click();
        await expect(page.getByTestId('browser-unpaired')).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Browser unpaired' })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Pair again' })).toBeVisible();
        return [];
      },
    },
  ];

  const pairingStates = [
    {
      name: 'manual',
      reach: async (page: Page): Promise<void> => {
        await page.goto('/pair');
        await expect(page.getByTestId('manual-pairing')).toBeVisible();
        await expect(page.getByTestId('pairing-code').locator('input')).toHaveCount(8);
        await expect(page.getByTestId('pairing-link')).toHaveAttribute('type', 'password');
      },
    },
    {
      name: 'qr-offer',
      reach: async (page: Page): Promise<void> => {
        const offer = await control<{ url: string }>('/pair-offer');
        await page.goto(offer.url);
        await expect(page.getByTestId('pairing-offer-state')).toBeVisible();
        await expect(page.getByTestId('pairing-qr')).toBeVisible();
      },
    },
    {
      name: 'validation-error',
      reach: async (page: Page): Promise<void> => {
        await page.goto('/pair');
        await expect(page.getByTestId('manual-pairing')).toBeVisible();
        await page.getByTestId('pairing-code-submit').click();
        await expect(page.getByRole('alert')).toHaveText('Enter the complete 8-character pairing code.');
      },
    },
  ] as const;

  for (const theme of ['light', 'dark'] as const) {
    for (const viewport of viewports) {
      for (const state of settingsStates) {
        const room = await createRoom(`${theme}-${String(viewport.width)}-${state.name}`);
        const context = await browser.newContext({
          baseURL: BASE,
          viewport,
          colorScheme: theme,
          reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        await page.addInitScript((choice) => localStorage.setItem('codor-theme', choice), theme);
        let cleanup: string[] = [];
        try {
          cleanup = await state.reach(page, room, browser, theme, viewport);
          await expectTheme(page, theme);
          for (const violation of await scan(page)) {
            found.push(`${theme}/${String(viewport.width)}/settings:${state.name}: ${violation}`);
          }
        } finally {
          await context.close();
          for (const device of cleanup) await revokeFixtureDevice(device);
        }
      }

      for (const state of pairingStates) {
        const context = await browser.newContext({
          baseURL: BASE,
          viewport,
          colorScheme: theme,
          reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        await page.addInitScript((choice) => localStorage.setItem('codor-theme', choice), theme);
        try {
          await state.reach(page);
          await expectTheme(page, theme);
          for (const violation of await scan(page)) {
            found.push(`${theme}/${String(viewport.width)}/pairing:${state.name}: ${violation}`);
          }
        } finally {
          await context.close();
        }
      }
    }
  }

  expect(found, `axe violations:\n${found.join('\n')}`).toEqual([]);
});
// harn:end web-settings-pairing-match-soft-editorial-reference
// harn:end web-theme-accessible-modes
