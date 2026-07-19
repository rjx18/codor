import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { CryptoVault, pairingUrl } from '@codor/switchboard';

import { renderTerminalQr } from './terminal-qr.js';

const HARNESSES = ['claude', 'codex', 'opencode', 'gemini', 'copilot'] as const;
const LAUNCH_AGENT_LABEL = 'app.codor.switchboard';

export interface SetupOverrides {
  confirm?(prompt: string): Promise<boolean>;
  exec?(command: string, args: string[]): string;
  home?: string;
  kernelRelease?: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
  randomToken?(): string;
  renderQr?(payload: string): string;
  repoRoot?: string;
  uid?: number;
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

// harn:assume wsl-setup-reaches-windows-loopback ref=wsl-bind-selection
function wslSystemdBindHost(
  env: NodeJS.ProcessEnv,
  kernelRelease: string,
  exec: (command: string, args: string[]) => string,
  which: (command: string) => string | undefined,
): '127.0.0.1' | '0.0.0.0' {
  const isWsl = Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft/i.test(kernelRelease));
  if (!isWsl) return '127.0.0.1';
  if (!/wsl2/i.test(kernelRelease)) return '127.0.0.1';

  let networkingMode: string | undefined;
  const wslinfo = which('wslinfo');
  if (wslinfo) {
    try {
      networkingMode = exec('wslinfo', ['--networking-mode']).trim().toLowerCase() || undefined;
    } catch {
      // A present-but-broken probe cannot safely distinguish NAT from mirrored networking.
      return '127.0.0.1';
    }
  }

  if (
    (wslinfo === undefined && networkingMode === undefined)
    || networkingMode === 'nat'
    || networkingMode === 'virtioproxy'
  ) {
    return '0.0.0.0';
  }
  return '127.0.0.1';
}
// harn:end wsl-setup-reaches-windows-loopback

// harn:assume setup-service-runs-from-current-checkout ref=linux-service-current-checkout
function systemdQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('codor setup paths cannot contain control characters');
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')}"`;
}

interface SystemdUnitOptions {
  dataDir: string;
  envPath: string;
  host: '127.0.0.1' | '0.0.0.0';
  nodePath: string;
  repoRoot: string;
}

function renderSystemdUnit(template: string, options: SystemdUnitOptions): string {
  const args = [
    options.nodePath,
    join(options.repoRoot, 'packages', 'cli', 'dist', 'index.js'),
    '--data-dir',
    options.dataDir,
    'up',
    ...(options.host === '0.0.0.0' ? ['--host', options.host] : []),
    '--static-root',
    join(options.repoRoot, 'packages', 'web-next', 'dist'),
    '--channel',
    'desk',
    '--channel-name',
    'Desk',
  ];
  const rendered = template
    .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${systemdQuote(options.repoRoot)}`)
    .replace(/^EnvironmentFile=.*$/m, `EnvironmentFile=${systemdQuote(options.envPath)}`)
    .replace(/^ExecStart=.*$/m, `ExecStart=${args.map(systemdQuote).join(' ')}`);
  if (rendered === template || rendered.includes('%h/codor')) {
    throw new Error('codor setup could not render the systemd service for the current checkout');
  }
  return rendered;
}
// harn:end setup-service-runs-from-current-checkout

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

interface LaunchAgentOptions {
  dataDir: string;
  logDir: string;
  nodePath: string;
  repoRoot: string;
  servicePath: string;
  token: string;
}

// harn:assume operator-launches-serve-web-next ref=launchd-current-web-client
function renderLaunchAgent(options: LaunchAgentOptions): string {
  const values = {
    dataDir: xml(options.dataDir),
    entrypoint: xml(join(options.repoRoot, 'packages', 'cli', 'dist', 'index.js')),
    errorLog: xml(join(options.logDir, 'codor.err.log')),
    nodePath: xml(options.nodePath),
    outputLog: xml(join(options.logDir, 'codor.log')),
    repoRoot: xml(options.repoRoot),
    servicePath: xml(options.servicePath),
    staticRoot: xml(join(options.repoRoot, 'packages', 'web-next', 'dist')),
    token: xml(options.token),
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${values.nodePath}</string>
    <string>${values.entrypoint}</string>
    <string>--data-dir</string>
    <string>${values.dataDir}</string>
    <string>up</string>
    <string>--static-root</string>
    <string>${values.staticRoot}</string>
    <string>--channel</string>
    <string>desk</string>
    <string>--channel-name</string>
    <string>Desk</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${values.repoRoot}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODOR_TOKEN</key>
    <string>${values.token}</string>
    <key>PATH</key>
    <string>${values.servicePath}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ExitTimeOut</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${values.outputLog}</string>
  <key>StandardErrorPath</key>
  <string>${values.errorLog}</string>
</dict>
</plist>
`;
}
// harn:end operator-launches-serve-web-next

// harn:assume cli-setup-wizard-installs-platform-user-service ref=setup-runtime
export async function runSetup(options: SetupOptions): Promise<void> {
  const overrides = options.overrides ?? {};
  const platform = overrides.platform ?? process.platform;
  if (platform !== 'linux' && platform !== 'darwin') {
    throw new Error(`codor setup supports Linux and macOS; received ${platform}`);
  }
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
  const launchAgentDir = join(home, 'Library', 'LaunchAgents');
  const launchAgentPath = join(launchAgentDir, `${LAUNCH_AGENT_LABEL}.plist`);
  const logDir = join(dataDir, 'logs');
  const systemdBindHost = platform === 'linux'
    ? wslSystemdBindHost(
      options.env,
      overrides.kernelRelease ?? release(),
      exec,
      which,
    )
    : '127.0.0.1';
  const unitContent = platform === 'linux'
    ? renderSystemdUnit(readFileSync(templatePath, 'utf8'), {
      dataDir,
      envPath,
      host: systemdBindHost,
      nodePath,
      repoRoot,
    })
    : undefined;
  const harnessPaths = HARNESSES.map((harness) => which(harness)).filter(
    (path): path is string => path !== undefined,
  );
  const servicePath = uniquePath([
    join(home, '.local', 'bin'),
    dirname(nodePath),
    ...harnessPaths.map(dirname),
    options.env.PATH,
  ]);
  const launchUid = platform === 'darwin'
    ? overrides.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined)
    : undefined;
  if (platform === 'darwin' && (!Number.isInteger(launchUid) || launchUid! < 0)) {
    throw new Error('codor setup could not determine the macOS user id');
  }
  const launchDomain = launchUid === undefined ? undefined : `gui/${String(launchUid)}`;
  const launchTarget = launchDomain === undefined ? undefined : `${launchDomain}/${LAUNCH_AGENT_LABEL}`;

  if (options.dryRun) {
    options.out(`[dry-run] create ${configDir} and ${dataDir} mode 700; create ${tokenPath} mode 600 if absent`);
    if (platform === 'linux') {
      options.out(`[dry-run] install ${templatePath} -> ${userUnitPath} mode 600`);
      options.out('[dry-run] unit content:');
      for (const line of unitContent!.trimEnd().split('\n')) options.out(line);
      options.out(`[dry-run] write ${envPath} mode 600`);
      options.out('CODOR_TOKEN=<redacted generated-or-existing token>');
      options.out(`PATH=${servicePath}`);
      options.out('[dry-run] systemctl --user daemon-reload');
      options.out('[dry-run] systemctl --user enable --now codor.service');
    } else {
      const launchAgent = renderLaunchAgent({
        dataDir,
        logDir,
        nodePath,
        repoRoot,
        servicePath,
        token: '<redacted generated-or-existing token>',
      });
      options.out(`[dry-run] create ${logDir} mode 700`);
      options.out(`[dry-run] install generated LaunchAgent -> ${launchAgentPath} mode 600`);
      options.out('[dry-run] launch agent content:');
      for (const line of launchAgent.trimEnd().split('\n')) options.out(line);
      options.out(`[dry-run] launchctl bootout ${launchTarget} (ignore not-loaded)`);
      options.out(`[dry-run] launchctl bootstrap ${launchDomain} ${launchAgentPath}`);
      options.out(`[dry-run] launchctl enable ${launchTarget}`);
      options.out(`[dry-run] launchctl kickstart -k ${launchTarget}`);
    }
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

  const serviceInstallPath = platform === 'linux' ? userUnitPath : launchAgentPath;
  if (await confirm(`Install the user service at ${serviceInstallPath}?`)) {
    if (!existsSync(tokenPath)) throw new Error(`operator token is missing at ${tokenPath}`);
    const token = readFileSync(tokenPath, 'utf8').trim();
    if (platform === 'linux') {
      mkdirSync(userUnitDir, { recursive: true, mode: 0o700 });
      writeFileSync(userUnitPath, unitContent!, { encoding: 'utf8', mode: 0o600 });
      chmodSync(userUnitPath, 0o600);
      writeFileSync(envPath, `CODOR_TOKEN=${token}\nPATH=${servicePath}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      chmodSync(envPath, 0o600);
      options.out(`Installed codor.service with Node ${nodePath}.`);
      if (systemdBindHost === '0.0.0.0') {
        options.out('Configured WSL2 NAT access through Windows http://127.0.0.1:8137.');
      }
    } else {
      mkdirSync(launchAgentDir, { recursive: true });
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      chmodSync(logDir, 0o700);
      const launchAgent = renderLaunchAgent({
        dataDir,
        logDir,
        nodePath,
        repoRoot,
        servicePath,
        token,
      });
      writeFileSync(launchAgentPath, launchAgent, { encoding: 'utf8', mode: 0o600 });
      chmodSync(launchAgentPath, 0o600);
      options.out(`Installed ${LAUNCH_AGENT_LABEL} with Node ${nodePath}.`);
    }
  }

  const startPrompt = platform === 'linux'
    ? 'Reload systemd and enable codor.service now?'
    : `Load and start ${LAUNCH_AGENT_LABEL} now?`;
  if (await confirm(startPrompt)) {
    if (platform === 'linux') {
      exec('systemctl', ['--user', 'daemon-reload']);
      exec('systemctl', ['--user', 'enable', '--now', 'codor.service']);
      options.out('codor.service is enabled and running.');
      try {
        const linger = exec('loginctl', ['show-user', options.env.USER ?? '', '-p', 'Linger', '--value']);
        if (linger.trim() !== 'yes') options.out(`For boot-time startup, run: loginctl enable-linger ${options.env.USER ?? '$USER'}`);
      } catch {
        options.out(`Check lingering for boot-time startup: loginctl enable-linger ${options.env.USER ?? '$USER'}`);
      }
    } else {
      try {
        exec('launchctl', ['bootout', launchTarget!]);
      } catch {
        // First install and an already-stopped agent both legitimately have nothing to boot out.
      }
      exec('launchctl', ['bootstrap', launchDomain!, launchAgentPath]);
      exec('launchctl', ['enable', launchTarget!]);
      exec('launchctl', ['kickstart', '-k', launchTarget!]);
      options.out(`${LAUNCH_AGENT_LABEL} is loaded and running.`);
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
// harn:end cli-setup-wizard-installs-platform-user-service
