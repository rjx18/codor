import { describe, expect, it, vi } from 'vitest';

import {
  CODOR_WORD_ART,
  SETUP_CLEAR_SCREEN,
  SETUP_CURSOR_HIDE,
  SETUP_STAGE_TITLES,
  createSetupStages,
  renderSetupFrame,
  type SetupFrameState,
} from './setup-ui.js';

const ansi = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const plain = (value: string): string => value.replace(ansi, '');
const state = (overrides: Partial<SetupFrameState> = {}): SetupFrameState => ({
  version: '0.10.0',
  byline: 'created by richhardry',
  title: 'Setup',
  stages: createSetupStages(),
  spinnerFrame: 0,
  viewport: { rows: 40, columns: 100 },
  ...overrides,
});

// harn:assume setup-renders-five-stage-interactive-session ref=setup-frame-regression
describe('pure setup frame', () => {
  it('renders the exact five-stage sequence and supplied identity', () => {
    const frame = plain(renderSetupFrame(state()));
    expect(SETUP_STAGE_TITLES).toEqual([
      'Check this computer',
      'Prepare private files',
      'Choose access',
      'Start Codor',
      'Create pairing code',
    ]);
    expect(frame).toContain('v0.10.0 - created by richhardry');
    for (const [index, title] of SETUP_STAGE_TITLES.entries()) {
      expect(frame).toContain(`[${String(index + 1)}] ${title}`);
    }
    // The Codor emblem shows once the viewport is tall enough to seat it above
    // the stages; assert a glyph row, not the art's blank leading padding.
    const artRow = CODOR_WORD_ART.split('\n').find((line) => line.includes('█'))!;
    expect(plain(renderSetupFrame(state({ viewport: { rows: 48, columns: 100 } })))).toContain(artRow);
    // On a standard-height terminal it compacts away so the stages stay visible.
    expect(frame).not.toContain(artRow);
  });

  it.each(['pending', 'running', 'done', 'skipped', 'failed'] as const)(
    'renders a %s stage state',
    (stageState) => {
      const stages = createSetupStages();
      stages[0]!.state = stageState;
      expect(plain(renderSetupFrame(state({ stages })))).toContain(
        stageState === 'running' ? 'working' : stageState,
      );
    },
  );

  it('is side-effect free and emits one primary-buffer repaint', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw new Error('renderer touched stdout');
    });
    const timer = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => {
      throw new Error('renderer started a timer');
    });
    expect(() => renderSetupFrame(state())).not.toThrow();
    write.mockRestore();
    timer.mockRestore();
    const frame = renderSetupFrame(state());
    expect(frame.startsWith(SETUP_CLEAR_SCREEN)).toBe(true);
    expect(frame).not.toContain(SETUP_CURSOR_HIDE);
    expect(frame).not.toContain('\u001B[?1049h');
  });

  it('bounds logs and keeps actionable access content in constrained viewports', () => {
    const stages = createSetupStages();
    stages[0]!.logs = Array.from({ length: 20 }, (_, index) => `line ${String(index)}`);
    const menu = {
      message: 'Choose how you will reach Codor.',
      focused: 0,
      selected: 'localhost',
      options: [
        { id: 'localhost', label: 'Localhost', description: 'This computer.', available: true },
        { id: 'tailscale', label: 'Tailscale', description: 'Your tailnet.', available: false },
      ],
    };
    for (const viewport of [{ rows: 10, columns: 80 }, { rows: 24, columns: 40 }]) {
      const frame = plain(renderSetupFrame(state({ stages, menu, viewport })));
      const lines = frame.split('\n').filter(Boolean);
      expect(lines.length).toBeLessThanOrEqual(viewport.rows);
      expect(lines.every((line) => [...line].length <= viewport.columns)).toBe(true);
      expect(frame).toContain('Choose how you will reach Codor.');
      expect(frame).toContain('Localhost');
    }
  });

  it('shows focus and Space selection as separate radio state', () => {
    const frame = plain(renderSetupFrame(state({
      menu: {
        message: 'Choose access.', focused: 1, selected: 'localhost', options: [
          { id: 'localhost', label: 'Localhost', description: 'Local.', available: true },
          { id: 'tailscale', label: 'Tailscale', description: 'Remote.', available: true },
        ],
      },
    })));
    expect(frame).toContain('\u276F');
    expect(frame).toContain('\u25C9');
    expect(frame).toContain('\u25CB');
  });

  it('renders a closing summary without claiming browser enrollment', () => {
    const frame = plain(renderSetupFrame(state({
      title: 'Setup complete',
      summary: {
        endpoint: 'http://127.0.0.1:8137',
        harnesses: ['claude', 'codex'],
        nextAction: 'Enter ABCD-2345 in your browser.',
      },
    })));
    expect(frame).toContain('Codor is ready.');
    expect(frame).toContain('ABCD-2345');
    expect(frame).not.toContain('browser paired');
  });
});
// harn:end setup-renders-five-stage-interactive-session
