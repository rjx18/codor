import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { CryptoVault, RelayStore, pairingUrl, type PairingOffer } from '@codor/switchboard';

import { packageRuntimePaths, resolveRuntimePaths, type RuntimePaths } from './runtime-paths.js';
import {
  defaultInstallIo,
  detectInstalledRuntime,
  durableRuntimeLocation,
  finalizeDurableRuntimeInstall,
  installDurableRuntime,
  installedCliRoot,
  rollbackDurableRuntimeInstall,
  resolveInstallSource,
  type InstallIntent,
  type InstallIo,
} from './runtime-install.js';
import {
  SetupSession,
  isInteractiveSetup,
  type SetupSessionStreams,
  type SetupStepDefinition,
} from './setup-session.js';
import { SETUP_STAGE_TITLES, renderPairingCard, type SetupAccessOption } from './setup-ui.js';
import { renderTerminalQr } from './terminal-qr.js';
import { copyToClipboard } from './clipboard.js';
import { defaultLauncherIo, installLauncher, type LauncherIo } from './launcher-install.js';

const HARNESSES = ['claude', 'codex', 'opencode', 'gemini', 'copilot', 'cursor-agent', 'agy'] as const;
const LAUNCH_AGENT_LABEL = 'app.codor.switchboard';

/**
 * Canonical operator config directory (~/.config/codor). The SINGLE source for
 * the installed-service paths — setup and any CLI command that reads them must
 * derive from here so the two can never drift.
 */
export function operatorConfigDir(home: string = homedir()): string {
  return join(home, '.config', 'codor');
}

/** Canonical operator token file (mode-0600, written by setup). */
export function operatorTokenPath(home: string = homedir()): string {
  return join(operatorConfigDir(home), 'token');
}

// harn:assume setup-bounds-tailscale-serve-consent-and-keeps-diagnostics-actionable ref=tailscale-exec-override-seam
export interface SetupOverrides {
  exec?(command: string, args: string[], options?: { timeoutMs?: number }): string;
  exists?(path: string): boolean;
  home?: string;
  kernelRelease?: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
  randomToken?(): string;
  renderQr?(payload: string): string;
  repoRoot?: string;
  probe?(endpoint: string): Promise<boolean>;
  runtimeStatus?(endpoint: string, token: string): Promise<{ version: string; generation: string } | undefined>;
  generation?(): string;
  runtime?: RuntimePaths;
  installIo?: InstallIo;
  launcherIo?: LauncherIo;
  /** Mint the first code universally through the running daemon's offers API;
   *  resolves undefined to degrade to a local-only code. Injectable for tests. */
  relayOffer?(args: { localEndpoint: string; endpoint: string; token: string }): Promise<PairingOffer | undefined>;
  sleep?(milliseconds: number): Promise<void>;
  streams?: SetupSessionStreams;
  uid?: number;
  version?: string;
  which?(command: string): string | undefined;
}
// harn:end setup-bounds-tailscale-serve-consent-and-keeps-diagnostics-actionable

export type SetupAccess = 'localhost' | 'tailscale';

export interface SetupOptions {
  access?: SetupAccess;
  dataDir?: string;
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
  /** Opt out of relay-on-by-default: mint a local-only code and leave the relay off. */
  noRelay?: boolean;
  out(line: string): void;
  overrides?: SetupOverrides;
  yes?: boolean;
  /** Candidate-only application path. It installs/restarts/verifies without
   * running onboarding, access selection, relay mutation, or pairing. */
  updateOnly?: { expectedVersion: string };
}

// harn:assume setup-bounds-tailscale-serve-consent-and-keeps-diagnostics-actionable ref=tailscale-default-exec-timeout
const defaultExec = (
  command: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): string => execFileSync(command, args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
}).trim();
// harn:end setup-bounds-tailscale-serve-consent-and-keeps-diagnostics-actionable

const defaultWhich = (command: string): string | undefined => {
  try {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    return defaultExec(locator, [command]).split(/\r?\n/)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
};

/** Mint the first code universally through the running daemon — the ONE mint path
 *  `codor pair` uses (relay-status gate → offers). Returns undefined to degrade to a
 *  local-only code (relay off/unreachable), which the caller then mints locally. */
async function defaultRelayOffer(args: { localEndpoint: string; endpoint: string; token: string }): Promise<PairingOffer | undefined> {
  const auth = { authorization: `Bearer ${args.token}` };
  try {
    const status = await fetch(`${args.localEndpoint}/api/relay/status`, { headers: auth });
    if (!status.ok || ((await status.json()) as { enabled?: boolean }).enabled !== true) return undefined;
    const offer = await fetch(`${args.localEndpoint}/api/pairing/offers`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: args.endpoint }),
    });
    return offer.ok ? ((await offer.json()) as PairingOffer) : undefined;
  } catch {
    return undefined; // any failure degrades to a local-only code, never a hard failure
  }
}

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
  nodeModulePath?: string;
  nodePath: string;
  runtime: RuntimePaths;
  servicePath: string;
  token: string;
  runtimeVersion: string;
  serviceGeneration: string;
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
    runtimeVersion: xml(options.runtimeVersion),
    serviceGeneration: xml(options.serviceGeneration),
  };
  // harn:assume platform-services-propagate-destination-pnpm-node-path ref=node-path-launchd-emission
  const nodeModulePathEntry = options.nodeModulePath === undefined
    ? ''
    : `\n    <key>NODE_PATH</key>\n    <string>${xml(options.nodeModulePath)}</string>`;
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
    <key>CODOR_RUNTIME_VERSION</key>
    <string>${values.runtimeVersion}</string>
    <key>CODOR_SERVICE_GENERATION</key>
    <string>${values.serviceGeneration}</string>
    <key>PATH</key>
    <string>${values.servicePath}</string>${nodeModulePathEntry}
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
  // harn:end platform-services-propagate-destination-pnpm-node-path
}
// harn:end operator-launches-serve-web-next

export interface LaunchAgentBootstrap {
  exec(command: string, args: string[]): string;
  probe(endpoint: string): Promise<boolean>;
  sleep(milliseconds: number): Promise<void>;
  exists?(path: string): boolean;
  domain: string;
  target: string;
  plistPath: string;
  nodePath: string;
  cliEntrypoint: string;
  endpoint: string;
  log(message: string): void;
}

/** The full launchctl error text and whether it is the transient exit-5. */
function classifyBootstrapError(error: unknown): { text: string; retryable: boolean } {
  const err = error as { message?: string; stderr?: string | Buffer; status?: number };
  const text = [err.message, err.stderr?.toString()].filter(Boolean).join('\n').trim();
  const retryable = err.status === 5 || /input\/output error|bootstrap failed:\s*5\b/i.test(text);
  return { text, retryable };
}

// harn:assume setup-macos-launchd-confirms-loaded-and-healthy ref=launchd-bootstrap-recovery
/**
 * Bootstrap the per-user LaunchAgent, recovering from a transient
 * `Bootstrap failed: 5: Input/output error` (which arrives with the retryable
 * text on a later line and exit status 5). Continues past a bootstrap error
 * only when `launchctl print` confirms the target is loaded AND the HTTP probe
 * answers — a briefly-answering booted-out orphan is not success. Never
 * suggests root.
 */
export async function bootstrapLaunchAgent(deps: LaunchAgentBootstrap): Promise<void> {
  const { exec, probe, sleep, domain, target, plistPath, nodePath, cliEntrypoint, endpoint, log } = deps;
  const exists = deps.exists ?? existsSync;
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 500;
  const STATE_ATTEMPTS = 10;

  // Validate before unloading anything, so a broken install never tears down a
  // working prior instance: the plist parses, and the executables it references
  // exist.
  if (!existsSync(plistPath)) throw new Error(`the LaunchAgent plist is missing at ${plistPath}`);
  try {
    exec('plutil', ['-lint', plistPath]);
  } catch (error) {
    throw new Error(`the LaunchAgent plist did not pass plutil -lint: ${classifyBootstrapError(error).text.split('\n')[0]}`);
  }
  if (!exists(nodePath)) throw new Error(`the LaunchAgent Node executable does not exist at ${nodePath}`);
  if (!exists(cliEntrypoint)) throw new Error(`the Codor CLI entrypoint does not exist at ${cliEntrypoint}`);

  const bootout = (): void => { try { exec('launchctl', ['bootout', target]); } catch { /* not loaded */ } };
  // `launchctl print <target>` exits non-zero when the target is not loaded.
  const printState = (): { loaded: boolean; summary: string } => {
    try {
      const printed = exec('launchctl', ['print', target]).trim();
      const line = printed.split('\n').map((entry) => entry.trim()).find((entry) => entry.length > 0);
      return { loaded: true, summary: line === undefined ? '' : ` (launchctl print: ${line})` };
    } catch {
      return { loaded: false, summary: ' (launchctl print: target not loaded)' };
    }
  };

  const waitUntilAbsent = async (): Promise<void> => {
    for (let attempt = 0; attempt < STATE_ATTEMPTS; attempt += 1) {
      if (!printState().loaded) return;
      await sleep(RETRY_DELAY_MS);
    }
    throw new Error('launchctl did not unload the previous Codor LaunchAgent within the bounded wait');
  };

  const waitUntilHealthy = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < STATE_ATTEMPTS; attempt += 1) {
      if (!printState().loaded) return false;
      if (await probe(endpoint)) return true;
      await sleep(RETRY_DELAY_MS);
    }
    return false;
  };

  // harn:assume setup-proves-selected-runtime-before-reuse ref=launchd-stateful-convergence
  bootout();
  await waitUntilAbsent();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      exec('launchctl', ['bootstrap', domain, plistPath]);
      exec('launchctl', ['enable', target]);
      return; // RunAtLoad owns the one start; do not kill it with kickstart -k.
    } catch (error) {
      const { text, retryable } = classifyBootstrapError(error);
      const state = printState();
      if (state.loaded) {
        log('Codor is loaded and still booting; waiting for readiness');
        if (await waitUntilHealthy()) {
          exec('launchctl', ['enable', target]);
          return;
        }
      }
      if (attempt >= MAX_ATTEMPTS || !retryable) {
        throw new Error(`launchctl could not start the Codor LaunchAgent: ${text.split('\n').find((line) => line.trim().length > 0) ?? text}${state.summary}`);
      }
      log(`launchctl bootstrap did not take (attempt ${String(attempt)}); unloading and retrying`);
      bootout();
      await waitUntilAbsent();
    }
  }
  // harn:end setup-proves-selected-runtime-before-reuse
}
// harn:end setup-macos-launchd-confirms-loaded-and-healthy

const TAILSCALE_MACOS_LOCATIONS = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
] as const;

// harn:assume setup-resolves-and-capability-probes-tailscale-serve ref=tailscale-resolution
/** Resolve the Tailscale CLI through PATH, then standard macOS app locations. */
export function resolveTailscale(
  which: (command: string) => string | undefined,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  // Normalize the PATH hit to the absolute executable path actually invoked.
  const onPath = which('tailscale');
  if (onPath !== undefined && onPath.trim() !== '') return resolve(onPath.trim());
  if (platform === 'darwin') {
    for (const location of TAILSCALE_MACOS_LOCATIONS) if (exists(location)) return location;
  }
  return undefined;
}

/** Capability-probe the resolved CLI for Serve support (not an OS allowlist). */
export function tailscaleServeSupported(
  tailscalePath: string,
  exec: (command: string, args: string[]) => string,
): boolean {
  try {
    exec(tailscalePath, ['serve', '--help']);
    return true;
  } catch {
    return false;
  }
}

// harn:assume setup-bounds-tailscale-serve-consent-and-keeps-diagnostics-actionable ref=tailscale-serve-consent-command
/** Publish Serve through the resolved absolute path and return the HTTPS origin.
 *  Throws a distinct diagnostic when the serve command itself fails. */
export function configureTailscaleServe(
  tailscalePath: string,
  localEndpoint: string,
  exec: (command: string, args: string[], options?: { timeoutMs?: number }) => string,
): string {
  // Preserve the full message, stdout, and stderr: real permission/operator
  // guidance often lands on a later line (the same class of bug fixed for
  // launchctl), and Tailscale's own consent/admin-console prompt for Serve is
  // printed to stdout rather than stderr. Node's command error often already
  // embeds stderr in `message`, so never append the same block twice.
  const diagnostic = (error: unknown): string => {
    const err = error as { message?: string; stderr?: string | Buffer; stdout?: string | Buffer };
    const message = err.message?.trim();
    const stderr = err.stderr?.toString().trim();
    const stdout = err.stdout?.toString().trim();
    const parts = message === undefined || message === '' ? [] : [message];
    if (stderr !== undefined && stderr !== '' && message?.includes(stderr) !== true) parts.push(stderr);
    if (stdout !== undefined && stdout !== '' && message?.includes(stdout) !== true) parts.push(stdout);
    return parts.join('\n').trim() || String(error);
  };
  let status: string;
  try {
    // Bounded: when the tailnet has no HTTPS certificates enabled, `serve --bg`
    // does not fail — it blocks waiting for interactive consent in a browser.
    // `serve status` never blocks this way, so only the first call gets a budget.
    exec(tailscalePath, ['serve', '--bg', localEndpoint], { timeoutMs: 20_000 });
    status = exec(tailscalePath, ['serve', 'status']);
  } catch (error) {
    throw new Error(`Tailscale Serve command failed: ${diagnostic(error)}`);
  }
  const origin = status.match(/https:\/\/[^\s/]+/)?.[0];
  if (origin === undefined) throw new Error('Tailscale Serve did not report a private HTTPS origin');
  return origin;
}
// harn:end setup-bounds-tailscale-serve-consent-and-keeps-diagnostics-actionable
// harn:end setup-resolves-and-capability-probes-tailscale-serve

export interface RemoteAccessDeps {
  /** The step-3 selection: 'remote' opts into the Tailscale sub-flow; anything
   *  else stays on this computer without inspecting Tailscale at all. */
  choice: string;
  localEndpoint: string;
  /** The OS: the operator recovery below is shown only on Linux/WSL. */
  platform: NodeJS.Platform;
  log: (message: string) => void;
  choose: (menu: { message: string; options: SetupAccessOption[] }) => Promise<string>;
  detect: () => { path: string | undefined; serve: boolean };
  resetDetect: () => void;
  /** Publish Serve and return the HTTPS origin; may throw. */
  configureServe: (tailscalePath: string) => string;
}

export interface RemoteAccessResult {
  access: SetupAccess;
  endpoint: string;
  summary: string;
}

const RETRY_OR_LOCAL: SetupAccessOption[] = [
  { id: 'retry', label: 'Retry detection', description: 'Check again for Tailscale.', available: true },
  { id: 'here', label: 'Continue on this computer', description: 'Skip remote access for now.', available: true },
];

const RETRY_OR_CONTINUE: SetupAccessOption[] = [
  { id: 'retry', label: 'Retry Tailscale Serve', description: 'Run Serve again after fixing the problem above.', available: true },
  { id: 'here', label: 'Continue on this computer', description: 'Use Codor locally and continue setup.', available: true },
];

// harn:assume setup-recovers-remote-access-with-one-clear-decision ref=setup-remote-access-subflow
/** A Serve failure is an operator/permission problem only on Linux/WSL (platform
 *  'linux'), where tailscaled runs as root and a non-root user must be granted
 *  operator rights. Unrelated errors must never be treated as a sudo problem. */
function isOperatorError(detail: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'linux') return false;
  return /operator|permission|denied|not authorized|unauthorized|must be run as root|EACCES/i.test(detail);
}

/** The persistent Serve-failure screen text: the real error, the exact resolved
 *  serve command, and — only for a Linux/WSL operator problem — the documented
 *  `sudo tailscale set --operator=$USER` recovery. sudo is never run here; the
 *  command is shown for the operator to run in another shell. */
function conciseServeDiagnostic(error: unknown): string[] {
  const detail = error instanceof Error ? error.message : String(error);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of detail.split(/\r?\n/)) {
    const line = raw.trim().replace(/^Tailscale Serve command failed:\s*/i, '');
    if (
      line === ''
      || /^Command failed:/i.test(line)
      || /^Use ['"]?sudo tailscale serve\b/i.test(line)
      || /^To not require root,/i.test(line)
      || seen.has(line)
    ) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

function serveFailureMessage(error: unknown, path: string, deps: RemoteAccessDeps): string {
  const detail = error instanceof Error ? error.message : String(error);
  const serveCommand = `${path} serve --bg ${deps.localEndpoint}`;
  const diagnostic = conciseServeDiagnostic(error);
  const lines: string[] = [];
  if (isOperatorError(detail, deps.platform)) {
    lines.push(
      'Tailscale needs permission to configure Serve.',
      'Run this once in another terminal (do not run Serve with sudo):',
      'sudo tailscale set --operator=$USER',
      'Then return here and choose Retry. It will run:',
      serveCommand,
    );
  } else {
    lines.push('Tailscale Serve could not be configured.', 'Retry will run:', serveCommand);
  }
  diagnostic.forEach((line, index) => lines.push(`${index === 0 ? 'Error: ' : '       '}${line}`));
  return lines.join('\n');
}

/**
 * Resolve interactive access. "This computer" never touches Tailscale. "Remote"
 * detects Tailscale only now, offers Retry/Continue-local when it is missing or
 * cannot Serve, and asks a separate consent before configuring Serve. A Serve
 * failure does not auto-degrade: it stays here, showing the real error and the
 * exact resolved serve command (plus the Linux/WSL operator recovery when the
 * error is a permission problem), and offers one clear Retry or local-only
 * decision. Purely a decision function: it mutates nothing but log.
 */
export async function runRemoteAccess(deps: RemoteAccessDeps): Promise<RemoteAccessResult> {
  const local = (note: string): RemoteAccessResult => {
    deps.log(note);
    return { access: 'localhost', endpoint: deps.localEndpoint, summary: 'This computer' };
  };
  if (deps.choice !== 'remote') return local('this computer only');

  for (;;) {
    const { path, serve } = deps.detect();
    if (path === undefined || !serve) {
      const message = path === undefined
        ? 'Tailscale is not installed. Install it from https://tailscale.com/download, then retry.'
        : 'This Tailscale CLI cannot Serve. Update Tailscale, then retry.';
      const next = await deps.choose({ message, options: RETRY_OR_LOCAL });
      if (next === 'retry') { deps.resetDetect(); continue; }
      return local('continuing on this computer only');
    }

    const consent = await deps.choose({
      message: 'Codor can configure Tailscale Serve so you can reach it securely from your other devices. Configure it now?',
      options: [
        { id: 'configure', label: 'Configure Tailscale Serve', description: 'Publish Codor privately to your tailnet.', available: true },
        { id: 'here', label: 'Just this computer', description: 'Keep Codor local for now.', available: true },
      ],
    });
    if (consent !== 'configure') return local('this computer only');

    // Configure Serve, and on failure stay here: show the real error and recovery
    // and let the operator Retry or choose the local-only fallback. A failure
    // never auto-degrades, sudo is never run automatically, and Continue is the
    // decision — it does not open a second confirmation screen.
    let attempt = 0;
    for (;;) {
      attempt += 1;
      deps.log(attempt === 1 ? 'configuring Tailscale Serve' : 'retrying Tailscale Serve');
      let failure: unknown;
      try {
        const endpoint = deps.configureServe(path);
        deps.log(`private browser origin ${endpoint}`);
        return { access: 'tailscale', endpoint, summary: 'Tailscale Serve' };
      } catch (error) {
        failure = error;
      }
      const next = await deps.choose({ message: serveFailureMessage(failure, path, deps), options: RETRY_OR_CONTINUE });
      if (next === 'retry') continue;
      deps.log('remote access deferred; Codor will stay on this computer');
      deps.log(`to finish remote access later, run: ${path} serve --bg ${deps.localEndpoint}`);
      return { access: 'localhost', endpoint: deps.localEndpoint, summary: 'This computer (remote access deferred)' };
    }
  }
}
// harn:end setup-recovers-remote-access-with-one-clear-decision

// harn:assume windows-setup-installs-private-task-service ref=windows-service-rendering
export function renderWindowsServiceScript(options: {
  dataDir: string;
  logDir: string;
  nodeModulePath?: string;
  nodePath: string;
  runtime: RuntimePaths;
  servicePath: string;
  tokenPath: string;
  runtimeVersion: string;
  serviceGeneration: string;
}): string {
  const quote = (value: string): string => value.replaceAll("'", "''");
  const entrypoint = options.runtime.cliEntrypoint;
  const staticRoot = options.runtime.staticRoot;
  // harn:assume platform-services-propagate-destination-pnpm-node-path ref=node-path-windows-emission
  return [
    `$env:CODOR_TOKEN = (Get-Content -Raw -Path '${quote(options.tokenPath)}').Trim()`,
    `$env:CODOR_RUNTIME_VERSION = '${quote(options.runtimeVersion)}'`,
    `$env:CODOR_SERVICE_GENERATION = '${quote(options.serviceGeneration)}'`,
    `$env:PATH = '${quote(options.servicePath)}'`,
    ...(options.nodeModulePath === undefined ? [] : [`$env:NODE_PATH = '${quote(options.nodeModulePath)}'`]),
    `Set-Location -Path '${quote(options.runtime.root)}'`,
    `& '${quote(options.nodePath)}' '${quote(entrypoint)}' --data-dir '${quote(options.dataDir)}' up --static-root '${quote(staticRoot)}' --channel desk --channel-name Desk >> '${quote(join(options.logDir, 'codor.out.log'))}' 2>> '${quote(join(options.logDir, 'codor.err.log'))}'`,
    'exit $LASTEXITCODE',
  ].join('\r\n') + '\r\n';
  // harn:end platform-services-propagate-destination-pnpm-node-path
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

// harn:assume setup-readiness-wait-is-wall-clock-bounded ref=readiness-probe-budget
export async function probeCodorStatus(
  endpoint: string,
  remainingMs = 1_000,
): Promise<boolean> {
  try {
    const timeoutMs = Math.floor(Math.max(0, Math.min(1_000, remainingMs)));
    const response = await fetch(new URL('/api/pairing/status', endpoint), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = await response.json() as { trusted_enrollment?: unknown };
    return typeof body.trusted_enrollment === 'boolean';
  } catch {
    return false;
  }
}
// harn:end setup-readiness-wait-is-wall-clock-bounded

async function probeRuntimeIdentity(
  endpoint: string,
  token: string,
): Promise<{ version: string; generation: string } | undefined> {
  try {
    const response = await fetch(new URL('/api/runtime/status', endpoint), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return undefined;
    const value = await response.json() as { version?: unknown; generation?: unknown };
    return typeof value.version === 'string' && typeof value.generation === 'string'
      ? { version: value.version, generation: value.generation }
      : undefined;
  } catch {
    return undefined;
  }
}

interface ServiceFileSnapshot {
  bytes?: Buffer;
  mode?: number;
  path: string;
}

function captureServiceFiles(paths: string[]): ServiceFileSnapshot[] {
  return paths.map((path) => existsSync(path)
    ? { path, bytes: readFileSync(path), mode: statSync(path).mode & 0o777 }
    : { path });
}

function restoreServiceFiles(snapshots: ServiceFileSnapshot[]): void {
  for (const snapshot of snapshots) {
    if (snapshot.bytes === undefined) {
      rmSync(snapshot.path, { force: true });
      continue;
    }
    mkdirSync(dirname(snapshot.path), { recursive: true });
    writeFileSync(snapshot.path, snapshot.bytes, { mode: snapshot.mode });
    if (snapshot.mode !== undefined) chmodSync(snapshot.path, snapshot.mode);
  }
}

const defaultSleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

// harn:assume setup-readiness-wait-is-wall-clock-bounded ref=readiness-wall-clock-deadline
const defaultMonotonicNow = (): number => performance.now();
const READINESS_BUDGET_MS = 60_000;
const READINESS_INITIAL_DELAY_MS = 250;
const READINESS_MAX_DELAY_MS = 1_000;

// harn:assume setup-verifies-codor-before-creating-pairing-code ref=setup-readiness-and-pairing
export async function waitForCodor(
  endpoint: string,
  probe: (value: string, remainingMs?: number) => Promise<boolean>,
  sleep: (milliseconds: number) => Promise<void>,
  monotonicNow: () => number = defaultMonotonicNow,
): Promise<void> {
  const startedAt = monotonicNow();
  let delayMs = READINESS_INITIAL_DELAY_MS;
  for (;;) {
    const remainingMs = READINESS_BUDGET_MS - (monotonicNow() - startedAt);
    if (remainingMs <= 0) break;
    const ready = await probe(endpoint, remainingMs);
    const elapsedMs = monotonicNow() - startedAt;
    if (ready && elapsedMs <= READINESS_BUDGET_MS) return;
    const remainingAfterProbeMs = READINESS_BUDGET_MS - elapsedMs;
    if (remainingAfterProbeMs <= 0) break;
    const wait = Math.min(delayMs, remainingAfterProbeMs);
    await sleep(wait);
    delayMs = Math.min(delayMs * 2, READINESS_MAX_DELAY_MS);
  }
  // harn:assume setup-readiness-wait-is-wall-clock-bounded ref=readiness-timeout-diagnostic
  throw new Error(
    `Codor did not answer its pairing-status check within the 60-second readiness budget at ${endpoint}; run \`codor channels\` and inspect the user-service logs`,
  );
  // harn:end setup-readiness-wait-is-wall-clock-bounded
}
// harn:end setup-verifies-codor-before-creating-pairing-code
// harn:end setup-readiness-wait-is-wall-clock-bounded

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
  const runtime = overrides.runtime ?? resolveRuntimePaths({ repoRoot: overrides.repoRoot });
  const home = resolve(overrides.home ?? options.env.HOME ?? homedir());
  const nodePath = resolve(overrides.nodePath ?? process.execPath);
  const exec = overrides.exec ?? defaultExec;
  const which = overrides.which ?? defaultWhich;
  const renderQr = overrides.renderQr ?? renderTerminalQr;
  const probe = overrides.probe ?? probeCodorStatus;
  const runtimeStatus = overrides.runtimeStatus ?? probeRuntimeIdentity;
  const nextGeneration = overrides.generation ?? randomUUID;
  const sleep = overrides.sleep ?? defaultSleep;
  const configDir = operatorConfigDir(home);
  const dataDir = resolve(options.dataDir ?? join(home, '.codor'));
  const tokenPath = operatorTokenPath(home);
  const envPath = join(configDir, 'env');
  const userUnitDir = join(home, '.config', 'systemd', 'user');
  const userUnitPath = join(userUnitDir, 'codor.service');
  const launchAgentDir = join(home, 'Library', 'LaunchAgents');
  const launchAgentPath = join(launchAgentDir, `${LAUNCH_AGENT_LABEL}.plist`);
  const logDir = join(dataDir, 'logs');
  // The service must reference a durable runtime. An ephemeral (npx/temp)
  // invoking runtime is copied to ~/.codor/runtime by the Install step; the
  // service is rendered against that stable copy, while the service template is
  // still read from the source runtime, which exists now.
  const version = overrides.version ?? runtimeVersion(runtime);
  const installIo = overrides.installIo ?? defaultInstallIo;
  const launcherIo = overrides.launcherIo ?? defaultLauncherIo;
  const relayOffer = overrides.relayOffer ?? defaultRelayOffer;
  const pathEntries = (options.env.PATH ?? '').split(platform === 'win32' ? ';' : ':').filter((entry) => entry !== '');
  const installSource = resolveInstallSource(runtime);
  const serviceLocation = installSource.durable ? installSource.installRoot : durableRuntimeLocation(dataDir);
  const serviceRuntime = installSource.durable ? runtime : packageRuntimePaths(installedCliRoot(serviceLocation));
  // harn:assume platform-services-propagate-destination-pnpm-node-path ref=node-path-source-destination-derivation
  // pnpm's hidden hoist directory sits at a fixed offset inside a pnpm-linked
  // tree and survives installDurableRuntime's wholesale node_modules copy.
  const hoistDirRelative = join('node_modules', '.pnpm', 'node_modules');
  const sourceHoistDir = join(installSource.installRoot, hoistDirRelative);
  const destinationHoistDir = join(serviceLocation, hoistDirRelative);
  // Probe the invoking source and an already-reused durable destination, then
  // emit only the destination path where the service will actually run.
  const nodeModulePath = installIo.exists(sourceHoistDir) || installIo.exists(destinationHoistDir)
    ? join(serviceLocation, hoistDirRelative)
    : undefined;
  // harn:end platform-services-propagate-destination-pnpm-node-path
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
  // Tailscale is inspected lazily: step 1 never touches it, and the interactive
  // remote sub-flow probes only after the operator chooses remote access.
  let tailscaleProbe: { path: string | undefined; serve: boolean } | undefined;
  const detectTailscale = (): { path: string | undefined; serve: boolean } => {
    if (tailscaleProbe === undefined) {
      const path = resolveTailscale(which, platform);
      tailscaleProbe = { path, serve: path !== undefined && tailscaleServeSupported(path, exec) };
    }
    return tailscaleProbe;
  };
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
      dataDir, envPath, host: systemdBindHost, nodePath, runtime: serviceRuntime,
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
  // harn:assume platform-services-propagate-destination-pnpm-node-path ref=node-path-windows-emission
  const windowsScriptFor = (runtimeVersion: string, serviceGeneration: string): string =>
    renderWindowsServiceScript({
      dataDir, logDir, nodeModulePath, nodePath, runtime: serviceRuntime, servicePath, tokenPath,
      runtimeVersion, serviceGeneration,
    });
  // harn:end platform-services-propagate-destination-pnpm-node-path
  const windowsTask = platform === 'win32'
    ? renderWindowsScheduledTask({ scriptPath: windowsScriptPath, user: windowsUser! })
    : undefined;

  // harn:assume setup-unattended-mutation-requires-explicit-intent ref=setup-unattended-runtime
  const interactive = !options.dryRun && options.yes !== true && isInteractiveSetup(overrides.streams);
  if (!options.dryRun && !interactive && options.updateOnly === undefined) {
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
    if (access === 'tailscale') {
      const { path, serve } = detectTailscale();
      if (!serve) {
        throw new Error(path === undefined
          ? '--access tailscale requires the Tailscale CLI (not found on PATH or in /Applications)'
          : '--access tailscale requires a Tailscale CLI that supports Serve');
      }
    }
    options.out(installSource.durable
      ? `[dry-run] use the Codor runtime in place at ${serviceLocation}`
      : `[dry-run] install a durable Codor runtime -> ${serviceLocation}`);
    options.out(`[dry-run] create ${configDir} and ${dataDir} mode 700; create ${tokenPath} mode 600 if absent`);
    if (platform !== 'win32') {
      options.out(`[dry-run] install codor launcher -> ${join(home, '.local', 'bin', 'codor')} (exec ${nodePath} ${serviceRuntime.cliEntrypoint})`);
      if (platform === 'darwin') {
        options.out(`[dry-run] add ${join(home, '.local', 'bin')} to PATH in ${join(home, '.zprofile')} if absent`);
      }
    }
    if (platform === 'linux') {
      options.out(`[dry-run] install ${runtime.serviceTemplate} -> ${userUnitPath} mode 600`);
      options.out('[dry-run] unit content:');
      for (const line of unitContent!.trimEnd().split('\n')) options.out(line);
      options.out(`[dry-run] write ${envPath} mode 600`);
      options.out('CODOR_TOKEN=<redacted generated-or-existing token>');
      options.out(`CODOR_RUNTIME_VERSION=${version}`);
      options.out('CODOR_SERVICE_GENERATION=<new-generation>');
      options.out(`PATH=${servicePath}`);
      // harn:assume platform-services-propagate-destination-pnpm-node-path ref=node-path-systemd-emission
      if (nodeModulePath !== undefined) options.out(`NODE_PATH=${nodeModulePath}`);
      // harn:end platform-services-propagate-destination-pnpm-node-path
      options.out('[dry-run] systemctl --user daemon-reload');
      options.out('[dry-run] systemctl --user enable codor.service');
      options.out('[dry-run] systemctl --user restart codor.service');
    } else if (platform === 'darwin') {
      // harn:assume platform-services-propagate-destination-pnpm-node-path ref=node-path-launchd-emission
      const launchAgent = renderLaunchAgent({
        dataDir, logDir, nodeModulePath, nodePath, runtime: serviceRuntime, servicePath,
        token: '<redacted generated-or-existing token>',
        runtimeVersion: version,
        serviceGeneration: '<new-generation>',
      });
      // harn:end platform-services-propagate-destination-pnpm-node-path
      options.out(`[dry-run] create ${logDir} mode 700`);
      options.out(`[dry-run] install generated LaunchAgent -> ${launchAgentPath} mode 600`);
      options.out('[dry-run] launch agent content:');
      for (const line of launchAgent.trimEnd().split('\n')) options.out(line);
      options.out(`[dry-run] launchctl bootout ${launchTarget} (ignore not-loaded)`);
      options.out(`[dry-run] wait for ${launchTarget} to unload`);
      options.out(`[dry-run] launchctl bootstrap ${launchDomain} ${launchAgentPath}`);
      options.out(`[dry-run] launchctl enable ${launchTarget}`);
    } else {
      options.out(`[dry-run] protect ${tokenPath} for ${windowsUser} with icacls`);
      options.out(`[dry-run] create ${logDir}`);
      options.out(`[dry-run] install generated ServiceScript -> ${windowsScriptPath}`);
      for (const line of windowsScriptFor(version, '<new-generation>').trimEnd().split(/\r?\n/)) options.out(line);
      options.out(`[dry-run] install generated ScheduledTaskXml -> ${windowsTaskPath} as UTF-16LE`);
      for (const line of windowsTask!.trimEnd().split('\n')) options.out(line);
      options.out('[dry-run] schtasks /End /TN "Codor Switchboard" (ignore not-running)');
      options.out(`[dry-run] schtasks /Create /TN "Codor Switchboard" /XML "${windowsTaskPath}" /F`);
      options.out('[dry-run] schtasks /Run /TN "Codor Switchboard"');
    }
    if (access === 'tailscale') {
      options.out('[dry-run] tailscale serve --bg http://127.0.0.1:8137');
      options.out('[dry-run] tailscale serve status');
    } else {
      options.out('[dry-run] access localhost; skip Tailscale Serve');
    }
    // Report the relay enable/stay-off decision and the resulting first-code exposure —
    // the most security-relevant new default. Uses the SAME file-presence rule as the
    // real run (RelayStore's constructor only reads; existsSync does not mutate).
    const relayExisted = existsSync(join(dataDir, 'crypto', 'relay.json'));
    const relayPreview = new RelayStore(dataDir);
    if (options.noRelay) {
      options.out(relayPreview.enabled
        ? '[dry-run] disable the relay (--no-relay); first code works on your network only'
        : '[dry-run] relay stays off (--no-relay); first code works on your network only');
    } else if (!relayExisted) {
      options.out('[dry-run] enable the relay; first code works at codor.app and on your network');
    } else if (relayPreview.enabled) {
      options.out('[dry-run] relay already enabled; first code works at codor.app and on your network');
    } else {
      options.out('[dry-run] relay stays off (you disabled it); first code works on your network only');
    }
    options.out('[dry-run] wait for Codor pairing status, then generate a ten-minute QR, URL, and pairing code');
    return;
  }
  // harn:end setup-dry-run-reports-without-mutation-or-secret

  const stepTitles = SETUP_STAGE_TITLES;

  // Shared state the steps thread through. `pairing` and the verified service
  // identity are memoized so Retry reuses only a generation this run proved;
  // failed or stale starts converge again, and pairing is not re-minted.
  // The readiness probe always targets the local daemon; the pairing endpoint
  // becomes the tailnet HTTPS origin only when Tailscale Serve succeeds.
  const localEndpoint = 'http://127.0.0.1:8137';
  let endpoint = localEndpoint;
  let selectedAccess: SetupAccess | undefined = options.access;
  let pairing: { code: string; expires: string; qr: string; url: string } | undefined;
  let pairingCopied = false;
  let serviceStarted = false;
  let verifiedServiceIdentity: { version: string; generation: string } | undefined;

  const checkStep = (log: (message: string) => void): string => {
    // Read-only detection; Tailscale is not inspected here.
    log(`${platform} with Node ${process.versions.node}`);
    log(detected.length > 0
      ? `found ${detected.map(({ harness }) => harness).join(', ')}`
      : 'no supported coding agents detected');
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
    // harn:assume setup-enables-relay-for-universal-first-code ref=setup-relay-enable
    // Relay-on-by-default (Richard's locked Q3) so the first code is universal, before
    // the service starts so the daemon boots relay-connected — but honor explicit
    // choices. The STICKY marker is the relay.json FILE: auto-enable ONLY when it does
    // not exist (never configured). Any existing record — enabled, or disabled by
    // `codor relay disable` or a prior --no-relay — is respected verbatim on a default
    // re-run. --no-relay PERSISTS enabled:false (writing the file even on a fresh
    // machine) so the opt-out is durable across later default runs.
    {
      const relayExisted = existsSync(join(dataDir, 'crypto', 'relay.json'));
      const relay = new RelayStore(dataDir);
      if (options.noRelay) {
        const wasEnabled = relay.enabled;
        if (wasEnabled || !relayExisted) relay.disable(); // persist the sticky opt-out marker
        log(wasEnabled
          ? 'relay disabled (--no-relay) — pairing codes will work on your network only'
          : 'relay stays off (--no-relay) — pairing codes will work on your network only');
      } else if (!relayExisted) {
        relay.enable();
        log('relay enabled — your pairing code will work at codor.app');
      } else if (!relay.enabled) {
        log('relay stays off (you disabled it) — run `codor relay enable` for codor.app codes');
      }
    }
    // harn:end setup-enables-relay-for-universal-first-code
    log('private configuration and data are ready');
    return 'config and mode-600 token ready';
  };

  // harn:assume setup-installs-durable-per-user-runtime-atomically ref=setup-install-runtime-wiring
  // Install Codor: make the invoking runtime durable (so the service never
  // references an npx cache), then create the private config, data, and token.
  const installStep = (log: (message: string) => void, intent: InstallIntent = 'ensure'): string => {
    const result = installDurableRuntime({ runtime, dataDir, version, intent, io: installIo });
    log(result.action === 'in-place'
      ? `using the Codor runtime in place at ${result.location}`
      : `${result.action} the Codor ${result.version} runtime at ${result.location}`);
    prepareStep(log);
    // Install the user-facing `codor` launcher pinned to the SAME Node + CLI the
    // service runs, and make ~/.local/bin resolvable, so `codor` works in a new shell
    // after setup. POSIX only — Windows launcher/PATH handling is out of scope.
    if (platform !== 'win32') {
      const launcher = installLauncher({
        home, nodePath, cliEntrypoint: serviceRuntime.cliEntrypoint, platform, pathEntries, log, io: launcherIo,
      });
      log(launcher.action === 'unchanged'
        ? `codor launcher up to date at ${launcher.path}`
        : `${launcher.action} the codor launcher at ${launcher.path}`);
    }
    return `Codor ${result.version} at ${result.location}`;
  };
  // harn:end setup-installs-durable-per-user-runtime-atomically

  // Non-interactive access selection (used by --yes and the linear fallback).
  const chooseStep = (log: (message: string) => void, choice: string | undefined): string => {
    if (choice !== 'localhost' && choice !== 'tailscale') throw new Error('setup requires an access choice');
    if (choice === 'localhost') {
      selectedAccess = 'localhost';
      endpoint = localEndpoint;
      log('localhost only');
      return 'Localhost';
    }
    const { path, serve } = detectTailscale();
    if (path === undefined) throw new Error('Tailscale is not installed; pick localhost or install Tailscale');
    if (!serve) throw new Error('this Tailscale CLI does not support Serve; pick localhost');
    endpoint = configureTailscaleServe(path, localEndpoint, exec);
    selectedAccess = 'tailscale';
    log(`private browser origin ${endpoint}`);
    return 'Tailscale Serve';
  };

  // Interactive access: delegates to the testable runRemoteAccess and applies
  // its decision to the shared endpoint/access state.
  const whereStep = async (
    log: (message: string) => void,
    choice: string,
    choose: (menu: { message: string; options: SetupAccessOption[] }) => Promise<string>,
  ): Promise<string> => {
    const result = await runRemoteAccess({
      choice, localEndpoint, platform, log, choose,
      detect: detectTailscale,
      resetDetect: () => { tailscaleProbe = undefined; },
      configureServe: (path) => configureTailscaleServe(path, localEndpoint, exec),
    });
    selectedAccess = result.access;
    endpoint = result.endpoint;
    return result.summary;
  };

  // harn:assume setup-proves-selected-runtime-before-reuse ref=setup-runtime-convergence
  const startStep = async (
    log: (message: string) => void,
    identity: { version: string; generation: string } = { version, generation: nextGeneration() },
    force = false,
  ): Promise<string> => {
    const token = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : undefined;
    // A Retry may reuse only the exact generation already proved by this run.
    if (!force && serviceStarted && verifiedServiceIdentity !== undefined && token !== undefined) {
      const status = await runtimeStatus(localEndpoint, token);
      if (status?.version === verifiedServiceIdentity.version
        && status.generation === verifiedServiceIdentity.generation) {
        log('Codor selected runtime is already verified; reusing it');
        return 'service already running';
      }
      serviceStarted = false;
      verifiedServiceIdentity = undefined;
    }
    if (!existsSync(tokenPath)) throw new Error(`operator token is missing at ${tokenPath}`);
    if (platform === 'linux') {
      const token = readFileSync(tokenPath, 'utf8').trim();
      mkdirSync(userUnitDir, { recursive: true, mode: 0o700 });
      writeFileSync(userUnitPath, unitContent!, { encoding: 'utf8', mode: 0o600 });
      chmodSync(userUnitPath, 0o600);
      // harn:assume platform-services-propagate-destination-pnpm-node-path ref=node-path-systemd-emission
      const nodePathEnvLine = nodeModulePath === undefined ? '' : `NODE_PATH=${nodeModulePath}\n`;
      writeFileSync(
        envPath,
        `CODOR_TOKEN=${token}\nCODOR_RUNTIME_VERSION=${identity.version}\nCODOR_SERVICE_GENERATION=${identity.generation}\nPATH=${servicePath}\n${nodePathEnvLine}`,
        { encoding: 'utf8', mode: 0o600 },
      );
      // harn:end platform-services-propagate-destination-pnpm-node-path
      chmodSync(envPath, 0o600);
      exec('systemctl', ['--user', 'daemon-reload']);
      exec('systemctl', ['--user', 'enable', 'codor.service']);
      exec('systemctl', ['--user', 'restart', 'codor.service']);
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
      // harn:assume platform-services-propagate-destination-pnpm-node-path ref=node-path-launchd-emission
      writeFileSync(launchAgentPath, renderLaunchAgent({
        dataDir, logDir, nodeModulePath, nodePath, runtime: serviceRuntime, servicePath, token,
        runtimeVersion: identity.version,
        serviceGeneration: identity.generation,
      }), { encoding: 'utf8', mode: 0o600 });
      // harn:end platform-services-propagate-destination-pnpm-node-path
      chmodSync(launchAgentPath, 0o600);
      await bootstrapLaunchAgent({
        exec, probe, sleep,
        exists: overrides.exists,
        domain: launchDomain!,
        target: launchTarget!,
        plistPath: launchAgentPath,
        nodePath,
        cliEntrypoint: serviceRuntime.cliEntrypoint,
        endpoint: localEndpoint,
        log,
      });
    } else {
      mkdirSync(logDir, { recursive: true });
      writeFileSync(windowsScriptPath, windowsScriptFor(identity.version, identity.generation), 'utf8');
      writeFileSync(windowsTaskPath, Buffer.from(`﻿${windowsTask!}`, 'utf16le'));
      try { exec('schtasks', ['/End', '/TN', 'Codor Switchboard']); } catch { /* task may not be running */ }
      exec('schtasks', ['/Create', '/TN', 'Codor Switchboard', '/XML', windowsTaskPath, '/F']);
      exec('schtasks', ['/Run', '/TN', 'Codor Switchboard']);
    }
    await waitForCodor(localEndpoint, probe, sleep);
    log('Codor answered its pairing status check');
    const selected = await runtimeStatus(localEndpoint, readFileSync(tokenPath, 'utf8').trim());
    if (selected?.version !== identity.version || selected.generation !== identity.generation) {
      throw new Error(`Codor answered generically but did not report selected runtime ${identity.version} generation ${identity.generation}`);
    }
    verifiedServiceIdentity = identity;
    serviceStarted = true;
    log(`Codor reported selected runtime ${identity.version} generation ${identity.generation}`);
    if (systemdBindHost === '0.0.0.0') log('WSL2 NAT is reachable through Windows localhost');
    return 'service enabled and answering';
  };
  // harn:end setup-proves-selected-runtime-before-reuse

  const pairStep = async (log: (message: string) => void): Promise<string> => {
    if (pairing === undefined) {
      // harn:assume setup-enables-relay-for-universal-first-code ref=setup-universal-mint
      // Mint the first code through the daemon's offers API when the relay is enabled —
      // the ONE universal mint path codor pair uses — so it opens BOTH codor.app and
      // the local door. Degrade to a labelled local-only code (never a hard failure)
      // when the relay is off (--no-relay) or unreachable, and report which doors open.
      let offer: PairingOffer | undefined;
      if (!options.noRelay) {
        const token = readFileSync(tokenPath, 'utf8').trim();
        offer = await relayOffer({ localEndpoint, endpoint, token });
      }
      if (offer === undefined) {
        const crypto = new CryptoVault(dataDir);
        try {
          offer = crypto.pairing.issue(endpoint);
        } finally {
          crypto.close();
        }
      }
      const url = pairingUrl(offer);
      pairing = { code: offer.pairing_code, expires: offer.expires_at, qr: renderQr(url), url };
      log(offer.doors === 'both'
        ? 'this code works at codor.app and on your network'
        : 'this code works on your network only — run `codor relay enable` for codor.app');
      // harn:end setup-enables-relay-for-universal-first-code
      // harn:assume setup-copies-pairing-link-once-via-clipboard ref=pairing-clipboard-copy
      // Copy the complete link once, when the offer is first minted (Retry reuses
      // the memoized offer and does not re-copy). The URL travels on stdin, so the
      // token never reaches argv; a clipboard failure returns false and never
      // fails pairing — the card then tells the operator to copy the link itself.
      pairingCopied = copyToClipboard(pairing.url, { platform, env: options.env, which });
      // harn:end setup-copies-pairing-link-once-via-clipboard
    }
    log(`pairing code ${pairing.code}`);
    return `code ${pairing.code}`;
  };

  // harn:assume runtime-update-transacts-runtime-service-and-selected-data-root ref=private-update-application
  if (options.updateOnly !== undefined) {
    if (runtime.layout !== 'installed-package') throw new Error('the private updater requires an acquired package runtime');
    if (version !== options.updateOnly.expectedVersion) {
      throw new Error(`acquired Codor version ${version} does not match expected ${options.updateOnly.expectedVersion}`);
    }
    const previous = detectInstalledRuntime(dataDir, installIo);
    if (!previous) throw new Error('no durable Codor installation was found; run `codor install` first');
    if (!existsSync(tokenPath)) throw new Error(`operator token is missing at ${tokenPath}`);
    const log = (message: string): void => options.out(message);
    const serviceFiles = platform === 'linux'
      ? [userUnitPath, envPath]
      : platform === 'darwin'
        ? [launchAgentPath]
        : [windowsScriptPath, windowsTaskPath];
    const priorServiceFiles = captureServiceFiles(serviceFiles);
    const result = installDurableRuntime({
      runtime,
      dataDir,
      version,
      intent: 'update',
      retainBackup: true,
      io: installIo,
    });
    try {
      if (platform !== 'win32') {
        installLauncher({
          home, nodePath, cliEntrypoint: serviceRuntime.cliEntrypoint, platform, pathEntries, log, io: launcherIo,
        });
      }
      const generation = nextGeneration();
      await startStep(log, { version, generation }, true);
      finalizeDurableRuntimeInstall(result, installIo);
      options.out(`Codor updated from ${previous.version} to ${version}; service generation ${generation} is ready`);
      return;
    } catch (error) {
      const restorationFailures: string[] = [];
      try { rollbackDurableRuntimeInstall(result, installIo); } catch (rollbackError) {
        restorationFailures.push(`runtime restore failed: ${String(rollbackError)}`);
      }
      try { restoreServiceFiles(priorServiceFiles); } catch (restoreError) {
        restorationFailures.push(`service-file restore failed: ${String(restoreError)}`);
      }
      if (restorationFailures.length > 0) {
        throw new Error(`Codor update failed: ${String(error)}; rollback was incomplete (${restorationFailures.join('; ')}). Inspect the user-service logs and restore the stopped backup before retrying.`);
      }
      let rollbackDetail = 'the previous runtime files were restored';
      try {
        if (platform === 'linux') {
          exec('systemctl', ['--user', 'daemon-reload']);
          exec('systemctl', ['--user', 'enable', 'codor.service']);
          exec('systemctl', ['--user', 'restart', 'codor.service']);
        } else if (platform === 'darwin') {
          await bootstrapLaunchAgent({
            exec, probe, sleep,
            exists: overrides.exists,
            domain: launchDomain!,
            target: launchTarget!,
            plistPath: launchAgentPath,
            nodePath,
            cliEntrypoint: serviceRuntime.cliEntrypoint,
            endpoint: localEndpoint,
            log,
          });
        } else {
          try { exec('schtasks', ['/End', '/TN', 'Codor Switchboard']); } catch { /* task may not be running */ }
          exec('schtasks', ['/Create', '/TN', 'Codor Switchboard', '/XML', windowsTaskPath, '/F']);
          exec('schtasks', ['/Run', '/TN', 'Codor Switchboard']);
        }
        await waitForCodor(localEndpoint, probe, sleep);
        const token = readFileSync(tokenPath, 'utf8').trim();
        const restored = await runtimeStatus(localEndpoint, token);
        if (restored === undefined) {
          rollbackDetail = `Codor ${previous.version} was restored and is generically healthy, but its legacy identity is unverified`;
        } else if (restored.version === previous.version) {
          rollbackDetail = `Codor ${previous.version} was restored and version-verified`;
        } else {
          throw new Error(`the restored service reported unexpected Codor ${restored.version}`);
        }
      } catch (rollbackError) {
        rollbackDetail = `the previous runtime and exact service files were restored but its service could not be verified: ${String(rollbackError)}`;
      }
      throw new Error(`Codor update failed: ${String(error)}; ${rollbackDetail}. Inspect the user-service logs and retry \`codor update\`.`);
    }
  }
  // harn:end runtime-update-transacts-runtime-service-and-selected-data-root

  const cardColumns = overrides.streams?.output?.columns ?? process.stdout.columns ?? 80;
  // The frame budget is rows - 1. Its fixed pairing overhead is two header rows,
  // one blank, one heading, and the reserved Finish control: five rows. Therefore
  // a complete card gets rows - 6; at 80x46 the real 29-row QR fits exactly.
  const cardRows = overrides.streams?.output?.rows ?? process.stdout.rows ?? 24;
  const cardMaxRows = Math.max(8, cardRows - 6);
  const emitPairing = (): void => {
    options.out(renderPairingCard({
      code: pairing!.code,
      url: pairing!.url,
      expires: pairing!.expires,
      qr: pairing!.qr,
      instruction: 'Scan the QR or enter the code in your browser to finish pairing.',
      copied: pairingCopied,
    }, cardColumns));
  };

  if (interactive) {
    const session = new SetupSession({ version, streams: overrides.streams });
    const existingInstall = detectInstalledRuntime(dataDir, installIo);
    const installMenu = existingInstall === undefined
      ? {
        message: 'Install Codor on this computer?',
        options: [
          { id: 'install', label: 'Install Codor', description: 'Copy a durable runtime, then create your private config, data, and token.', available: true },
          { id: 'later', label: 'Not now', description: 'Do not change anything on this computer.', available: true },
        ],
      }
      : existingInstall.version === version
        ? {
          message: `Codor ${version} is already installed. Continue?`,
          options: [
            { id: 'continue', label: 'Continue', description: 'Use the installed runtime and ensure your private files.', available: true },
            { id: 'update', label: 'Reinstall', description: 'Re-copy the durable runtime.', available: true },
            { id: 'later', label: 'Not now', description: 'Do not change anything.', available: true },
          ],
        }
        : {
          message: `Update Codor from ${existingInstall.version} to ${version}?`,
          options: [
            { id: 'update', label: 'Update Codor', description: 'Re-copy the durable runtime at the new version.', available: true },
            { id: 'keep', label: 'Keep current', description: `Keep ${existingInstall.version} and ensure your private files.`, available: true },
            { id: 'later', label: 'Not now', description: 'Do not change anything.', available: true },
          ],
        };
    const steps: SetupStepDefinition[] = [
      { title: stepTitles[0], description: 'Read-only — nothing on your computer changes.', run: async ({ log }) => checkStep(log) },
      {
        title: stepTitles[1],
        description: 'Set up Codor in a stable per-user location.',
        // Consent gate: no runtime is copied and no files are created until an
        // affirmative choice; "Not now" leaves the computer unchanged.
        menu: installMenu,
        run: async ({ log, choice }) => (choice === 'later'
          ? { skip: true, summary: '(run codor install when ready)', skipFollowing: true }
          : installStep(log, choice === 'update' ? 'update' : choice === 'keep' ? 'keep' : 'ensure')),
      },
      {
        title: stepTitles[2],
        description: 'Choose where you will use Codor.',
        menu: {
          message: 'Where will you use Codor?',
          options: [
            { id: 'here', label: 'On this computer only', description: 'Reach Codor from this computer.', available: true },
            { id: 'remote', label: 'On this computer and remotely', description: 'Also reach Codor from your other devices, over Tailscale.', available: true },
          ],
        },
        run: async ({ log, choice, choose }) => whereStep(log, choice!, choose),
      },
      {
        title: stepTitles[3],
        description: 'Install and start the private background service.',
        // Consent gate: nothing is installed or started until Start is chosen.
        menu: {
          message: 'Run Codor in the background?',
          options: [
            { id: 'start', label: 'Start Codor', description: 'Install and start the private background service.', available: true },
            { id: 'later', label: 'Not now', description: 'Do not install or start anything yet.', available: true },
          ],
        },
        run: async ({ log, choice }) => (choice === 'start'
          ? startStep(log)
          : { skip: true, summary: '(run codor install when ready)', skipFollowing: true }),
      },
      {
        title: stepTitles[4],
        description: 'Connect a browser with a short-lived pairing code.',
        // Consent gate: no pairing code is minted until Create is chosen.
        menu: {
          message: 'Pair a browser now?',
          options: [
            { id: 'create', label: 'Create a pairing code', description: 'Mint a ten-minute code and QR now.', available: true },
            { id: 'later', label: 'Set this up later', description: 'Keep the service running and pair from a browser later.', available: true },
          ],
        },
        run: async ({ log, choice, presentResult }) => {
          if (choice !== 'create') return { skip: true, summary: '(run codor pair later)' };
          const summary = await pairStep(log);
          // Replace the question in-frame with the QR/code result card, so it is
          // visible before Finish closes the installer.
          presentResult(renderPairingCard({
            code: pairing!.code,
            url: pairing!.url,
            expires: pairing!.expires,
            qr: pairing!.qr,
            instruction: 'Scan the QR or enter the code in your browser to finish pairing.',
            copied: pairingCopied,
          }, cardColumns, cardMaxRows));
          return summary;
        },
      },
    ];
    await session.run(steps);
    const harnesses = detected.map(({ harness }) => harness);
    if (!serviceStarted) {
      // Start was declined: nothing was installed, and pairing was skipped too.
      session.finish({ headline: 'Setup paused - Codor is not running.', harnesses, nextAction: 'Run `codor install` when you are ready to install and start Codor.' });
    } else if (pairing === undefined) {
      // The service is up but the operator declined pairing.
      session.finish({ headline: 'Codor is running.', endpoint, harnesses, nextAction: 'Run `codor pair` when you want to connect a browser.' });
    } else {
      // The pairing result card is already visible in-frame; keep it as the
      // final frame and close without re-emitting it.
      session.finish();
    }
  } else {
    const linear = (index: number) => (message: string): void => options.out(`[${String(index + 1)}/5] ${message}`);
    options.out(`[1/5] ${stepTitles[0]}`); checkStep(linear(0));
    options.out(`[2/5] ${stepTitles[1]}`); installStep(linear(1));
    options.out(`[3/5] ${stepTitles[2]}`); chooseStep(linear(2), options.access);
    options.out(`[4/5] ${stepTitles[3]}`); await startStep(linear(3));
    options.out(`[5/5] ${stepTitles[4]}`); await pairStep(linear(4));
    emitPairing();
  }
}
// harn:end setup-preserves-private-platform-service
// harn:end windows-setup-installs-private-task-service
