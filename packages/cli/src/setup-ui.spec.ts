import { describe, expect, it, vi } from 'vitest';

import {
  CODOR_WORD_ART,
  SETUP_CLEAR_SCREEN,
  SETUP_CURSOR_HIDE,
  createSetupStages,
  renderSetupFrame,
  type SetupControls,
  type SetupFrameState,
  type SetupStage,
} from './setup-ui.js';

const ansi = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const plain = (value: string): string => value.replace(ansi, '');

const controls = (overrides: Partial<SetupControls> = {}): SetupControls => ({
  back: false, forward: false, retry: false, finish: false, ...overrides,
});

const state = (overrides: Partial<SetupFrameState> = {}): SetupFrameState => ({
  version: '0.10.0',
  byline: 'created by richhardry',
  steps: createSetupStages(),
  cursor: 0,
  spinnerFrame: 0,
  viewport: { rows: 64, columns: 100 },
  ...overrides,
});

/** Steps 0-1 completed with full result logs, cursor on step 2. */
const midway = (): SetupStage[] => {
  const steps = createSetupStages();
  steps[0] = { ...steps[0]!, state: 'done', logs: ['darwin with Node 25.5.0', 'found claude, codex, agy', 'Tailscale detected'] };
  steps[1] = { ...steps[1]!, state: 'done', logs: ['private configuration and data are ready'] };
  return steps;
};

const accessMenu = {
  message: 'How will you reach Codor?',
  focused: 0,
  canBack: true,
  options: [
    { id: 'localhost', label: 'Localhost', description: 'This computer only.', available: true },
    { id: 'tailscale', label: 'Tailscale Serve', description: 'This Tailscale CLI does not support Serve.', available: false },
  ],
};

describe('progressive layout keeps completed results visible', () => {
  it('shows every completed result line rather than a collapsed one-line summary', () => {
    const frame = plain(renderSetupFrame(state({ steps: midway(), cursor: 2 })));
    // All three result lines of step 1 stay on screen, each on its own row.
    expect(frame).toContain('darwin with Node 25.5.0');
    expect(frame).toContain('found claude, codex, agy');
    expect(frame).toContain('Tailscale detected');
    // Step 2's single result line is also fully present.
    expect(frame).toContain('private configuration and data are ready');
    // Active step 3 (Choose access) is expanded with its number and title.
    expect(frame).toContain('(3) Where you will use Codor');
    // Future step 5 collapses to just its numbered title.
    expect(frame).toContain('(5) Create pairing code');
  });

  it('renders completed result text in a prominent, non-dim foreground', () => {
    const raw = renderSetupFrame(state({ steps: midway(), cursor: 2 }));
    // The result text is not wrapped in the dim SGR; only its leading marker is.
    expect(raw).not.toContain('\u001B[2mdarwin with Node');
    expect(raw).toContain('darwin with Node 25.5.0');
  });

  it('marks each completed step with a bold title and a green check', () => {
    const raw = renderSetupFrame(state({ steps: midway(), cursor: 2 }));
    expect(raw).toContain('\u001B[32m✓\u001B[0m');
    expect(raw).toContain('\u001B[1mCheck this computer\u001B[0m');
  });

  it('separates steps with blank-line spacing', () => {
    const frame = plain(renderSetupFrame(state({ steps: midway(), cursor: 2 })));
    // A blank line follows the last result line of a completed step.
    expect(frame).toContain('found claude, codex, agy\n');
    expect(frame).toMatch(/Tailscale detected\n\n/);
  });
});

describe('active step controls only when input is required', () => {
  it('shows no navigation control while an automatic step is running', () => {
    const steps = midway();
    steps[2] = { ...steps[2]!, state: 'running', logs: ['probing the daemon'] };
    const frame = plain(renderSetupFrame(state({ steps, cursor: 2 })));
    expect(frame).toContain('> probing the daemon');
    expect(frame).toContain('working');
    expect(frame).not.toContain('Back');
    expect(frame).not.toContain('Next');
  });

  it('renders a muted description directly under the active heading', () => {
    const steps = midway();
    steps[2] = { ...steps[2]!, description: 'Decide how you will reach Codor.' };
    const raw = renderSetupFrame(state({ steps, cursor: 2 }));
    expect(plain(raw)).toContain('Decide how you will reach Codor.');
    // The description is muted (dim), not the accent color.
    expect(raw).toContain('\u001B[2mDecide how you will reach Codor.\u001B[0m');
    expect(raw).not.toContain('\u001B[36mDecide how you will reach Codor');
  });

  it('renders a failure once inside the active step with Retry offered', () => {
    const steps = midway();
    steps[3] = { ...steps[3]!, state: 'failed', error: 'launchctl bootstrap failed' };
    const frame = plain(renderSetupFrame(state({
      steps, cursor: 3, controls: controls({ back: true, retry: true }),
    })));
    expect(frame.split('launchctl bootstrap failed').length - 1).toBe(1);
    expect(frame).toContain('r Retry');
  });

  it('offers an explicit Finish action on the completed final step', () => {
    const steps = createSetupStages().map((step) => ({ ...step, state: 'done' as const }));
    const frame = plain(renderSetupFrame(state({
      steps, cursor: 4, controls: controls({ back: true, finish: true }),
    })));
    expect(frame).toContain('Enter Finish');
    expect(frame).not.toContain('→ Next');
  });
});

describe('vertical choice menus', () => {
  it('stacks the prompt, options, and hint with an unmistakable focused option', () => {
    const raw = renderSetupFrame(state({
      steps: midway(), cursor: 2, menu: { ...accessMenu, focused: 0 }, controls: controls({ back: true }),
    }));
    const frame = plain(raw);
    expect(frame).toContain('How will you reach Codor?');
    // The question uses the accent color (cyan), matching the focused option.
    expect(raw).toContain('\u001B[36m\u001B[1mHow will you reach Codor?');
    // Options are vertical, the focused one carries the pointer.
    expect(frame).toContain('❯ Localhost');
    expect(frame).toContain('Tailscale Serve');
    expect(frame).toContain('(unavailable)');
    // The navigation hint stacks below, not crowded inline with the options.
    expect(frame).toContain('↑/↓ Move');
    expect(frame).toContain('Enter Select');
    expect(frame).toContain('← Back');
  });

  it('moves the pointer to the focused option', () => {
    const frame = plain(renderSetupFrame(state({
      steps: midway(), cursor: 2, menu: { ...accessMenu, focused: 1 }, controls: controls({ back: true }),
    })));
    expect(frame).toContain('❯ Tailscale Serve');
    expect(frame).not.toContain('❯ Localhost');
  });

  it('pads the choice block with blank lines above the prompt and around the hint', () => {
    const frame = plain(renderSetupFrame(state({
      steps: midway(), cursor: 3, menu: {
        message: 'Run Codor in the background?',
        focused: 0,
        canBack: true,
        options: [
          { id: 'start', label: 'Start Codor', description: '', available: true },
          { id: 'later', label: 'Not now', description: '', available: true },
        ],
      },
    })));
    expect(frame).toMatch(/\n\n {4}Run Codor in the background\?\n\n/);
    expect(frame).toContain('❯ Start Codor');
    expect(frame).toContain('Not now');
  });
});

describe('identity, purity and primary-buffer', () => {
  it('renders the replacement word art, version and byline', () => {
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

  it('renders a ready summary with the endpoint and pairing action', () => {
    const steps = createSetupStages().map((step) => ({ ...step, state: 'done' as const }));
    const frame = plain(renderSetupFrame(state({
      steps,
      cursor: 4,
      summary: { headline: 'Codor is ready.', endpoint: 'http://127.0.0.1:8137', harnesses: ['claude', 'codex'], nextAction: 'Enter ABCD-2345.' },
    })));
    expect(frame).toContain('Codor is ready.');
    expect(frame).toContain('Open http://127.0.0.1:8137');
    expect(frame).toContain('ABCD-2345');
    expect(frame).not.toContain('browser paired');
  });

  it('renders a paused summary that omits the endpoint when the service was declined', () => {
    const steps = createSetupStages();
    steps[0] = { ...steps[0]!, state: 'done' };
    steps[3] = { ...steps[3]!, state: 'skipped' };
    steps[4] = { ...steps[4]!, state: 'skipped' };
    const frame = plain(renderSetupFrame(state({
      steps,
      cursor: 4,
      summary: { headline: 'Setup paused - Codor is not running.', harnesses: [], nextAction: 'Run `codor install` when you are ready.' },
    })));
    expect(frame).toContain('Setup paused - Codor is not running.');
    expect(frame).toContain('Run `codor install` when you are ready.');
    expect(frame).not.toContain('Open http');
  });
});

describe('constrained viewports keep the active choice usable', () => {
  const menu = {
    message: 'How will you reach Codor?',
    focused: 0,
    canBack: true,
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
        steps, cursor: 2, menu, controls: controls({ back: true }), viewport,
      })));
      const lines = frame.split('\n').filter(Boolean);
      expect(lines.length).toBeLessThanOrEqual(viewport.rows);
      expect(lines.every((line) => [...line].length <= viewport.columns)).toBe(true);
      expect(frame).toContain('How will you reach Codor?');
      expect(frame).toContain('Localhost');
    },
  );

  it('drops the word art on a short terminal but keeps the active step', () => {
    const short = plain(renderSetupFrame(state({ steps: midway(), cursor: 2, viewport: { rows: 14, columns: 80 } })));
    const artRow = CODOR_WORD_ART.split('\n').find((line) => line.includes('█'))!;
    expect(short).not.toContain(artRow);
    expect(short).toContain('(3) Where you will use Codor');
  });
});
