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
import { dirname, join, resolve, isAbsolute } from 'node:path';

import { CryptoVault, pairingUrl } from '@codor/switchboard';

import { resolveRuntimePaths, type RuntimePaths } from './runtime-paths.js';
import {
  SetupSession,
  isInteractiveSetup,
  type SetupSessionStreams,
  type SetupStepDefinition,
} from './setup-session.js';
import { SETUP_STAGE_TITLES } from './setup-ui.js';
import { renderTerminalQr } from './terminal-qr.js';

const HARNESSES = ['claude', 'codex', 'opencode', 'gemini', 'copilot', 'cursor-agent', 'agy'] as const;
const LAUNCH_AGENT_LABEL = 'app.codor.switchboard';

export interface SetupOverrides {
  exec?(command: string, args: string[]): string;
  home?: string;
  kernelRelease?: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
  randomToken?(): string;
  renderQr?(payload: string): string;
  repoRoot?: string;
  probe?(endpoint: string): Promise<boolean>;
  sleep?(milliseconds: number): Promise<void>;
  streams?: SetupSessionStreams;
  uid?: number;
  version?: string;
  which?(command: string): string | undefined;
}

export type SetupAccess = 'localhost' | 'tailscale';

export interface SetupOptions {
  access?: SetupAccess;
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  overrides?: SetupOverrides;
  yes?: boolean;
}

const defaultExec = (command: string, args: string[]): string => execFileSync(command, args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

const defaultWhich = (command: string): string | undefined => {
  try {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    return defaultExec(locator, [command]).split(/\r?\n/)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
};

function uniquePath(parts: Array<string | undefined>, delimiter = ':'): string {
  return [...new Set(parts.flatMap((part) => part?.split(delimiter) ?? []).filter(Boolean))]
    .join(delimiter);
}

// harn:assume wsl-setup-keeps-private-windows-loopback ref=wsl-bind-selection
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
// harn:end wsl-setup-keeps-private-windows-loopback

function systemdQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('codor setup paths cannot contain control characters');
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')}"`;
}

function systemdPath(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('codor setup paths cannot contain control characters');
  return value.replaceAll('%', '%%');
}

interface SystemdUnitOptions {
  dataDir: string;
  envPath: string;
  host: '127.0.0.1' | '0.0.0.0';
  nodePath: string;
  runtime: RuntimePaths;
}

function renderSystemdUnit(template: string, options: SystemdUnitOptions): string {
  const args = [
    options.nodePath,
    options.runtime.cliEntrypoint,
    '--data-dir',
    options.dataDir,
    'up',
    ...(options.host === '0.0.0.0' ? ['--host', options.host] : []),
    '--static-root',
    options.runtime.staticRoot,
    '--channel',
    'desk',
    '--channel-name',
    'Desk',
  ];
  const rendered = template
    .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${systemdPath(options.runtime.root)}`)
    .replace(/^EnvironmentFile=.*$/m, `EnvironmentFile=${systemdPath(options.envPath)}`)
    .replace(/^ExecStart=.*$/m, `ExecStart=${args.map(systemdQuote).join(' ')}`);
  if (rendered === template || rendered.includes('%h/codor')) {
    throw new Error('codor setup could not render the systemd service for the invoking runtime');
  }
  return rendered;
}

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
  runtime: RuntimePaths;
  servicePath: string;
  token: string;
}

// harn:assume operator-launches-serve-web-next ref=launchd-current-web-client
function renderLaunchAgent(options: LaunchAgentOptions): string {
  const values = {
    dataDir: xml(options.dataDir),
    entrypoint: xml(options.runtime.cliEntrypoint),
    errorLog: xml(join(options.logDir, 'codor.err.log')),
    nodePath: xml(options.nodePath),
    outputLog: xml(join(options.logDir, 'codor.log')),
    repoRoot: xml(options.runtime.root),
    servicePath: xml(options.servicePath),
    staticRoot: xml(options.runtime.staticRoot),
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

export interface LaunchAgentBootstrap {
  exec(command: string, args: string[]): string;
  probe(endpoint: string): Promise<boolean>;
  sleep(milliseconds: number): Promise<void>;
  domain: string;
  target: string;
  plistPath: string;
  nodePath: string;
  endpoint: string;
  log(message: string): void;
}

// harn:assume setup-macos-launchd-recovers-from-transient-bootstrap ref=launchd-bootstrap-recovery
/**
 * Bootstrap the per-user LaunchAgent, recovering from a transient
 * `Bootstrap failed: 5: Input/output error`. Codor's HTTP health is
 * authoritative: a bootstrap error against an already-answering daemon is not a
 * failure and the daemon is not restarted. Never suggests root.
 */
export async function bootstrapLaunchAgent(deps: LaunchAgentBootstrap): Promise<void> {
  const { exec, probe, sleep, domain, target, plistPath, nodePath, endpoint, log } = deps;
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 500;

  // Validate before unloading anything, so a broken install never tears down a
  // working prior instance. The plist must exist; the executable it points at
  // must be an absolute path (its existence is the operator's macOS, not this
  // host's, so it is not stat-ed here).
  if (!existsSync(plistPath)) throw new Error(`the LaunchAgent plist is missing at ${plistPath}`);
  if (!isAbsolute(nodePath)) throw new Error(`the LaunchAgent Node path must be absolute, got ${nodePath}`);

  const bootout = (): void => { try { exec('launchctl', ['bootout', target]); } catch { /* not loaded */ } };
  const printSummary = (): string => {
    try {
      const printed = exec('launchctl', ['print', target]).trim();
      const line = printed.split('\n').map((entry) => entry.trim()).find((entry) => entry.length > 0);
      return line === undefined ? '' : ` (launchctl print: ${line})`;
    } catch { return ''; }
  };

  bootout();
  let bootstrapped = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      exec('launchctl', ['bootstrap', domain, plistPath]);
      bootstrapped = true;
      break;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).split('\n')[0]!.trim();
      // API health decides whether this error matters, not launchctl's exit code.
      if (await probe(endpoint)) {
        log('Codor was already loaded and healthy; keeping it running');
        return;
      }
      const retryable = /input\/output error|bootstrap failed: 5\b/i.test(message);
      if (attempt >= MAX_ATTEMPTS || !retryable) {
        throw new Error(`launchctl could not start the Codor LaunchAgent: ${message}${printSummary()}`);
      }
      log(`launchctl bootstrap did not take (attempt ${String(attempt)}); unloading and retrying`);
      bootout();
      await sleep(RETRY_DELAY_MS);
    }
  }
  if (bootstrapped) {
    exec('launchctl', ['enable', target]);
    exec('launchctl', ['kickstart', '-k', target]);
  }
}
// harn:end setup-macos-launchd-recovers-from-transient-bootstrap

// harn:assume windows-setup-installs-private-task-service ref=windows-service-rendering
export function renderWindowsServiceScript(options: {
  dataDir: string;
  logDir: string;
  nodePath: string;
  runtime: RuntimePaths;
  servicePath: string;
  tokenPath: string;
}): string {
  const quote = (value: string): string => value.replaceAll("'", "''");
  const entrypoint = options.runtime.cliEntrypoint;
  const staticRoot = options.runtime.staticRoot;
  return [
    `$env:CODOR_TOKEN = (Get-Content -Raw -Path '${quote(options.tokenPath)}').Trim()`,
    `$env:PATH = '${quote(options.servicePath)}'`,
    `Set-Location -Path '${quote(options.runtime.root)}'`,
    `& '${quote(options.nodePath)}' '${quote(entrypoint)}' --data-dir '${quote(options.dataDir)}' up --static-root '${quote(staticRoot)}' --channel desk --channel-name Desk >> '${quote(join(options.logDir, 'codor.out.log'))}' 2>> '${quote(join(options.logDir, 'codor.err.log'))}'`,
    'exit $LASTEXITCODE',
  ].join('\r\n') + '\r\n';
}

export function renderWindowsScheduledTask(options: {
  scriptPath: string;
  user: string;
}): string {
  const command = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${options.scriptPath}"`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(options.user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(options.user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority></Settings>
  <Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>${xml(command)}</Arguments></Exec></Actions>
</Task>
`;
}
// harn:end windows-setup-installs-private-task-service

export async function probeCodorStatus(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/api/pairing/status', endpoint), {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const body = await response.json() as { trusted_enrollment?: unknown };
    return typeof body.trusted_enrollment === 'boolean';
  } catch {
    return false;
  }
}

const defaultSleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

// harn:assume setup-verifies-codor-before-creating-pairing-code ref=setup-readiness-and-pairing
export async function waitForCodor(
  endpoint: string,
  probe: (value: string) => Promise<boolean>,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    if (await probe(endpoint)) return;
    if (attempt < 20) await sleep(250);
  }
  throw new Error(`Codor did not become ready at ${endpoint}; inspect the user-service logs`);
}
// harn:end setup-verifies-codor-before-creating-pairing-code

function runtimeVersion(runtime: RuntimePaths): string {
  const manifestPath = runtime.layout === 'installed-package'
    ? join(runtime.root, 'package.json')
    : join(runtime.root, 'packages', 'cli', 'package.json');
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : 'dev';
  } catch {
    return 'dev';
  }
}

// harn:assume windows-setup-installs-private-task-service ref=windows-setup-runtime
// harn:assume setup-preserves-private-platform-service ref=setup-platform-service-runtime
export async function runSetup(options: SetupOptions): Promise<void> {
  const overrides = options.overrides ?? {};
  const platform = overrides.platform ?? process.platform;
  if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`codor setup supports Linux, macOS, and Windows; received ${platform}`);
  }
  const runtime = resolveRuntimePaths({ repoRoot: overrides.repoRoot });
  const home = resolve(overrides.home ?? options.env.HOME ?? homedir());
  const nodePath = resolve(overrides.nodePath ?? process.execPath);
  const exec = overrides.exec ?? defaultExec;
  const which = overrides.which ?? defaultWhich;
  const renderQr = overrides.renderQr ?? renderTerminalQr;
  const probe = overrides.probe ?? probeCodorStatus;
  const sleep = overrides.sleep ?? defaultSleep;
  const configDir = join(home, '.config', 'codor');
  const dataDir = join(home, '.codor');
  const tokenPath = join(configDir, 'token');
  const envPath = join(configDir, 'env');
  const userUnitDir = join(home, '.config', 'systemd', 'user');
  const userUnitPath = join(userUnitDir, 'codor.service');
  const launchAgentDir = join(home, 'Library', 'LaunchAgents');
  const launchAgentPath = join(launchAgentDir, `${LAUNCH_AGENT_LABEL}.plist`);
  const logDir = join(dataDir, 'logs');
  const windowsScriptPath = join(configDir, 'codor-service.ps1');
  const windowsTaskPath = join(configDir, 'codor-task.xml');
  const windowsUser = options.env.USERNAME ?? options.env.USER;
  if (platform === 'win32' && !windowsUser) {
    throw new Error('codor setup could not determine the Windows user name');
  }

  const detected = HARNESSES.flatMap((harness) => {
    const path = which(harness);
    return path === undefined ? [] : [{ harness, path }];
  });
  const tailscalePath = which('tailscale');
  const servicePath = uniquePath([
    join(home, '.local', 'bin'),
    dirname(nodePath),
    ...detected.map(({ path }) => dirname(path)),
    options.env.PATH,
  ], platform === 'win32' ? ';' : ':');
  const systemdBindHost = platform === 'linux'
    ? wslSystemdBindHost(options.env, overrides.kernelRelease ?? release(), exec, which)
    : '127.0.0.1';
  const unitContent = platform === 'linux'
    ? renderSystemdUnit(readFileSync(runtime.serviceTemplate, 'utf8'), {
      dataDir, envPath, host: systemdBindHost, nodePath, runtime,
    })
    : undefined;
  const launchUid = platform === 'darwin'
    ? overrides.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined)
    : undefined;
  if (platform === 'darwin' && (!Number.isInteger(launchUid) || launchUid! < 0)) {
    throw new Error('codor setup could not determine the macOS user id');
  }
  const launchDomain = launchUid === undefined ? undefined : `gui/${String(launchUid)}`;
  const launchTarget = launchDomain === undefined ? undefined : `${launchDomain}/${LAUNCH_AGENT_LABEL}`;
  const windowsScript = platform === 'win32'
    ? renderWindowsServiceScript({ dataDir, logDir, nodePath, runtime, servicePath, tokenPath })
    : undefined;
  const windowsTask = platform === 'win32'
    ? renderWindowsScheduledTask({ scriptPath: windowsScriptPath, user: windowsUser! })
    : undefined;

  // harn:assume setup-unattended-mutation-requires-explicit-intent ref=setup-unattended-runtime
  const interactive = !options.dryRun && options.yes !== true && isInteractiveSetup(overrides.streams);
  if (!options.dryRun && !interactive) {
    if (options.yes !== true) {
      throw new Error('non-interactive setup requires --yes and --access <localhost|tailscale>');
    }
    if (options.access === undefined) {
      throw new Error('non-interactive setup with --yes also requires --access <localhost|tailscale>');
    }
  }
  // harn:end setup-unattended-mutation-requires-explicit-intent

  // harn:assume setup-dry-run-reports-without-mutation-or-secret ref=setup-dry-run-runtime
  if (options.dryRun) {
    const access = options.access ?? 'localhost';
    if (access === 'tailscale' && tailscalePath === undefined) {
      throw new Error('--access tailscale requires the tailscale CLI on PATH');
    }
    options.out(`[dry-run] create ${configDir} and ${dataDir} mode 700; create ${tokenPath} mode 600 if absent`);
    if (platform === 'linux') {
      options.out(`[dry-run] install ${runtime.serviceTemplate} -> ${userUnitPath} mode 600`);
      options.out('[dry-run] unit content:');
      for (const line of unitContent!.trimEnd().split('\n')) options.out(line);
      options.out(`[dry-run] write ${envPath} mode 600`);
      options.out('CODOR_TOKEN=<redacted generated-or-existing token>');
      options.out(`PATH=${servicePath}`);
      options.out('[dry-run] systemctl --user daemon-reload');
      options.out('[dry-run] systemctl --user enable --now codor.service');
    } else if (platform === 'darwin') {
      const launchAgent = renderLaunchAgent({
        dataDir, logDir, nodePath, runtime, servicePath,
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
    } else {
      options.out(`[dry-run] protect ${tokenPath} for ${windowsUser} with icacls`);
      options.out(`[dry-run] create ${logDir}`);
      options.out(`[dry-run] install generated ServiceScript -> ${windowsScriptPath}`);
      for (const line of windowsScript!.trimEnd().split(/\r?\n/)) options.out(line);
      options.out(`[dry-run] install generated ScheduledTaskXml -> ${windowsTaskPath} as UTF-16LE`);
      for (const line of windowsTask!.trimEnd().split('\n')) options.out(line);
      options.out(`[dry-run] schtasks /Create /TN "Codor Switchboard" /XML "${windowsTaskPath}" /F`);
      options.out('[dry-run] schtasks /Run /TN "Codor Switchboard"');
    }
    if (access === 'tailscale') {
      options.out('[dry-run] tailscale serve --bg http://127.0.0.1:8137');
      options.out('[dry-run] tailscale serve status');
    } else {
      options.out('[dry-run] access localhost; skip Tailscale Serve');
    }
    options.out('[dry-run] wait for Codor pairing status, then generate a ten-minute QR, URL, and pairing code');
    return;
  }
  // harn:end setup-dry-run-reports-without-mutation-or-secret

  const version = overrides.version ?? runtimeVersion(runtime);
  const stepTitles = SETUP_STAGE_TITLES;

  // Shared state the steps thread through. `pairing` and `serviceStarted` are
  // memoized so a Retry re-runs the step's work idempotently: the daemon is not
  // restarted and the pairing code is not re-minted.
  let endpoint = 'http://127.0.0.1:8137';
  let selectedAccess: SetupAccess | undefined = options.access;
  let pairing: { code: string; expires: string; qr: string; url: string } | undefined;
  let serviceStarted = false;

  const checkStep = (log: (message: string) => void): string => {
    log(`${platform} with Node ${process.versions.node}`);
    log(detected.length > 0
      ? `found ${detected.map(({ harness }) => harness).join(', ')}`
      : 'no supported coding agents detected');
    log(tailscalePath === undefined ? 'Tailscale not detected' : 'Tailscale detected');
    return detected.length > 0
      ? `${platform}; ${detected.map(({ harness }) => harness).join(', ')}`
      : `${platform}; no agents on PATH`;
  };

  const prepareStep = (log: (message: string) => void): string => {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (!existsSync(tokenPath)) {
      const token = overrides.randomToken?.() ?? randomBytes(32).toString('hex');
      writeFileSync(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
    if (platform === 'win32') exec('icacls', [tokenPath, '/inheritance:r', '/grant:r', `${windowsUser}:F`]);
    else {
      chmodSync(configDir, 0o700);
      chmodSync(dataDir, 0o700);
      chmodSync(tokenPath, 0o600);
    }
    log('private configuration and data are ready');
    return 'config and mode-600 token ready';
  };

  const chooseStep = (log: (message: string) => void, choice: string | undefined): string => {
    if (choice !== 'localhost' && choice !== 'tailscale') throw new Error('setup requires an access choice');
    if (choice === 'tailscale' && tailscalePath === undefined) {
      throw new Error('--access tailscale requires the tailscale CLI on PATH');
    }
    selectedAccess = choice;
    log(choice === 'localhost' ? 'localhost only' : 'private Tailscale Serve');
    return choice === 'localhost' ? 'Localhost' : 'Tailscale Serve';
  };

  const startStep = async (log: (message: string) => void): Promise<string> => {
    // A Retry must not reinstall or restart a daemon that is already up; when
    // the service was started this run and still answers, short-circuit.
    if (serviceStarted && await probe(endpoint)) {
      log('Codor is already running; reusing it');
      return 'service already running';
    }
    if (!existsSync(tokenPath)) throw new Error(`operator token is missing at ${tokenPath}`);
    serviceStarted = true;
    if (platform === 'linux') {
      const token = readFileSync(tokenPath, 'utf8').trim();
      mkdirSync(userUnitDir, { recursive: true, mode: 0o700 });
      writeFileSync(userUnitPath, unitContent!, { encoding: 'utf8', mode: 0o600 });
      chmodSync(userUnitPath, 0o600);
      writeFileSync(envPath, `CODOR_TOKEN=${token}\nPATH=${servicePath}\n`, { encoding: 'utf8', mode: 0o600 });
      chmodSync(envPath, 0o600);
      exec('systemctl', ['--user', 'daemon-reload']);
      exec('systemctl', ['--user', 'enable', '--now', 'codor.service']);
      try {
        const linger = exec('loginctl', ['show-user', options.env.USER ?? '', '-p', 'Linger', '--value']);
        if (linger.trim() !== 'yes') log(`for boot startup: loginctl enable-linger ${options.env.USER ?? '$USER'}`);
      } catch {
        log(`check lingering: loginctl enable-linger ${options.env.USER ?? '$USER'}`);
      }
    } else if (platform === 'darwin') {
      const token = readFileSync(tokenPath, 'utf8').trim();
      mkdirSync(launchAgentDir, { recursive: true });
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      chmodSync(logDir, 0o700);
      writeFileSync(launchAgentPath, renderLaunchAgent({
        dataDir, logDir, nodePath, runtime, servicePath, token,
      }), { encoding: 'utf8', mode: 0o600 });
      chmodSync(launchAgentPath, 0o600);
      await bootstrapLaunchAgent({
        exec, probe, sleep,
        domain: launchDomain!,
        target: launchTarget!,
        plistPath: launchAgentPath,
        nodePath,
        endpoint,
        log,
      });
    } else {
      mkdirSync(logDir, { recursive: true });
      writeFileSync(windowsScriptPath, windowsScript!, 'utf8');
      writeFileSync(windowsTaskPath, Buffer.from(`﻿${windowsTask!}`, 'utf16le'));
      exec('schtasks', ['/Create', '/TN', 'Codor Switchboard', '/XML', windowsTaskPath, '/F']);
      exec('schtasks', ['/Run', '/TN', 'Codor Switchboard']);
    }
    await waitForCodor(endpoint, probe, sleep);
    log('Codor answered its pairing status check');
    if (systemdBindHost === '0.0.0.0') log('WSL2 NAT is reachable through Windows localhost');
    if (selectedAccess === 'tailscale') {
      exec('tailscale', ['serve', '--bg', endpoint]);
      const status = exec('tailscale', ['serve', 'status']);
      endpoint = status.match(/https:\/\/[^\s/]+/)?.[0]
        ?? (() => { throw new Error('Tailscale Serve did not report a private HTTPS origin'); })();
      log(`private browser origin ${endpoint}`);
    }
    return 'service enabled and answering';
  };

  const pairStep = (log: (message: string) => void): string => {
    if (pairing === undefined) {
      const crypto = new CryptoVault(dataDir);
      try {
        const offer = crypto.pairing.issue(endpoint);
        const url = pairingUrl(offer);
        pairing = { code: offer.pairing_code, expires: offer.expires_at, qr: renderQr(url), url };
      } finally {
        crypto.close();
      }
    }
    log(`pairing code ${pairing.code}`);
    return `code ${pairing.code}`;
  };

  const emitPairing = (): void => {
    options.out(pairing!.qr);
    options.out(pairing!.url);
    options.out(`code: ${pairing!.code}`);
    options.out(`expires ${pairing!.expires}`);
  };

  if (interactive) {
    const session = new SetupSession({ version, streams: overrides.streams });
    const steps: SetupStepDefinition[] = [
      { title: stepTitles[0], run: async ({ log }) => checkStep(log) },
      { title: stepTitles[1], run: async ({ log }) => prepareStep(log) },
      {
        title: stepTitles[2],
        menu: {
          message: 'Choose how you will reach Codor.',
          options: [
            { id: 'localhost', label: 'Localhost', description: 'This computer only.', available: true },
            { id: 'tailscale', label: 'Tailscale Serve', description: 'Private access from your tailnet.', available: tailscalePath !== undefined },
          ],
        },
        run: async ({ log, choice }) => chooseStep(log, choice),
      },
      { title: stepTitles[3], run: async ({ log }) => startStep(log) },
      { title: stepTitles[4], run: async ({ log }) => pairStep(log) },
    ];
    await session.run(steps);
    const nextAction = `Enter ${pairing!.code} in your browser or scan the QR.`;
    session.finish({ endpoint, harnesses: detected.map(({ harness }) => harness), nextAction });
    emitPairing();
  } else {
    const linear = (index: number) => (message: string): void => options.out(`[${String(index + 1)}/5] ${message}`);
    options.out(`[1/5] ${stepTitles[0]}`); checkStep(linear(0));
    options.out(`[2/5] ${stepTitles[1]}`); prepareStep(linear(1));
    options.out(`[3/5] ${stepTitles[2]}`); chooseStep(linear(2), options.access);
    options.out(`[4/5] ${stepTitles[3]}`); await startStep(linear(3));
    options.out(`[5/5] ${stepTitles[4]}`); pairStep(linear(4));
    emitPairing();
  }
}
// harn:end setup-preserves-private-platform-service
// harn:end windows-setup-installs-private-task-service
