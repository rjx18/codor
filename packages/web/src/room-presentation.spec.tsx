// @vitest-environment happy-dom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { useRoomPresentation, useViewportWidth } from './room-presentation.js';
import type { PresentationMode, Surface } from './v5/presentation.js';

// harn:assume web-room-visual-hierarchy-matches-soft-editorial-reference ref=soft-editorial-responsive-adoption
const actEnv = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let priorActEnv: boolean | undefined;
beforeAll(() => {
  priorActEnv = actEnv.IS_REACT_ACT_ENVIRONMENT;
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = priorActEnv;
});

function setWidth(width: number): void {
  (window as unknown as { innerWidth: number }).innerWidth = width;
  window.dispatchEvent(new Event('resize'));
}

/** Render a surface's live presentation mode into a probe, returning read + cleanup handles. */
function mountSurface(surface: Surface): { read: () => PresentationMode; cleanup: () => void } {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  function Probe(): JSX.Element {
    return <span data-testid="mode">{useRoomPresentation(surface)}</span>;
  }
  act(() => root.render(<Probe />));
  return {
    read: () => container.querySelector('[data-testid="mode"]')!.textContent as PresentationMode,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('live room presentation adoption', () => {
  it('resolves an adopted message framed on desktop and unframed on a phone', () => {
    setWidth(1440);
    const desktop = mountSurface('message');
    expect(desktop.read()).toBe('framed-desktop');
    desktop.cleanup();

    setWidth(390);
    const phone = mountSurface('message');
    expect(phone.read()).toBe('unframed-mobile');
    phone.cleanup();
  });

  it('reframes live when the width crosses 720, at 719 then 720', () => {
    setWidth(719);
    const surface = mountSurface('run');
    expect(surface.read()).toBe('unframed-mobile');
    act(() => setWidth(720));
    expect(surface.read()).toBe('framed-desktop');
    act(() => setWidth(719));
    expect(surface.read()).toBe('unframed-mobile');
    surface.cleanup();
  });

  it('keeps the framed-only surfaces framed at every width', () => {
    for (const surface of ['ask', 'hold', 'composer', 'member', 'channel-row'] as const) {
      setWidth(390);
      const probe = mountSurface(surface);
      expect(probe.read(), `${surface} at 390`).toBe('framed-desktop');
      probe.cleanup();
    }
  });

  it('removes its resize listener on unmount, so a later resize updates nothing and leaks nothing', () => {
    let renders = 0;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    function Probe(): JSX.Element {
      const width = useViewportWidth();
      useEffect(() => {
        renders += 1;
      });
      return <span>{width}</span>;
    }
    setWidth(1000);
    act(() => root.render(<Probe />));
    const rendersAtMount = renders;
    act(() => root.unmount());
    // After unmount the subscription is gone: dispatching resize must not re-render the tree.
    setWidth(1200);
    expect(renders).toBe(rendersAtMount);
    container.remove();
  });
});
// harn:end web-room-visual-hierarchy-matches-soft-editorial-reference
