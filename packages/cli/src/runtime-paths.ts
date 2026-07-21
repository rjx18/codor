import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RuntimeLayout = 'installed-package' | 'source-checkout';

export interface RuntimePaths {
  cliEntrypoint: string;
  layout: RuntimeLayout;
  root: string;
  serviceTemplate: string;
  staticRoot: string;
}

export interface RuntimePathOptions {
  checkoutRoot?: string;
  packageRoot?: string;
  repoRoot?: string;
}

interface Candidate extends RuntimePaths {
  label: string;
}

function packageCandidate(root: string, label = 'installed package'): Candidate {
  return {
    cliEntrypoint: join(root, 'dist', 'index.js'),
    label,
    layout: 'installed-package',
    root,
    serviceTemplate: join(root, 'packaging', 'systemd', 'codor.service'),
    staticRoot: join(root, 'runtime', 'web'),
  };
}

function checkoutCandidate(root: string, label = 'source checkout'): Candidate {
  return {
    cliEntrypoint: join(root, 'packages', 'cli', 'dist', 'index.js'),
    label,
    layout: 'source-checkout',
    root,
    serviceTemplate: join(root, 'packaging', 'systemd', 'codor.service'),
    staticRoot: join(root, 'packages', 'web-next', 'dist'),
  };
}

function complete(candidate: Candidate): boolean {
  return existsSync(candidate.cliEntrypoint)
    && existsSync(candidate.serviceTemplate)
    && existsSync(candidate.staticRoot);
}

function defaultPackageRoot(): string {
  return resolve(fileURLToPath(new URL('../', import.meta.url)));
}

function defaultCheckoutRoot(): string {
  return resolve(fileURLToPath(new URL('../../../', import.meta.url)));
}

// harn:assume setup-resolves-complete-invoking-runtime ref=setup-runtime-resolution
export function runtimeCandidates(options: RuntimePathOptions = {}): Candidate[] {
  const candidates: Candidate[] = [];
  if (options.repoRoot !== undefined) {
    candidates.push(checkoutCandidate(resolve(options.repoRoot), 'injected checkout'));
  }
  candidates.push(packageCandidate(resolve(options.packageRoot ?? defaultPackageRoot())));
  candidates.push(checkoutCandidate(resolve(options.checkoutRoot ?? defaultCheckoutRoot())));
  return candidates;
}

export function tryResolveRuntimePaths(options: RuntimePathOptions = {}): RuntimePaths | undefined {
  const found = runtimeCandidates(options).find(complete);
  if (found === undefined) return undefined;
  const { label: _label, ...runtime } = found;
  return runtime;
}

export function resolveRuntimePaths(options: RuntimePathOptions = {}): RuntimePaths {
  const candidates = runtimeCandidates(options);
  const found = candidates.find(complete);
  if (found !== undefined) {
    const { label: _label, ...runtime } = found;
    return runtime;
  }
  const inspected = candidates.map((candidate) =>
    `${candidate.label}: ${candidate.cliEntrypoint}, ${candidate.staticRoot}, ${candidate.serviceTemplate}`,
  );
  throw new Error(`codor setup could not find a complete runtime; checked ${inspected.join(' | ')}`);
}
// harn:end setup-resolves-complete-invoking-runtime
