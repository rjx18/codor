import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SETUP_CURSOR_HIDE, SETUP_CURSOR_SHOW } from './setup-ui.js';

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
const distUrl = (name: string): string => pathToFileURL(fileURLToPath(new URL(`../dist/${name}`, import.meta.url))).href;
const sessionUrl = distUrl('setup-session.js');
const uiUrl = distUrl('setup-ui.js');
const qrUrl = distUrl('terminal-qr.js');

// A realistic long Tailscale pairing URL — it wraps across several card lines, so
// the test proves the whole multiline card renders (not truncated to one line).
const LONG_URL = 'https://setup-host.example.ts.net/pair?endpoint=https%3A%2F%2Fsetup-host.example.ts.net&pairing_token=YrBG41M28KVjYaR05P7Zb7HcykxA-3pPGa18bPCXvoo&switchboard_sign_pub=XV5Tvp6uechAVjeX_Okb-SKSR8UunmvFTOzTxL_rLNw';
// Rejoin the wrapped URL: strip ANSI, box chrome, and the whitespace it wraps around.
const compact = (value: string): string =>
  value.replace(/\[[0-9;?]*[A-Za-z]/g, '').replace(/[\s│╭╮╰╯─]/g, '');

// A three-step wizard: an automatic step that auto-advances, a Localhost/Tailscale
// access choice, and a consent-gated Start step that mutates only on the
// affirmative, skips honestly on decline, and (under the "retry" scenario) fails
// once. Markers on stdout let the tests observe what actually ran.
const SOURCE = `
  import { SetupCancelled, SetupSession } from ${JSON.stringify(sessionUrl)};
  import { renderPairingCard } from ${JSON.stringify(uiUrl)};
  import { renderTerminalQr } from ${JSON.stringify(qrUrl)};
  const LONG_URL = ${JSON.stringify(LONG_URL)};
  const scenario = process.env.SCENARIO ?? 'advance';
  const session = new SetupSession({ version: '0.10.0' });
  let attempts = 0;
  let access;
  let startState = 'pending';
  let paired = false;
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
        if (choice !== 'start') { startState = 'skipped'; return { skip: true, summary: '(run codor install when ready)', skipFollowing: true }; }
        attempts += 1;
        process.stdout.write('RUN:start:' + attempts + '\\n');
        if (scenario === 'retry' && attempts === 1) throw new Error('transient bootstrap boom');
        startState = 'started';
        return 'started';
      },
    },
    {
      title: 'Pair a browser',
      menu: { message: 'Pair a browser now?', options: [
        { id: 'create', label: 'Create a pairing code', description: '', available: true },
        { id: 'later', label: 'Set up later', description: '', available: true },
      ] },
      run: async ({ choice, presentResult }) => {
        if (choice !== 'create') return { skip: true, summary: '(run codor pair later)' };
        process.stdout.write('RUN:pair\\n');
        // Present the real multiline pairing card, sized to the live terminal just
        // like setup.ts does — the whole card must survive into the frame.
        const columns = process.stdout.columns ?? 80;
        const rows = process.stdout.rows ?? 24;
        presentResult(renderPairingCard(
          { code: 'ABCD-2345', url: LONG_URL, expires: 'in 10 minutes', qr: renderTerminalQr(LONG_URL), instruction: 'Scan the QR or enter the code in your browser.' },
          columns,
          Math.max(8, rows - 8),
        ));
        paired = true;
        return 'paired';
      },
    },
  ];
  try {
    await session.run(steps);
    if (startState !== 'started') {
      session.finish({ headline: 'Setup paused - Codor is not running.', harnesses: ['codex'], nextAction: 'Run codor install when ready.' });
    } else if (!paired) {
      session.finish({ headline: 'Codor is running.', harnesses: ['codex'], nextAction: 'Run codor pair when ready.' });
    } else {
      session.finish(); // keep the in-frame result card as the final frame
    }
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
    { rows: 24, columns: 80 },
    { rows: 24, columns: 40 },
  ])('auto-advances, gates consent, and shows the full pairing card before Finish at $columns x $rows', ({ rows, columns }) => {
    // One auto-advances; Enter: Localhost, Start, Create pairing; Enter finishes.
    const result = runPty([ENTER, ENTER, ENTER, ENTER], rows, columns);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(SETUP_CURSOR_HIDE);
    expect(result.stdout).toContain(SETUP_CURSOR_SHOW);
    // The real multiline pairing card is shown in-frame, before Finish, in full:
    // code, the complete (wrapped) URL, expiry, and instruction all survive.
    expect(result.stdout).toContain('ABCD-2345'); // code
    expect(compact(result.stdout)).toContain(LONG_URL); // complete URL, reconstructed from wrapped lines
    expect(result.stdout).toContain('in 10 minutes'); // expiry
    expect(result.stdout).toContain('Scan the QR'); // instruction (may wrap at 40 cols)
    expect(result.stdout).toContain('Finish'); // reserved control
    expect(result.stdout).toContain('RUN:pair');
    expect(result.stdout).toContain('SELECTED=localhost');
    expect(result.stdout).toContain('START=started');
    // No word art; the QR is omitted at 24 rows, so no block glyphs appear.
    expect(result.stdout).not.toContain('█');
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
    // Localhost -> accept Start (fails) -> Retry -> accept Start -> Create pairing -> finish.
    const result = runPty([ENTER, ENTER, 'r', ENTER, ENTER, ENTER], 24, 80, 'retry');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('RUN:start:1');
    expect(result.stdout).toContain('RUN:start:2');
    expect(result.stdout).toContain('transient bootstrap boom');
    expect(result.stdout.split('RUN:one').length - 1).toBe(1);
    expect(result.stdout).toContain('START=started');
  });

  it('does not re-run the access step when navigating Back then Forward', () => {
    // Localhost -> Back off Start menu -> Forward to Start -> accept -> Create pairing -> finish.
    const result = runPty([ENTER, LEFT, RIGHT, ENTER, ENTER, ENTER], 24, 80);
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
