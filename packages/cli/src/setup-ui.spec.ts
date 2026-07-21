import { describe, expect, it, vi } from 'vitest';

import {
  CODOR_WORD_ART,
  SETUP_CLEAR_SCREEN,
  SETUP_CURSOR_HIDE,
  createSetupStages,
  renderSetupFrame,
  type SetupFrameState,
  type SetupStage,
} from './setup-ui.js';

const ansi = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const plain = (value: string): string => value.replace(ansi, '');

const state = (overrides: Partial<SetupFrameState> = {}): SetupFrameState => ({
  version: '0.10.0',
  byline: 'created by richhardry',
  steps: createSetupStages(),
  cursor: 0,
  spinnerFrame: 0,
  viewport: { rows: 48, columns: 100 },
  ...overrides,
});

/** Steps 0-1 completed, cursor on step 2, steps 3-4 future. */
const midway = (): SetupStage[] => {
  const steps = createSetupStages();
  steps[0] = { ...steps[0]!, state: 'done', summary: 'linux; codex' };
  steps[1] = { ...steps[1]!, state: 'done', summary: 'token ready' };
  return steps;
};

describe('accordion layout', () => {
  it('collapses completed steps to a summary line and future steps to a title', () => {
    const frame = plain(renderSetupFrame(state({ steps: midway(), cursor: 2 })));
    // Completed: a check mark, the number, the title, and its summary recap.
    expect(frame).toContain('✓');
    expect(frame).toContain('Check this computer');
    expect(frame).toContain('— linux; codex');
    // Active (step 3, "Choose access"): expanded with its number and title.
    expect(frame).toContain('(3) Choose access');
    // Future step 5 collapses to just its numbered title, no status word.
    expect(frame).toContain('(5) Create pairing code');
  });

  it('expands the active step with its logs and control hints', () => {
    const steps = midway();
    steps[2] = { ...steps[2]!, state: 'running', logs: ['probing the daemon'] };
    const frame = plain(renderSetupFrame(state({
      steps, cursor: 2, controls: { back: true, next: false, retry: false, finish: false },
    })));
    expect(frame).toContain('> probing the daemon');
    expect(frame).toContain('working');
    expect(frame).toContain('Back');
  });

  it('renders a failure once, inside the active step, with Retry offered', () => {
    const steps = midway();
    steps[3] = { ...steps[3]!, state: 'failed', error: 'launchctl bootstrap failed' };
    const frame = plain(renderSetupFrame(state({
      steps, cursor: 3, controls: { back: true, next: false, retry: true, finish: false },
    })));
    const occurrences = frame.split('launchctl bootstrap failed').length - 1;
    expect(occurrences).toBe(1);
    expect(frame).toContain('Retry');
  });

  it('offers an explicit Finish action on the completed final step', () => {
    const steps = createSetupStages().map((step) => ({ ...step, state: 'done' as const }));
    const frame = plain(renderSetupFrame(state({
      steps, cursor: 4, controls: { back: true, next: false, retry: false, finish: true },
    })));
    expect(frame).toContain('Enter/→ Finish');
    expect(frame).not.toContain('Enter/→ Next');
  });

  it('renders the choice menu inside the active step', () => {
    const frame = plain(renderSetupFrame(state({
      steps: midway(),
      cursor: 2,
      menu: {
        message: 'Choose how you will reach Codor.',
        focused: 0,
        selected: 'localhost',
        options: [
          { id: 'localhost', label: 'Localhost', description: 'This computer.', available: true },
          { id: 'tailscale', label: 'Tailscale Serve', description: 'Your tailnet.', available: false },
        ],
      },
    })));
    expect(frame).toContain('Choose how you will reach Codor.');
    expect(frame).toContain('Localhost');
    expect(frame).toContain('unavailable');
    expect(frame).toContain('❯');
  });
});

describe('identity, purity and primary-buffer', () => {
  it('renders the word art, version and byline', () => {
    const frame = plain(renderSetupFrame(state()));
    const artRow = CODOR_WORD_ART.split('\n').find((line) => line.includes('█'))!;
    expect(frame).toContain(artRow);
    expect(frame).toContain('v0.10.0 - created by richhardry');
  });

  it('is side-effect free and emits one primary-buffer repaint with no alternate screen', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => { throw new Error('touched stdout'); });
    const timer = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => { throw new Error('started a timer'); });
    expect(() => renderSetupFrame(state())).not.toThrow();
    write.mockRestore();
    timer.mockRestore();
    const frame = renderSetupFrame(state());
    expect(frame.startsWith(SETUP_CLEAR_SCREEN)).toBe(true);
    expect(frame).not.toContain(SETUP_CURSOR_HIDE);
    expect(frame).not.toContain('\u001B[?1049h');
  });

  it('renders the closing summary without claiming browser enrollment', () => {
    const steps = createSetupStages().map((step) => ({ ...step, state: 'done' as const }));
    const frame = plain(renderSetupFrame(state({
      steps,
      cursor: 4,
      summary: { endpoint: 'http://127.0.0.1:8137', harnesses: ['claude', 'codex'], nextAction: 'Enter ABCD-2345.' },
    })));
    expect(frame).toContain('Codor is ready.');
    expect(frame).toContain('ABCD-2345');
    expect(frame).not.toContain('browser paired');
  });
});

describe('constrained viewports keep the active step usable', () => {
  const menu = {
    message: 'Choose how you will reach Codor.',
    focused: 0,
    selected: 'localhost',
    options: [
      { id: 'localhost', label: 'Localhost', description: 'This computer.', available: true },
      { id: 'tailscale', label: 'Tailscale', description: 'Your tailnet.', available: false },
    ],
  };

  it.each([{ rows: 10, columns: 80 }, { rows: 24, columns: 40 }])(
    'never exceeds %o and keeps the active choice content visible',
    (viewport) => {
      const steps = midway();
      steps[2] = { ...steps[2]!, logs: Array.from({ length: 20 }, (_, index) => `line ${String(index)}`) };
      const frame = plain(renderSetupFrame(state({
        steps, cursor: 2, menu, controls: { back: true, next: false, retry: false, finish: false }, viewport,
      })));
      const lines = frame.split('\n').filter(Boolean);
      expect(lines.length).toBeLessThanOrEqual(viewport.rows);
      expect(lines.every((line) => [...line].length <= viewport.columns)).toBe(true);
      expect(frame).toContain('Choose how you will reach Codor.');
      expect(frame).toContain('Localhost');
    },
  );

  it('drops the word art on a short terminal but keeps the active step', () => {
    const short = plain(renderSetupFrame(state({ steps: midway(), cursor: 2, viewport: { rows: 14, columns: 80 } })));
    const artRow = CODOR_WORD_ART.split('\n').find((line) => line.includes('█'))!;
    expect(short).not.toContain(artRow);
    expect(short).toContain('(3) Choose access');
  });
});
