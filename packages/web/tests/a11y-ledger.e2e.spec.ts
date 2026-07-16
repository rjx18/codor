import { expect, test, type Page } from '@playwright/test';

import { BASE, ROOM, control, scan } from './a11y-shared.js';

// harn:assume web-theme-accessible-modes ref=axe-ledger-matrix
// harn:assume graph-derived-from-vault-links-readonly-v5 ref=soft-editorial-ledger-axe
type Theme = 'light' | 'dark';
type LedgerState = {
  name: string;
  viewport: { width: number; height: number };
  reach(page: Page, sequence: number): Promise<void>;
};

async function expectTheme(page: Page, theme: Theme): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

test('every distinct Ledger graph and note-viewer state is axe-clean in both themes', async ({ browser }) => {
  test.setTimeout(180_000);
  const found: string[] = [];
  let sequence = 0;

  const states: readonly LedgerState[] = [
    {
      name: '1440:docked-inspector',
      viewport: { width: 1440, height: 900 },
      reach: async (page): Promise<void> => {
        await control('/ledger-graph-init');
        await page.goto('/ledger?room=eng&token=e2e-token');
        await expect(page.getByTestId('ledger-inspector')).toHaveAttribute('role', 'complementary');
        await expect(page.getByTestId('ledger-node-launch-plan')).toHaveAttribute('aria-describedby', 'ledger-type-decision');
      },
    },
    {
      name: '1024:graph',
      viewport: { width: 1024, height: 820 },
      reach: async (page): Promise<void> => {
        await control('/ledger-graph-init');
        await page.goto('/ledger?room=eng&token=e2e-token');
        await expect(page.getByTestId('ledger-inspector')).toBeHidden();
        await expect(page.getByTestId('ledger-graph-surface')).toBeVisible();
      },
    },
    {
      name: '1024:side-inspector',
      viewport: { width: 1024, height: 820 },
      reach: async (page): Promise<void> => {
        await control('/ledger-graph-init');
        await page.goto('/ledger?room=eng&token=e2e-token');
        await page.getByTestId('ledger-node-risk-limits').click();
        await expect(page.getByRole('dialog', { name: 'Selected ledger note' })).toBeVisible();
      },
    },
    {
      name: '390:graph',
      viewport: { width: 390, height: 844 },
      reach: async (page): Promise<void> => {
        await control('/ledger-graph-init');
        await page.goto('/ledger?room=eng&token=e2e-token');
        await expect(page.getByTestId('ledger-inspector')).toBeHidden();
        await expect(page.getByTestId('ledger-controls-toggle')).toBeVisible();
      },
    },
    {
      name: '390:graph-controls',
      viewport: { width: 390, height: 844 },
      reach: async (page): Promise<void> => {
        await control('/ledger-graph-init');
        await page.goto('/ledger?room=eng&token=e2e-token');
        await page.getByTestId('ledger-controls-toggle').click();
        await expect(page.getByTestId('ledger-phone-controls')).toBeVisible();
      },
    },
    {
      name: '390:bottom-sheet',
      viewport: { width: 390, height: 844 },
      reach: async (page): Promise<void> => {
        await control('/ledger-graph-init');
        await page.goto('/ledger?room=eng&token=e2e-token');
        await page.getByTestId('ledger-node-launch-plan').click();
        const inspector = page.getByRole('dialog', { name: 'Selected ledger note' });
        await expect(inspector).toBeVisible();
        const box = (await inspector.boundingBox())!;
        expect(box.x).toBe(0);
        expect(box.width).toBe(390);
      },
    },
    {
      name: '390:room-note-dialog',
      viewport: { width: 390, height: 844 },
      reach: async (page, stateSequence): Promise<void> => {
        const name = `axe-ledger-note-${String(stateSequence)}`;
        await page.goto(ROOM);
        await expect(page.getByTestId('connection')).toHaveAttribute('title', 'connected');
        await control('/ledger-direct', { name, noteBody: 'Read-only note body for axe.' });
        const notice = page.getByText(`@operator updated [[${name}]]`);
        await expect(notice).toBeVisible();
        await notice.getByTestId(`ledger-ref-${name}`).click();
        await expect(page.getByTestId('ledger-note-dialog')).toBeVisible();
      },
    },
  ];

  for (const theme of ['light', 'dark'] as const) {
    for (const state of states) {
      sequence += 1;
      const context = await browser.newContext({
        baseURL: BASE,
        viewport: state.viewport,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      await page.addInitScript((choice) => localStorage.setItem('codor-theme', choice), theme);
      try {
        await state.reach(page, sequence);
        await expectTheme(page, theme);
        for (const violation of await scan(page)) found.push(`${theme}/${state.name}: ${violation}`);
      } finally {
        await context.close();
      }
    }
  }

  expect(found, `axe violations:\n${found.join('\n')}`).toEqual([]);
});
// harn:end graph-derived-from-vault-links-readonly-v5
// harn:end web-theme-accessible-modes
