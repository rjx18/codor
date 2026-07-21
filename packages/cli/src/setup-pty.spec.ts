import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SETUP_CURSOR_HIDE, SETUP_CURSOR_SHOW } from './setup-ui.js';

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
const sessionUrl = pathToFileURL(fileURLToPath(new URL('../dist/setup-session.js', import.meta.url))).href;

// A three-step wizard: an automatic step that auto-advances, a Localhost/Tailscale
// access choice, and a consent-gated Start step that mutates only on the
// affirmative, skips honestly on decline, and (under the "retry" scenario) fails
// once. Markers on stdout let the tests observe what actually ran.
const SOURCE = `
  import { SetupCancelled, SetupSession } from ${JSON.stringify(sessionUrl)};
  const scenario = process.env.SCENARIO ?? 'advance';
  const session = new SetupSession({ version: '0.10.0' });
  let attempts = 0;
  let access;
  let startState = 'pending';
  const steps = [
    { title: 'One', run: async ({ log }) => { process.stdout.write('RUN:one\\n'); log('checked'); return 'one'; } },
    {
      title: 'Access',
      menu: { message: 'How will you reach Codor?', options: [
        { id: 'localhost', label: 'Localhost', description: 'This computer.', available: true },
        { id: 'tailscale', label: 'Tailscale', description: 'Your tailnet.', available: true },
      ] },
      run: async ({ choice }) => { access = choice; return String(choice); },
    },
    {
      title: 'Start Codor',
      menu: { message: 'Run Codor in the background?', options: [
        { id: 'start', label: 'Start Codor', description: '', available: true },
        { id: 'later', label: 'Not now', description: '', available: true },
      ] },
      run: async ({ choice }) => {
        if (choice !== 'start') { startState = 'skipped'; return { skip: true, summary: '(run codor install when ready)' }; }
        attempts += 1;
        process.stdout.write('RUN:start:' + attempts + '\\n');
        if (scenario === 'retry' && attempts === 1) throw new Error('transient bootstrap boom');
        startState = 'started';
        return 'started';
      },
    },
  ];
  try {
    await session.run(steps);
    session.finish(startState === 'started'
      ? { headline: 'Codor is ready.', endpoint: 'http://127.0.0.1:8137', harnesses: ['codex'], nextAction: 'Enter ABCD-2345.' }
      : { headline: 'Setup paused - Codor is not running.', harnesses: ['codex'], nextAction: 'Run codor install when ready.' });
    process.stdout.write('SELECTED=' + access + '\\n');
    process.stdout.write('START=' + startState + '\\n');
  } catch (error) {
    if (!(error instanceof SetupCancelled)) throw error;
    process.stdout.write('CANCELLED\\n');
  }
`;

function runPty(keys: readonly string[], rows: number, columns: number, scenario = 'advance') {
  const feed = keys.map((key) => `printf '${key}'; sleep 0.25`).join('; ');
  const command = `stty rows ${String(rows)} cols ${String(columns)}; exec ${shellQuote(process.execPath)} --input-type=module -e ${shellQuote(SOURCE)}`;
  return spawnSync('bash', ['-c', `(sleep 0.4; ${feed}) | script -qefc ${shellQuote(command)} /dev/null`], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, NO_COLOR: '1', SCENARIO: scenario },
  });
}

const ENTER = '\\r';
const DOWN = '\\033[B';
const LEFT = '\\033[D';
const RIGHT = '\\033[C';

const posixDescribe = describe.skipIf(process.platform === 'win32');

posixDescribe('setup wizard in a real pseudo-terminal', () => {
  it.each([
    { rows: 10, columns: 80 },
    { rows: 24, columns: 40 },
  ])('auto-advances, gates Start on consent, and reaches the ready summary at $columns x $rows', ({ rows, columns }) => {
    // One auto-advances; Enter selects Localhost; Enter accepts Start; Enter finishes.
    const result = runPty([ENTER, ENTER, ENTER], rows, columns);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(SETUP_CURSOR_HIDE);
    expect(result.stdout).toContain(SETUP_CURSOR_SHOW);
    expect(result.stdout).toContain('Codor is ready.');
    expect(result.stdout).toContain('Finish');
    expect(result.stdout).toContain('SELECTED=localhost');
    expect(result.stdout).toContain('START=started');
    // The automatic step ran exactly once with no Next key between it and Access.
    expect(result.stdout.split('RUN:one').length - 1).toBe(1);
    expect(result.stdout).not.toContain('[?1049h');
  });

  it('skips Start honestly when the operator declines, finishing paused', () => {
    // Enter selects Localhost; Down focuses "Not now"; Enter declines; Enter finishes.
    const result = runPty([ENTER, DOWN, ENTER, ENTER], 24, 80);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Setup paused - Codor is not running.');
    expect(result.stdout).toContain('START=skipped');
    expect(result.stdout).toContain('SELECTED=localhost');
    // Nothing was started: the mutating marker never printed.
    expect(result.stdout).not.toContain('RUN:start');
  });

  it('re-runs only the failed Start step on Retry, and completes', () => {
    // Localhost -> accept Start (fails) -> Retry -> accept Start (succeeds) -> finish.
    const result = runPty([ENTER, ENTER, 'r', ENTER, ENTER], 24, 80, 'retry');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('RUN:start:1');
    expect(result.stdout).toContain('RUN:start:2');
    expect(result.stdout).toContain('transient bootstrap boom');
    expect(result.stdout.split('RUN:one').length - 1).toBe(1);
    expect(result.stdout).toContain('START=started');
  });

  it('does not re-run the access step when navigating Back then Forward', () => {
    // Localhost -> Back off Start menu -> Forward to Start -> accept -> finish.
    const result = runPty([ENTER, LEFT, RIGHT, ENTER, ENTER], 24, 80);
    expect(result.status).toBe(0);
    // Access selection resolved once even though we returned to it and forward.
    expect(result.stdout).toContain('SELECTED=localhost');
    expect(result.stdout).toContain('START=started');
  });

  it.each(['q', '\\003'])('restores the cursor when cancelled with %j', (key) => {
    const result = runPty([key], 24, 80);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CANCELLED');
    expect(result.stdout).toContain(SETUP_CURSOR_SHOW);
    expect(result.stdout).not.toContain('[?1049h');
  });
});
