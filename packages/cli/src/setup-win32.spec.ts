import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultInstallIo, type InstallIo } from './runtime-install.js';
import { runSetup } from './setup.js';

const winOptions = (root: string, commands: string[], output: string[]) => {
  const repoRoot = join(root, 'repo with spaces');
  mkdirSync(join(repoRoot, 'packages', 'cli', 'dist'), { recursive: true });
  mkdirSync(join(repoRoot, 'packages', 'web-next', 'dist'), { recursive: true });
  mkdirSync(join(repoRoot, 'packaging', 'systemd'), { recursive: true });
  writeFileSync(join(repoRoot, 'packages', 'cli', 'dist', 'index.js'), '', 'utf8');
  writeFileSync(join(repoRoot, 'packages', 'web-next', 'dist', 'index.html'), '', 'utf8');
  writeFileSync(join(repoRoot, 'packaging', 'systemd', 'codor.service'), 'ExecStart=/usr/bin/node\n', 'utf8');
  return ({
  exec: (command: string, args: string[]) => {
    commands.push([command, ...args].join(' '));
    return '';
  },
  home: join(root, 'home'),
  nodePath: join(root, 'node.exe'),
  platform: 'win32' as const,
  randomToken: () => 'a'.repeat(64),
  renderQr: () => '[qr]',
  repoRoot,
  probe: async () => true,
  generation: () => 'windows-generation',
  runtimeStatus: async () => ({ version: 'test-version', generation: 'windows-generation' }),
  sleep: async () => undefined,
  version: 'test-version',
  which: (command: string) => command === 'codex'
    ? join(root, 'tools', 'codex.cmd')
    : undefined,
  });
};

// harn:assume windows-setup-installs-private-task-service ref=windows-setup-regression
// harn:assume platform-services-propagate-destination-pnpm-node-path ref=node-path-windows-regression
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
      expect(rendered).toContain('CODOR_RUNTIME_VERSION');
      expect(rendered).toContain('CODOR_SERVICE_GENERATION');
      expect(rendered).toContain('exit $LASTEXITCODE');
      expect(rendered).toContain('<Hidden>true</Hidden>');
      expect(rendered).toContain('schtasks /Create');
      expect(rendered).not.toContain('a'.repeat(64));
      expect(rendered).not.toContain('NODE_PATH');
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
        access: 'localhost',
        dryRun: false,
        env: { USERNAME: 'test-user', PATH: 'C:\\Windows\\System32' },
        out: (line) => output.push(line),
        overrides: winOptions(root, commands, output),
        yes: true,
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
      expect(commands.indexOf('schtasks /End /TN Codor Switchboard'))
        .toBeLessThan(commands.indexOf(`schtasks /Create /TN Codor Switchboard /XML ${taskPath} /F`));
      expect(output.join('\n')).not.toContain('a'.repeat(64));
      expect(readFileSync(scriptPath, 'utf8')).not.toContain('NODE_PATH');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits NODE_PATH pointing at the pnpm hoist dir when the invoking runtime is pnpm-linked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codor-win32-nodepath-'));
    const commands: string[] = [];
    const output: string[] = [];
    const home = join(root, 'home');
    try {
      const overrides = winOptions(root, commands, output);
      const hoistDir = join(overrides.repoRoot, 'node_modules', '.pnpm', 'node_modules');
      mkdirSync(hoistDir, { recursive: true });
      await runSetup({
        access: 'localhost',
        dryRun: false,
        env: { USERNAME: 'test-user', PATH: 'C:\\Windows\\System32' },
        out: (line) => output.push(line),
        overrides,
        yes: true,
      });
      const scriptPath = join(home, '.config', 'codor', 'codor-service.ps1');
      const script = readFileSync(scriptPath, 'utf8');
      expect(script).toContain(`$env:NODE_PATH = '${hoistDir}'`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // harn:assume windows-runtime-swap-requires-task-quiescence ref=windows-runtime-quiescence-regression
  it('quiesces the existing task before a normal packaged install swaps the runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codor-win32-quiesce-'));
    const commands: string[] = [];
    const output: string[] = [];
    const events: string[] = [];
    let taskRunning = true;
    try {
      const overrides = winOptions(root, commands, output);
      const wrapper = join(root, '_npx', 'candidate', 'node_modules', '@richhardry', 'codor');
      const cli = join(wrapper, 'node_modules', '@codor', 'cli');
      mkdirSync(join(cli, 'dist'), { recursive: true });
      mkdirSync(join(cli, 'runtime', 'web'), { recursive: true });
      mkdirSync(join(cli, 'packaging', 'systemd'), { recursive: true });
      writeFileSync(join(wrapper, 'package.json'), JSON.stringify({ version: 'test-version' }));
      writeFileSync(join(cli, 'package.json'), JSON.stringify({ version: 'test-version' }));
      writeFileSync(join(cli, 'dist', 'index.js'), '');
      writeFileSync(join(cli, 'runtime', 'web', 'index.html'), '');
      writeFileSync(join(cli, 'packaging', 'systemd', 'codor.service'), 'ExecStart=/old\n');
      const installIo: InstallIo = {
        ...defaultInstallIo,
        move: (from, to) => {
          if (taskRunning) throw new Error('runtime move attempted while task was running');
          events.push(`move ${from} ${to}`);
          defaultInstallIo.move(from, to);
        },
      };
      overrides.runtime = {
        layout: 'installed-package',
        root: cli,
        cliEntrypoint: join(cli, 'dist', 'index.js'),
        staticRoot: join(cli, 'runtime', 'web'),
        serviceTemplate: join(cli, 'packaging', 'systemd', 'codor.service'),
      };
      overrides.installIo = installIo;
      overrides.exec = (command, args) => {
        const rendered = [command, ...args].join(' ');
        commands.push(rendered);
        events.push(rendered);
        if (command === 'schtasks' && args[0] === '/Query') return '<Task />';
        if (command === 'schtasks' && args[0] === '/End') taskRunning = false;
        if (command === 'schtasks' && args[0] === '/Run') taskRunning = true;
        return '';
      };

      await runSetup({
        access: 'localhost',
        dryRun: false,
        env: { USERNAME: 'test-user', PATH: 'C:\\Windows\\System32' },
        out: (line) => output.push(line),
        overrides,
        yes: true,
      });

      expect(commands[0]).toBe('schtasks /Query /TN Codor Switchboard /XML');
      expect(commands[1]).toBe('schtasks /End /TN Codor Switchboard');
      const firstMove = events.findIndex((event) => event.startsWith('move '));
      expect(firstMove).toBeGreaterThan(1);
      expect(events.slice(0, firstMove).filter((event) => event === 'schtasks /End /TN Codor Switchboard')).toHaveLength(1);
      expect(taskRunning).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  // harn:end windows-runtime-swap-requires-task-quiescence

  it('names every supported platform when rejecting another one', async () => {
    await expect(runSetup({
      dryRun: true,
      env: { HOME: '/tmp' },
      out: () => undefined,
      overrides: { platform: 'freebsd' as NodeJS.Platform },
    })).rejects.toThrow('Linux, macOS, and Windows');
  });
});
// harn:end platform-services-propagate-destination-pnpm-node-path
// harn:end windows-setup-installs-private-task-service
