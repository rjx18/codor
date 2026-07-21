import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SETUP_CURSOR_HIDE, SETUP_CURSOR_SHOW } from './setup-ui.js';

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
const sessionUrl = pathToFileURL(fileURLToPath(new URL('../dist/setup-session.js', import.meta.url))).href;

function runPty(input: string, rows: number, columns: number) {
  const source = `
    import { SetupCancelled, SetupSession } from ${JSON.stringify(sessionUrl)};
    const session = new SetupSession({ version: '0.10.0' });
    session.start();
    try {
      const access = await session.chooseAccess('Choose access.', [
        { id: 'localhost', label: 'Localhost', description: 'This computer.', available: true },
        { id: 'tailscale', label: 'Tailscale', description: 'Your tailnet.', available: true },
      ]);
      session.setStage(0, 'done');
      session.finish({ endpoint: 'http://127.0.0.1:8137', harnesses: ['codex'], nextAction: 'Enter ABCD-2345.' });
      process.stdout.write('SELECTED=' + access + '\\n');
    } catch (error) {
      session.stop();
      if (!(error instanceof SetupCancelled)) throw error;
      process.stdout.write('CANCELLED\\n');
    }
  `;
  const command = `stty rows ${String(rows)} cols ${String(columns)}; exec ${shellQuote(process.execPath)} --input-type=module -e ${shellQuote(source)}`;
  if (input === '\u0003') {
    return spawnSync('bash', ['-c', `(sleep 0.2; printf '\\003') | script -qefc ${shellQuote(command)} /dev/null`], {
      encoding: 'utf8',
      timeout: 5_000,
      env: { ...process.env, NO_COLOR: '1' },
    });
  }
  return spawnSync('script', ['-qefc', command, '/dev/null'], {
    encoding: 'utf8',
    input,
    timeout: 5_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

const posixDescribe = describe.skipIf(process.platform === 'win32');

posixDescribe('setup in a real pseudo-terminal', () => {
  it.each([
    { rows: 10, columns: 80 },
    { rows: 24, columns: 40 },
  ])('keeps the summary visible and restores the cursor at $columns x $rows', ({ rows, columns }) => {
    const result = runPty('\r', rows, columns);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(SETUP_CURSOR_HIDE);
    expect(result.stdout).toContain(SETUP_CURSOR_SHOW);
    expect(result.stdout).toContain('Codor is ready.');
    expect(result.stdout).toContain('SELECTED=localhost');
    expect(result.stdout).not.toContain('\u001B[?1049h');
  });

  it.each(['q', '\u0003'])('restores the cursor when cancelled with %j', (input) => {
    const result = runPty(input, 24, 80);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CANCELLED');
    expect(result.stdout).toContain(SETUP_CURSOR_SHOW);
    expect(result.stdout).not.toContain('\u001B[?1049h');
  });
});
