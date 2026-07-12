// @vitest-environment happy-dom
import type { Member } from '@codor/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Composer } from './components.js';
import type { Connection } from './ws.js';

const ULID_RICHARD = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ULID_CODOR = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

const richard: Member = {
  id: ULID_RICHARD,
  kind: 'human',
  handle: 'richard',
  display_name: 'Richard',
  role: 'owner',
  conventions_sent: false,
  misaddressed: false,
  roster_stale: false,
};

const codor: Member = {
  id: ULID_CODOR,
  kind: 'agent',
  handle: 'codor',
  display_name: 'Codor',
  conventions_sent: false,
  misaddressed: false,
  roster_stale: false,
};

const connection = { post: () => undefined } as unknown as Connection;

/** Drives the textarea the way a browser does: set the value, then fire `input`. */
function typeInto(area: HTMLTextAreaElement, value: string, caret = value.length): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setValue?.call(area, value);
    area.setSelectionRange(caret, caret);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('composer caret placement', () => {
  let container: HTMLDivElement;
  let root: Root;
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <Composer
          members={{ [richard.id]: richard, [codor.id]: codor }}
          defaultRecipientId={codor.id}
          selfMemberId={richard.id}
          connection={connection}
        />,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const composer = (): HTMLTextAreaElement =>
    container.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;

  // harn:assume composer-caret-updates-are-synchronous ref=composer-caret-sync-regression
  it('materializes the default mention on the first input', () => {
    typeInto(composer(), 'h');
    expect(composer().value).toBe('@codor h');
  });

  it('places the caret in the same commit, leaving no frame callback pending', () => {
    const area = composer();
    typeInto(area, 'h');

    expect(area.selectionStart).toBe('@codor h'.length);
    // A pending frame callback IS the defect: it fires after the next interaction
    // has begun and rewrites that interaction's selection.
    expect(frames).toHaveLength(0);
  });

  it('does not collapse a select-all performed after the default materialized', () => {
    const area = composer();
    typeInto(area, 'h');

    // What every replace-the-draft interaction does first: select the draft.
    area.setSelectionRange(0, area.value.length);
    act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });

    expect([area.selectionStart, area.selectionEnd]).toEqual([0, '@codor h'.length]);
  });

  it('keeps a replaced draft replaced and does not reinsert the default while typing', () => {
    const area = composer();
    typeInto(area, 'h');
    expect(area.value).toBe('@codor h');

    // The operator selects the materialized draft and replaces it with their own.
    area.setSelectionRange(0, area.value.length);
    act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });
    typeInto(area, 'h');
    expect(area.value).toBe('h');

    for (const [index, character] of [...'ello'].entries()) {
      typeInto(area, `h${'ello'.slice(0, index + 1)}`);
      expect(character).toBeTruthy();
    }

    expect(area.value).toBe('hello');
  });

  it('re-arms the default only after the draft is emptied', () => {
    const area = composer();
    typeInto(area, 'h');
    expect(area.value).toBe('@codor h');

    typeInto(area, '');
    typeInto(area, 'n');
    expect(area.value).toBe('@codor n');
  });
  // harn:end composer-caret-updates-are-synchronous
});
