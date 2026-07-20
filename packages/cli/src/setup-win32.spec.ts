import { join } from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runSetup } from './setup.js';

describe('codor setup win32', () => {
  it('win32 dry-run renders ps1 and XML without executing anything or printing the token', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'codor-win32-setup-'));
    const home = join(tempDir, 'home');
    const repoRoot = join(tempDir, 'repo');
    const nodePath = join(tempDir, 'node.exe');
    const output: string[] = [];
    const commands: string[] = [];

    const overrides = {
      confirm: async () => true,
      exec: (command: string, args: string[]) => {
        commands.push([command, ...args].join(' '));
        return '';
      },
      home,
      nodePath,
      platform: 'win32' as const,
      repoRoot,
      which: (command: string) => {
        if (command === 'claude') return join(home, '.local/bin/claude');
        if (command === 'codex') return join(home, 'tools/codex');
        return undefined;
      },
    };

    await runSetup({
      dryRun: true,
      env: { USERPROFILE: home, USERNAME: 'test-user', PATH: 'C:\\Windows\\System32' },
      out: (line) => output.push(line),
      overrides,
    });

    // Check that no commands are executed
    expect(commands).toHaveLength(0);

    // Verify service script rendering and task XML rendering are present in output
    const outputStr = output.join('\n');
    expect(outputStr).toContain('[dry-run] install generated ServiceScript');
    expect(outputStr).toContain('[dry-run] install generated ScheduledTaskXml');
    expect(outputStr).toContain('schtasks /Create /TN "Codor Switchboard"');
    expect(outputStr).toContain('schtasks /Run /TN "Codor Switchboard"');
    expect(outputStr).toContain('Get-Content -Raw -Path');
    expect(outputStr).toContain(`[dry-run] icacls ${join(home, '.config', 'codor', 'token')} /inheritance:r /grant:r test-user:F`);
    expect(outputStr).toContain('<?xml version="1.0" encoding="UTF-16"?>');
    expect(outputStr).toContain('exit $LASTEXITCODE');

    // Token must never be printed
    expect(outputStr).not.toContain('a'.repeat(64));
    expect(outputStr).not.toContain('<redacted generated-or-existing token>');

    // Clean up
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('win32 real run installs service files and registers the scheduled task via schtasks', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'codor-win32-setup-'));
    const home = join(tempDir, 'home');
    const repoRoot = join(tempDir, 'repo');
    const nodePath = join(tempDir, 'node.exe');
    const output: string[] = [];
    const commands: string[] = [];

    const overrides = {
      confirm: async () => true,
      exec: (command: string, args: string[]) => {
        commands.push([command, ...args].join(' '));
        return '';
      },
      home,
      nodePath,
      platform: 'win32' as const,
      repoRoot,
      randomToken: () => 'fake-random-token-12345',
      which: (command: string) => {
        if (command === 'claude') return join(home, '.local/bin/claude');
        if (command === 'codex') return join(home, 'tools/codex');
        return undefined;
      },
    };

    await runSetup({
      dryRun: false,
      env: { USERPROFILE: home, USERNAME: 'test-user', PATH: 'C:\\Windows\\System32' },
      out: (line) => output.push(line),
      overrides,
    });

    // Check directory creation & token creation
    const configDir = join(home, '.config', 'codor');
    const dataDir = join(home, '.codor');
    const tokenPath = join(configDir, 'token');
    const ps1Path = join(configDir, 'codor-service.ps1');
    const xmlPath = join(configDir, 'codor-task.xml');

    expect(existsSync(configDir)).toBe(true);
    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(tokenPath)).toBe(true);
    expect(readFileSync(tokenPath, 'utf8').trim()).toBe('fake-random-token-12345');

    // Check files installed
    expect(existsSync(ps1Path)).toBe(true);
    expect(existsSync(xmlPath)).toBe(true);

    const ps1Content = readFileSync(ps1Path, 'utf8');

    // PATH in ps1 must be joined with semicolon and contain node/harness directories
    expect(ps1Content).toContain(`$env:PATH = '${join(home, '.local', 'bin')};${tempDir};${join(home, 'tools')};C:\\Windows\\System32'`);
    expect(ps1Content.trimEnd().endsWith('exit $LASTEXITCODE')).toBe(true);

    // schtasks requires UTF-16 task XML: the file must start with a UTF-16LE BOM
    // and its declaration must match, or it fails with "cannot switch encoding".
    const xmlRaw = readFileSync(xmlPath);
    expect(xmlRaw[0]).toBe(0xff);
    expect(xmlRaw[1]).toBe(0xfe);
    const xmlContent = readFileSync(xmlPath, 'utf16le');
    expect(xmlContent).toContain('<?xml version="1.0" encoding="UTF-16"?>');

    // schtasks /Create + /Run must be called, and icacls must be called
    expect(commands).toContain(`icacls ${tokenPath} /inheritance:r /grant:r test-user:F`);
    expect(commands).toContain(`schtasks /Create /TN Codor Switchboard /XML ${xmlPath} /F`);
    expect(commands).toContain(`schtasks /Run /TN Codor Switchboard`);

    // Clean up
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('linux dry-run smoke test passes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'codor-win32-setup-'));
    const home = join(tempDir, 'home');
    const repoRoot = join(tempDir, 'repo');
    const nodePath = join(tempDir, 'node');
    const output: string[] = [];

    // Linux setup requires packaging/systemd/codor.service to exist
    const packagingDir = join(repoRoot, 'packaging', 'systemd');
    mkdirSync(packagingDir, { recursive: true });
    writeFileSync(join(packagingDir, 'codor.service'), 'ExecStart=__EXEC_START__\nWorkingDirectory=__CWD__\nEnvironmentFile=__ENV__');

    await runSetup({
      dryRun: true,
      env: { HOME: home, USER: 'test-user', PATH: '/usr/bin' },
      out: (line) => output.push(line),
      overrides: {
        home,
        nodePath,
        platform: 'linux',
        repoRoot,
        which: () => undefined,
      },
    });

    const outputStr = output.join('\n');
    expect(outputStr).toContain('[dry-run] install');
    expect(outputStr).toContain('codor.service');

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('unsupported platform throws the expected error message naming all three platforms', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'codor-win32-setup-'));
    const home = join(tempDir, 'home');

    await expect(
      runSetup({
        dryRun: true,
        env: { HOME: home },
        out: () => {},
        overrides: {
          home,
          platform: 'freebsd' as any,
        },
      })
    ).rejects.toThrow('codor setup supports Linux, macOS, and Windows; received freebsd');

    rmSync(tempDir, { recursive: true, force: true });
  });
});
