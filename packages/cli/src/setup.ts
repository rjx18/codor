import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { CryptoVault, pairingUrl } from '@codor/switchboard';

import { renderTerminalQr } from './terminal-qr.js';

const HARNESSES = ['claude', 'codex', 'opencode', 'gemini', 'copilot'] as const;

export interface SetupOverrides {
  confirm?(prompt: string): Promise<boolean>;
  exec?(command: string, args: string[]): string;
  home?: string;
  nodePath?: string;
  randomToken?(): string;
  renderQr?(payload: string): string;
  repoRoot?: string;
  which?(command: string): string | undefined;
}

export interface SetupOptions {
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  overrides?: SetupOverrides;
}

const defaultExec = (command: string, args: string[]): string => execFileSync(command, args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

const defaultWhich = (command: string): string | undefined => {
  try {
    return defaultExec('which', [command]).split('\n')[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
};

async function defaultConfirm(prompt: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`${prompt} [y/N] `);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    terminal.close();
  }
}

function uniquePath(parts: Array<string | undefined>): string {
  return [...new Set(parts.flatMap((part) => part?.split(':') ?? []).filter(Boolean))].join(':');
}

function replaceNodePath(template: string, nodePath: string): string {
  return template.replace(/^(ExecStart=)\S+/m, `$1${nodePath}`);
}

// harn:assume cli-setup-wizard-preserves-service-environment ref=setup-runtime
export async function runSetup(options: SetupOptions): Promise<void> {
  const overrides = options.overrides ?? {};
  const home = resolve(overrides.home ?? options.env.HOME ?? homedir());
  const repoRoot = resolve(overrides.repoRoot ?? fileURLToPath(new URL('../../../', import.meta.url)));
  const nodePath = resolve(overrides.nodePath ?? process.execPath);
  const confirm = overrides.confirm ?? defaultConfirm;
  const exec = overrides.exec ?? defaultExec;
  const which = overrides.which ?? defaultWhich;
  const renderQr = overrides.renderQr ?? renderTerminalQr;
  const configDir = join(home, '.config', 'codor');
  const dataDir = join(home, '.codor');
  const tokenPath = join(configDir, 'token');
  const envPath = join(configDir, 'env');
  const userUnitDir = join(home, '.config', 'systemd', 'user');
  const userUnitPath = join(userUnitDir, 'codor.service');
  const templatePath = join(repoRoot, 'packaging', 'systemd', 'codor.service');
  const unitContent = replaceNodePath(readFileSync(templatePath, 'utf8'), nodePath);
  const harnessPaths = HARNESSES.map((harness) => which(harness)).filter(
    (path): path is string => path !== undefined,
  );
  const servicePath = uniquePath([
    join(home, '.local', 'bin'),
    dirname(nodePath),
    ...harnessPaths.map(dirname),
    options.env.PATH,
  ]);

  if (options.dryRun) {
    options.out(`[dry-run] create ${configDir} and ${dataDir} mode 700; create ${tokenPath} mode 600 if absent`);
    options.out(`[dry-run] install ${templatePath} -> ${userUnitPath} mode 600`);
    options.out('[dry-run] unit content:');
    for (const line of unitContent.trimEnd().split('\n')) options.out(line);
    options.out(`[dry-run] write ${envPath} mode 600`);
    options.out('CODOR_TOKEN=<redacted generated-or-existing token>');
    options.out(`PATH=${servicePath}`);
    options.out('[dry-run] systemctl --user daemon-reload');
    options.out('[dry-run] systemctl --user enable --now codor.service');
    if (which('tailscale')) {
      options.out('[dry-run] tailscale serve --bg http://127.0.0.1:8137');
      options.out('[dry-run] tailscale serve status');
    } else {
      options.out('[dry-run] Tailscale not detected; skip private HTTPS publication');
    }
    options.out('[dry-run] generate a ten-minute pairing link and exact-payload terminal QR');
    return;
  }

  if (await confirm(`Create private configuration in ${configDir} and data in ${dataDir}?`)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(configDir, 0o700);
    chmodSync(dataDir, 0o700);
    if (!existsSync(tokenPath)) {
      const token = overrides.randomToken?.() ?? randomBytes(32).toString('hex');
      writeFileSync(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
    chmodSync(tokenPath, 0o600);
    options.out('Private configuration and data directories are ready.');
  }

  if (await confirm(`Install the user service at ${userUnitPath}?`)) {
    if (!existsSync(tokenPath)) throw new Error(`operator token is missing at ${tokenPath}`);
    mkdirSync(userUnitDir, { recursive: true, mode: 0o700 });
    writeFileSync(userUnitPath, unitContent, { encoding: 'utf8', mode: 0o600 });
    chmodSync(userUnitPath, 0o600);
    const token = readFileSync(tokenPath, 'utf8').trim();
    writeFileSync(envPath, `CODOR_TOKEN=${token}\nPATH=${servicePath}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    chmodSync(envPath, 0o600);
    options.out(`Installed codor.service with Node ${nodePath}.`);
  }

  if (await confirm('Reload systemd and enable codor.service now?')) {
    exec('systemctl', ['--user', 'daemon-reload']);
    exec('systemctl', ['--user', 'enable', '--now', 'codor.service']);
    options.out('codor.service is enabled and running.');
    try {
      const linger = exec('loginctl', ['show-user', options.env.USER ?? '', '-p', 'Linger', '--value']);
      if (linger.trim() !== 'yes') options.out(`For boot-time startup, run: loginctl enable-linger ${options.env.USER ?? '$USER'}`);
    } catch {
      options.out(`Check lingering for boot-time startup: loginctl enable-linger ${options.env.USER ?? '$USER'}`);
    }
  }

  let endpoint = 'http://127.0.0.1:8137';
  if (which('tailscale') && await confirm('Publish private HTTPS with Tailscale Serve?')) {
    exec('tailscale', ['serve', '--bg', endpoint]);
    const status = exec('tailscale', ['serve', 'status']);
    endpoint = status.match(/https:\/\/[^\s/]+/)?.[0] ?? endpoint;
    options.out(`Private browser origin: ${endpoint}`);
  }

  if (await confirm(`Generate the first pairing link for ${endpoint}?`)) {
    const crypto = new CryptoVault(dataDir);
    try {
      const offer = crypto.pairing.issue(endpoint);
      const url = pairingUrl(offer);
      options.out(renderQr(url));
      options.out(url);
      options.out(`expires ${offer.expires_at}`);
    } finally {
      crypto.close();
    }
  }
}
// harn:end cli-setup-wizard-preserves-service-environment
