import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runSetup } from './setup.js';

const winOptions = (root: string, commands: string[], output: string[]) => ({
  confirm: async () => true,
  exec: (command: string, args: string[]) => {
    commands.push([command, ...args].join(' '));
    return '';
  },
  home: join(root, 'home'),
  nodePath: join(root, 'node.exe'),
  platform: 'win32' as const,
  randomToken: () => 'a'.repeat(64),
  renderQr: () => '[qr]',
  repoRoot: join(root, 'repo with spaces'),
  which: (command: string) => command === 'codex'
    ? join(root, 'tools', 'codex.cmd')
    : undefined,
});

// harn:assume windows-setup-installs-task-scheduler-service ref=windows-setup-regression
describe('codor setup on Windows', () => {
  it('dry-runs the private service without executing commands or disclosing the token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codor-win32-dry-'));
    const commands: string[] = [];
    const output: string[] = [];
    try {
      await runSetup({
        dryRun: true,
        env: { USERNAME: 'test-user', PATH: 'C:\\Windows\\System32' },
        out: (line) => output.push(line),
        overrides: winOptions(root, commands, output),
      });
      const rendered = output.join('\n');
      expect(commands).toEqual([]);
      expect(rendered).toContain('install generated ServiceScript');
      expect(rendered).toContain('install generated ScheduledTaskXml');
      expect(rendered).toContain('Get-Content -Raw -Path');
      expect(rendered).toContain('exit $LASTEXITCODE');
      expect(rendered).toContain('<Hidden>true</Hidden>');
      expect(rendered).toContain('schtasks /Create');
      expect(rendered).not.toContain('a'.repeat(64));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes an ACL-protected wrapper and UTF-16 task, then registers and starts it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codor-win32-real-'));
    const commands: string[] = [];
    const output: string[] = [];
    const home = join(root, 'home');
    try {
      await runSetup({
        dryRun: false,
        env: { USERNAME: 'test-user', PATH: 'C:\\Windows\\System32' },
        out: (line) => output.push(line),
        overrides: winOptions(root, commands, output),
      });
      const configDir = join(home, '.config', 'codor');
      const tokenPath = join(configDir, 'token');
      const scriptPath = join(configDir, 'codor-service.ps1');
      const taskPath = join(configDir, 'codor-task.xml');
      expect(readFileSync(tokenPath, 'utf8').trim()).toBe('a'.repeat(64));
      expect(existsSync(scriptPath)).toBe(true);
      expect(readFileSync(scriptPath, 'utf8')).toContain('repo with spaces');
      expect(readFileSync(scriptPath, 'utf8').trimEnd()).toMatch(/exit \$LASTEXITCODE$/);
      const taskBytes = readFileSync(taskPath);
      expect([...taskBytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
      expect(readFileSync(taskPath, 'utf16le')).toContain('<Hidden>true</Hidden>');
      expect(commands).toContain(`icacls ${tokenPath} /inheritance:r /grant:r test-user:F`);
      expect(commands).toContain(`schtasks /Create /TN Codor Switchboard /XML ${taskPath} /F`);
      expect(commands).toContain('schtasks /Run /TN Codor Switchboard');
      expect(output.join('\n')).not.toContain('a'.repeat(64));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names every supported platform when rejecting another one', async () => {
    await expect(runSetup({
      dryRun: true,
      env: { HOME: '/tmp' },
      out: () => undefined,
      overrides: { platform: 'freebsd' as NodeJS.Platform },
    })).rejects.toThrow('Linux, macOS, and Windows');
  });
});
// harn:end windows-setup-installs-task-scheduler-service
