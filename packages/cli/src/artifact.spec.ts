import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENTRY_PACKAGE,
  PUBLIC_PACKAGE_NAME,
  buildArtifact,
  discoverClosure,
  hoistThirdPartyDependencies,
  readWorkspace,
  renderWrapperExecutable,
  stageManifest,
} from './artifact.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const EXPECTED_CLOSURE = [
  '@codor/adapter-acp',
  '@codor/adapter-antigravity',
  '@codor/adapter-claude-code',
  '@codor/adapter-codex',
  '@codor/adapter-copilot',
  '@codor/adapter-cursor',
  '@codor/adapter-gemini',
  '@codor/adapter-grok',
  '@codor/adapter-opencode',
  '@codor/cli',
  '@codor/protocol',
  '@codor/switchboard',
  '@codor/tunnel',
];

function filesBelow(root: string): string[] {
  const found: string[] = [];
  const visit = (path: string, prefix: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(join(path, entry.name), relative);
      else found.push(relative);
    }
  };
  visit(root, '');
  return found.sort();
}

describe('artifact graph', () => {
  it('finds exactly the current twelve-package runtime closure', () => {
    expect(discoverClosure(readWorkspace(repoRoot))).toEqual(EXPECTED_CLOSURE);
  });

  it('reaches every built-in adapter transitively through switchboard', () => {
    const workspace = readWorkspace(repoRoot);
    const direct = Object.keys(workspace.get(ENTRY_PACKAGE)?.manifest.dependencies ?? {});
    expect(direct.some((name) => name.startsWith('@codor/adapter-'))).toBe(false);
    expect(discoverClosure(workspace).filter((name) => name.startsWith('@codor/adapter-')))
      .toHaveLength(9);
  });

  it('rejects conflicting third-party dependency ranges', () => {
    const workspace = new Map([
      ['a', { name: 'a', dir: '/a', manifest: { name: 'a', dependencies: { zod: '^1' } } }],
      ['b', { name: 'b', dir: '/b', manifest: { name: 'b', dependencies: { zod: '^2' } } }],
    ]);
    expect(() => hoistThirdPartyDependencies(workspace, ['a', 'b'])).toThrow(/conflicting ranges/);
  });

  it('rewrites workspace protocols and rejects unresolved workspace values', () => {
    expect(stageManifest(
      { dependencies: { '@codor/protocol': 'workspace:*', zod: '^4.4.3' } },
      new Map([['@codor/protocol', '0.10.0']]),
    ).dependencies).toEqual({ '@codor/protocol': '0.10.0', zod: '^4.4.3' });
    expect(() => stageManifest(
      { dependencies: { '@codor/missing': 'workspace:*' } },
      new Map(),
    )).toThrow(/cannot resolve/);
  });
});

// harn:assume management-failures-have-stable-redacted-exits ref=public-cli-failure-regression
describe('public wrapper', () => {
  const source = renderWrapperExecutable();

  it('calls the public runCli export and owns concise rejection handling', () => {
    expect(source).toContain(`import { cliExitCode, formatCliError, runCli } from '${ENTRY_PACKAGE}'`);
    expect(source).toMatch(/await runCli\(\)\.catch/);
    expect(source).not.toContain('dist/program.js');
    expect(source).toContain('process.exitCode = cliExitCode(error)');
  });
});
// harn:end management-failures-have-stable-redacted-exits

// harn:assume artifact-build-runs-from-clean-source ref=artifact-build-command
describe('artifact build command', () => {
  it('builds the recursive CLI closure and browser before staging', () => {
    const rootManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(rootManifest.scripts?.['build:artifact']).toBe(
      "pnpm --filter '@codor/cli...' build && pnpm --filter @codor/web-next build && pnpm --filter @codor/cli build:artifact",
    );
  });
});
// harn:end artifact-build-runs-from-clean-source

// harn:assume public-package-bundles-complete-codor-runtime ref=artifact-runtime-regression
describe('built public artifact', () => {
  let root: string;
  let outDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codor-artifact-spec-'));
    outDir = join(root, 'codor');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('emits the public manifest without renaming tracked workspace packages', () => {
    const { manifest } = buildArtifact({ repoRoot, outDir });
    const releaseVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(manifest.name).toBe(PUBLIC_PACKAGE_NAME);
    expect(manifest.private).toBeUndefined();
    expect(manifest.publishConfig).toEqual({ access: 'public' });
    expect(manifest.engines).toEqual({ node: '>=22.12.0' });
    expect(manifest.bundleDependencies).toEqual(EXPECTED_CLOSURE);
    expect(JSON.parse(readFileSync(join(outDir, 'node_modules', ENTRY_PACKAGE, 'package.json'), 'utf8')))
      .toMatchObject({ name: ENTRY_PACKAGE, version: releaseVersion.version });
  });

  // harn:assume github-tags-publish-numbered-semver-alpha-or-stable-release ref=public-package-repository-regression
  it('stages the exact public GitHub repository identity', () => {
    const { manifest } = buildArtifact({ repoRoot, outDir });
    expect(manifest.repository).toEqual({ type: 'git', url: 'https://github.com/rjx18/codor' });
    expect(JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8')).repository).toEqual({
      type: 'git',
      url: 'https://github.com/rjx18/codor',
    });
  });
  // harn:end github-tags-publish-numbered-semver-alpha-or-stable-release

  // harn:assume public-package-readme-renders-on-npm ref=artifact-readme-regression
  it('stages an npm-renderable README with the current install command', () => {
    buildArtifact({ repoRoot, outDir });
    const readme = readFileSync(join(outDir, 'README.md'), 'utf8');
    expect(readme).toContain('npx @richhardry/codor install');
    expect(readme).toContain('npx --yes --package=@richhardry/codor@latest codor update');
    expect(readme).toContain(
      'https://raw.githubusercontent.com/rjx18/codor/main/website/public/codor-mark-light.svg',
    );
    expect(readme).toContain(
      'https://raw.githubusercontent.com/rjx18/codor/main/website/public/codor-mark-dark.svg',
    );
    expect(readme).not.toMatch(/(?:src|srcset)="website\/public\/codor-mark-/);
  });
  // harn:end public-package-readme-renders-on-npm

  it('stages exact manifests, the complete web build, and service resources', () => {
    const { manifest } = buildArtifact({ repoRoot, outDir });
    for (const name of EXPECTED_CLOSURE) {
      expect(manifest.dependencies?.[name]).toMatch(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
      );
      expect(readFileSync(join(outDir, 'node_modules', name, 'package.json'), 'utf8'))
        .not.toContain('workspace:');
    }
    const cliRoot = join(outDir, 'node_modules', ENTRY_PACKAGE);
    expect(readFileSync(join(cliRoot, 'runtime', 'web', 'index.html'), 'utf8')).toContain('<!doctype html>');
    expect(readFileSync(join(cliRoot, 'packaging', 'systemd', 'codor.service'), 'utf8'))
      .toContain('ExecStart=');
    // Windows has no POSIX executable permission bit — writeFileSync's `mode`
    // option cannot set one there, so this property only exists to check on
    // platforms where the filesystem tracks it.
    if (process.platform !== 'win32') {
      expect(statSync(join(outDir, 'bin', 'codor.mjs')).mode & 0o111).not.toBe(0);
    }
  });

  it('contains no source, specs, fixtures, symlinks, or workspace protocols', () => {
    buildArtifact({ repoRoot, outDir });
    const files = filesBelow(outDir);
    expect(files.some((path) => /(?:^|\/)src\//.test(path))).toBe(false);
    expect(files.some((path) => /(?:\.spec\.|\.test\.|\/(?:fixtures|test-utils)\/)/.test(path))).toBe(false);
    expect(files.some((path) => statSync(join(outDir, path)).isSymbolicLink())).toBe(false);
    for (const path of files.filter((candidate) => candidate.endsWith('package.json'))) {
      expect(readFileSync(join(outDir, path), 'utf8')).not.toContain('workspace:');
    }
  });
});
// harn:end public-package-bundles-complete-codor-runtime

describe('CLI test environment isolation', () => {
  const wrapper = fileURLToPath(new URL('../../../scripts/test-env.mjs', import.meta.url));
  const poisoned = {
    ...process.env,
    CODOR_SOCKET: '/run/user/1000/live.sock',
    CODOR_TOKEN: 'never-print-this-value',
    CODOR_MEMBER_TOKEN: 'member-secret',
  };
  const printKeys = 'process.stdout.write(Object.keys(process.env).filter((key) => key.startsWith("CODOR_")).join(","))';

  it('deletes every CODOR_ key rather than assigning an empty value', () => {
    const seen = execFileSync(process.execPath, [wrapper, process.execPath, '-e', printKeys], {
      encoding: 'utf8',
      env: poisoned,
    });
    const defined = execFileSync(process.execPath, [
      wrapper,
      process.execPath,
      '-e',
      'process.stdout.write(String("CODOR_TOKEN" in process.env))',
    ], { encoding: 'utf8', env: poisoned });
    expect(seen).toBe('');
    expect(defined).toBe('false');
  });

  it('propagates a child failure without printing secret values', () => {
    try {
      execFileSync(process.execPath, [wrapper, process.execPath, '-e', 'process.exit(7)'], {
        encoding: 'utf8',
        env: poisoned,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      throw new Error('expected child failure');
    } catch (error) {
      const failure = error as { status?: number; stderr?: Buffer | string };
      expect(failure.status).toBe(7);
      expect(String(failure.stderr)).toContain('CODOR_TOKEN');
      expect(String(failure.stderr)).not.toContain('never-print-this-value');
    }
  });

  // harn:assume cli-tests-run-package-bins-portably-without-shell ref=cli-test-package-bin-regressions
  it('spawns a bare npm bin name by resolving its real entrypoint', () => {
    // vitest in node_modules/.bin is a .CMD shim on Windows; this proves the
    // wrapper resolves and runs it rather than spawning the bare name as-is.
    const output = execFileSync(process.execPath, [wrapper, 'vitest', '--version'], { encoding: 'utf8' });
    expect(output).toMatch(/^vitest\//);
  });

  it('falls back to spawning a bare non-package executable directly', () => {
    // `node` names no npm package in this workspace; the wrapper must still
    // spawn it directly rather than requiring a package.json bin entry.
    const output = execFileSync(process.execPath, [wrapper, 'node', '-e', 'process.stdout.write("ok")'], {
      encoding: 'utf8',
      env: poisoned,
    });
    expect(output).toBe('ok');
  });
  // harn:end cli-tests-run-package-bins-portably-without-shell
});
