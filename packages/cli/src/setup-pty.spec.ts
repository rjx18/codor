import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SETUP_CURSOR_HIDE, SETUP_CURSOR_SHOW } from './setup-ui.js';

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
const sessionUrl = pathToFileURL(fileURLToPath(new URL('../dist/setup-session.js', import.meta.url))).href;

// A three-step wizard: an automatic step, a Localhost/Tailscale choice, and a
// second automatic step that fails once under the "retry" scenario. Markers on
// stdout let the tests observe how many times each step actually ran.
const SOURCE = `
  import { SetupCancelled, SetupSession } from ${JSON.stringify(sessionUrl)};
  const scenario = process.env.SCENARIO ?? 'advance';
  const session = new SetupSession({ version: '0.10.0' });
  let attempts = 0;
  let access;
  const steps = [
    { title: 'One', run: async ({ log }) => { process.stdout.write('RUN:one\\n'); log('checked'); return 'one'; } },
    {
      title: 'Access',
      menu: { message: 'Choose access.', options: [
        { id: 'localhost', label: 'Localhost', description: 'This computer.', available: true },
        { id: 'tailscale', label: 'Tailscale', description: 'Your tailnet.', available: true },
      ] },
      run: async ({ choice }) => { access = choice; return String(choice); },
    },
    { title: 'Three', run: async () => {
      attempts += 1;
      process.stdout.write('RUN:three:' + attempts + '\\n');
      if (scenario === 'retry' && attempts === 1) throw new Error('transient bootstrap boom');
      return 'three';
    } },
  ];
  try {
    await session.run(steps);
    session.finish({ endpoint: 'http://127.0.0.1:8137', harnesses: ['codex'], nextAction: 'Enter ABCD-2345.' });
    process.stdout.write('SELECTED=' + access + '\\n');
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
const LEFT = '\\033[D';

const posixDescribe = describe.skipIf(process.platform === 'win32');

posixDescribe('setup wizard in a real pseudo-terminal', () => {
  it.each([
    { rows: 10, columns: 80 },
    { rows: 24, columns: 40 },
  ])('advances to the ready summary and restores the cursor at $columns x $rows', ({ rows, columns }) => {
    // Enter through: One -> select access -> Access done -> Three -> finish.
    const result = runPty([ENTER, ENTER, ENTER, ENTER], rows, columns);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(SETUP_CURSOR_HIDE);
    expect(result.stdout).toContain(SETUP_CURSOR_SHOW);
    expect(result.stdout).toContain('Codor is ready.');
    expect(result.stdout).toContain('SELECTED=localhost');
    expect(result.stdout).not.toContain('[?1049h');
  });

  it('re-runs only the failed step on Retry, and completes', () => {
    // One -> access -> Three fails -> Retry -> Three succeeds -> finish.
    const result = runPty([ENTER, ENTER, ENTER, 'r', ENTER], 24, 80, 'retry');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('RUN:three:1');
    expect(result.stdout).toContain('RUN:three:2');
    expect(result.stdout).toContain('transient bootstrap boom');
    // The earlier automatic step ran exactly once despite the retry downstream.
    expect(result.stdout.split('RUN:one').length - 1).toBe(1);
    expect(result.stdout).toContain('SELECTED=localhost');
  });

  it('does not re-run a completed step when navigating Back then Next', () => {
    // One -> access -> Three -> Back to Access -> Next to Three (done) -> finish.
    const result = runPty([ENTER, ENTER, ENTER, LEFT, ENTER, ENTER], 24, 80);
    expect(result.status).toBe(0);
    // Three's work ran exactly once even though we returned to Access and forward.
    expect(result.stdout.split('RUN:three').length - 1).toBe(1);
    expect(result.stdout).toContain('SELECTED=localhost');
  });

  it.each(['q', '\\003'])('restores the cursor when cancelled with %j', (key) => {
    const result = runPty([key], 24, 80);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CANCELLED');
    expect(result.stdout).toContain(SETUP_CURSOR_SHOW);
    expect(result.stdout).not.toContain('[?1049h');
  });
});
