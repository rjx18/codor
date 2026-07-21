import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PUBLIC_PACKAGE_NAME = '@richhardry/codor';
export const ENTRY_PACKAGE = '@codor/cli';

const WORKSPACE_DIRS = ['packages', 'packages/adapters', 'packages/bridges'] as const;
const WORKSPACE_PROTOCOL = 'workspace:';

export interface PackageManifest {
  name?: string;
  version?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

export interface WorkspacePackage {
  name: string;
  dir: string;
  manifest: PackageManifest;
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
}

export function readWorkspace(repoRoot: string): Map<string, WorkspacePackage> {
  const found = new Map<string, WorkspacePackage>();
  for (const group of WORKSPACE_DIRS) {
    const groupDir = join(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(groupDir, entry.name);
      const manifestPath = join(dir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = readManifest(manifestPath);
      if (typeof manifest.name !== 'string') continue;
      found.set(manifest.name, { name: manifest.name, dir, manifest });
    }
  }
  return found;
}

export function discoverClosure(
  workspace: Map<string, WorkspacePackage>,
  entry = ENTRY_PACKAGE,
): string[] {
  const seen = new Set<string>();
  const walk = (name: string): void => {
    if (seen.has(name)) return;
    const pkg = workspace.get(name);
    if (pkg === undefined) throw new Error(`closure walk reached unknown workspace package ${name}`);
    seen.add(name);
    for (const dependency of Object.keys(pkg.manifest.dependencies ?? {})) {
      if (workspace.has(dependency)) walk(dependency);
    }
  };
  walk(entry);
  return [...seen].sort();
}

export function hoistThirdPartyDependencies(
  workspace: Map<string, WorkspacePackage>,
  closure: string[],
): Record<string, string> {
  const hoisted: Record<string, string> = {};
  const origin: Record<string, string> = {};
  for (const name of closure) {
    const pkg = workspace.get(name);
    if (pkg === undefined) continue;
    for (const [dependency, range] of Object.entries(pkg.manifest.dependencies ?? {})) {
      if (workspace.has(dependency)) continue;
      const existing = hoisted[dependency];
      if (existing !== undefined && existing !== range) {
        throw new Error(
          `conflicting ranges for ${dependency}: ${origin[dependency]} wants ${existing}, ${name} wants ${range}`,
        );
      }
      hoisted[dependency] = range;
      origin[dependency] = name;
    }
  }
  return Object.fromEntries(Object.entries(hoisted).sort(([a], [b]) => a.localeCompare(b)));
}

export function stageManifest(
  manifest: PackageManifest,
  versions: Map<string, string>,
): PackageManifest {
  const staged: PackageManifest = { ...manifest };
  delete staged.devDependencies;
  delete staged.scripts;
  delete staged.private;
  if (staged.dependencies !== undefined) {
    staged.dependencies = Object.fromEntries(
      Object.entries(staged.dependencies).map(([name, range]) => {
        if (!range.startsWith(WORKSPACE_PROTOCOL)) return [name, range];
        const version = versions.get(name);
        if (version === undefined) {
          throw new Error(`cannot resolve ${name} to an exact version while staging`);
        }
        return [name, version];
      }),
    );
  }
  return staged;
}

// harn:assume public-cli-delegation-reports-concise-failures ref=public-wrapper-delegation
export function renderWrapperExecutable(): string {
  return `#!/usr/bin/env node
import { runCli } from '${ENTRY_PACKAGE}';

await runCli().catch((error) => {
  process.stderr.write(\`\${error instanceof Error ? error.message : String(error)}\\n\`);
  process.exitCode = 1;
});
`;
}
// harn:end public-cli-delegation-reports-concise-failures

export interface BuildArtifactOptions {
  repoRoot: string;
  outDir: string;
  publicName?: string;
}

export interface BuildArtifactResult {
  outDir: string;
  closure: string[];
  manifest: PackageManifest;
}

function assertNoSymlinks(root: string): void {
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (lstatSync(child).isSymbolicLink()) {
        throw new Error(`artifact staging refuses symlink ${child}`);
      }
      if (entry.isDirectory()) visit(child);
    }
  };
  visit(root);
}

// harn:assume public-package-bundles-complete-codor-runtime ref=artifact-runtime-builder
export function buildArtifact(options: BuildArtifactOptions): BuildArtifactResult {
  const repoRoot = resolve(options.repoRoot);
  const outDir = resolve(options.outDir);
  const publicName = options.publicName ?? PUBLIC_PACKAGE_NAME;
  const workspace = readWorkspace(repoRoot);
  const closure = discoverClosure(workspace);
  const versions = new Map(
    closure.map((name) => {
      const version = workspace.get(name)?.manifest.version;
      if (typeof version !== 'string') throw new Error(`workspace package ${name} has no version to bundle`);
      return [name, version];
    }),
  );
  const entry = workspace.get(ENTRY_PACKAGE);
  if (entry === undefined) throw new Error(`${ENTRY_PACKAGE} is not a workspace package`);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  for (const name of closure) {
    const pkg = workspace.get(name)!;
    const dist = join(pkg.dir, 'dist');
    if (!existsSync(dist)) {
      throw new Error(`${name} has no dist; build the workspace before staging the artifact`);
    }
    const stagedDir = join(outDir, 'node_modules', name);
    mkdirSync(stagedDir, { recursive: true });
    cpSync(dist, join(stagedDir, 'dist'), { recursive: true });
    rmSync(join(stagedDir, 'dist', 'test-utils'), { recursive: true, force: true });
    rmSync(join(stagedDir, 'dist', 'fixtures'), { recursive: true, force: true });
    writeFileSync(
      join(stagedDir, 'package.json'),
      `${JSON.stringify(stageManifest(pkg.manifest, versions), undefined, 2)}\n`,
      'utf8',
    );
  }

  const stagedCli = join(outDir, 'node_modules', ENTRY_PACKAGE);
  const webDist = join(repoRoot, 'packages', 'web-next', 'dist');
  if (!existsSync(webDist)) throw new Error('@codor/web-next has no dist; build it before staging the artifact');
  cpSync(webDist, join(stagedCli, 'runtime', 'web'), { recursive: true });

  const templateTarget = join(stagedCli, 'packaging', 'systemd', 'codor.service');
  mkdirSync(dirname(templateTarget), { recursive: true });
  cpSync(join(repoRoot, 'packaging', 'systemd', 'codor.service'), templateTarget);

  const binPath = join(outDir, 'bin', 'codor.mjs');
  mkdirSync(dirname(binPath), { recursive: true });
  writeFileSync(binPath, renderWrapperExecutable(), { encoding: 'utf8', mode: 0o755 });
  for (const doc of ['README.md', 'LICENSE']) cpSync(join(repoRoot, doc), join(outDir, doc));

  const manifest: PackageManifest = {
    name: publicName,
    version: versions.get(ENTRY_PACKAGE),
    description: 'Codor - one channel for every coding agent.',
    license: 'MIT',
    type: 'module',
    bin: { codor: './bin/codor.mjs' },
    files: ['bin', 'README.md', 'LICENSE'],
    engines: { node: '>=22.12.0' },
    publishConfig: { access: 'public' },
    dependencies: {
      ...Object.fromEntries(closure.map((name) => [name, versions.get(name) ?? ''])),
      ...hoistThirdPartyDependencies(workspace, closure),
    },
    bundleDependencies: [...closure],
  };
  writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8');
  assertNoSymlinks(outDir);
  return { outDir, closure, manifest };
}
// harn:end public-package-bundles-complete-codor-runtime

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const outDir = process.argv[2] ?? join(repoRoot, 'artifact', 'codor');
  const result = buildArtifact({ repoRoot, outDir });
  process.stdout.write(`staged ${result.manifest.name ?? ''}@${result.manifest.version ?? ''} -> ${result.outDir}\n`);
  process.stdout.write(`bundled ${String(result.closure.length)}: ${result.closure.join(', ')}\n`);
}
