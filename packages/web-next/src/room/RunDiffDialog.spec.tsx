// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunDiffDialog, mergeStoredDiffs } from './RunDiffDialog.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const APP = {
  path: 'src/app.ts',
  unified: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new',
};
const README = {
  path: 'docs/guide.md',
  unified: '--- a/docs/guide.md\n+++ b/docs/guide.md\n@@ -0,0 +1 @@\n+hello',
};

describe('stored run diff dialog', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.body.replaceChildren();
  });

  // harn:assume normalized-run-evidence-dialogs ref=historical-diff-dialog-regression
  it('navigates immutable files and closes by action or Escape', async () => {
    const close = vi.fn();
    await act(async () => root.render(
      <RunDiffDialog diffs={[APP, README]} initialPath={APP.path} onClose={close} />,
    ));

    const dialog = document.querySelector<HTMLElement>('[data-testid="historical-diff-dialog"]')!;
    expect(dialog.textContent).toContain('Saved with this run');
    expect(dialog.querySelector('[data-testid="diff-view"]')?.textContent).toContain('+new');

    const guide = [...dialog.querySelectorAll<HTMLButtonElement>('.nx-run-diff-file')]
      .find((button) => button.textContent?.includes('guide.md'))!;
    await act(async () => guide.click());
    expect(dialog.querySelector('[data-testid="diff-view"]')?.textContent).toContain('+hello');
    expect(guide.getAttribute('aria-current')).toBe('true');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(close).toHaveBeenCalledTimes(1);
    dialog.querySelector<HTMLButtonElement>('[aria-label="Close stored diff"]')!.click();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('states honestly when no patch evidence was stored', async () => {
    await act(async () => root.render(
      <RunDiffDialog diffs={[]} onClose={() => undefined} />,
    ));
    expect(document.querySelector('[data-testid="stored-diff-empty"]')?.textContent)
      .toContain('No stored diff evidence');

    await act(async () => root.render(
      <RunDiffDialog diffs={[{ path: 'empty.txt', unified: '' }]} onClose={() => undefined} />,
    ));
    expect(document.querySelector('[data-testid="stored-diff-patch-empty"]')?.textContent)
      .toContain('empty.txt');
  });
  // harn:end normalized-run-evidence-dialogs

  it('merges repeated patches per path without changing event order', () => {
    expect(mergeStoredDiffs([APP, README, { path: APP.path, unified: '@@ -2 +2 @@\n-x\n+y' }]))
      .toEqual([
        { path: APP.path, unified: `${APP.unified}\n@@ -2 +2 @@\n-x\n+y` },
        README,
      ]);
  });
});
