import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  decideRelayDeployment,
  formatDecision,
  normalizeLockfileSlice,
  normalizeRootManifest,
} from "./relay-deploy-decision.mjs";

// harn:assume relay-worker-deploy-decision-is-full-range-and-fail-open ref=relay-deploy-decision-regression
const LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      '@resvg/resvg-js':
        specifier: 2.6.2
        version: 2.6.2
      '@types/node':
        specifier: ^22.8.0
        version: 22.20.1
      typescript:
        specifier: ^5.5.4
        version: 5.9.3
      vitest:
        specifier: ^3.2.4
        version: 3.2.7

  packages/tunnel:
    dependencies:
      '@noble/hashes':
        specifier: ^2.2.0
        version: 2.2.0

  relay-worker:
    devDependencies:
      wrangler:
        specifier: ^4.114.0
        version: 4.114.0

  packages/web-next:
    devDependencies:
      vite:
        specifier: ^6.0.0
        version: 6.4.3

packages:

  typescript@5.9.3:
    resolution: {integrity: sha512-typescript}

  '@resvg/resvg-js@2.6.2':
    resolution: {integrity: sha512-resvg}

  wrangler@4.114.0:
    resolution: {integrity: sha512-wrangler}

  vite@6.4.3:
    resolution: {integrity: sha512-vite}

snapshots:

  '@resvg/resvg-js@2.6.2': {}

  typescript@5.9.3: {}

  wrangler@4.114.0: {}

  vite@6.4.3: {}
`;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "codor-relay-decision-"));
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.email", "tests@example.invalid");
  git(cwd, "config", "user.name", "relay decision tests");
  writeFileSync(join(cwd, "package.json"), `${JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    description: "fixture",
    packageManager: "pnpm@10.9.0",
    engines: { node: ">=22.12.0" },
    scripts: { build: "pnpm -r build", "deploy:app": "node deploy.mjs", test: "test" },
    devDependencies: {
      "@resvg/resvg-js": "2.6.2",
      "@types/node": "^22.8.0",
      typescript: "^5.5.4",
      vitest: "^3.2.4",
    },
    pnpm: { onlyBuiltDependencies: ["esbuild", "better-sqlite3"] },
  }, null, 2)}\n`);
  writeFileSync(join(cwd, "pnpm-lock.yaml"), LOCKFILE);
  writeFileSync(join(cwd, "tsconfig.base.json"), "{\"compilerOptions\":{\"strict\":true}}\n");
  writeFileSync(join(cwd, "README.md"), "base\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "base");
  const base = git(cwd, "rev-parse", "HEAD");
  return { cwd, base };
}

function commit(cwd, files, message) {
  for (const [file, contents] of Object.entries(files)) {
    const path = join(cwd, file);
    if (contents === null) {
      execFileSync("git", ["rm", "-q", "--ignore-unmatch", "--", file], { cwd });
    } else {
      mkdirSync(join(cwd, file, ".."), { recursive: true });
      writeFileSync(path, contents);
    }
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", message);
  return git(cwd, "rev-parse", "HEAD");
}

function run(repo, before, after) {
  return decideRelayDeployment({ cwd: repo.cwd, before, after });
}

function withRepo(callback) {
  const repo = fixture();
  try {
    return callback(repo);
  } finally {
    rmSync(repo.cwd, { recursive: true, force: true });
  }
}

test("normalizers ignore unrelated root fields and unrelated lockfile importers", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const changedManifest = { ...manifest, description: "different" };
  assert.equal(normalizeRootManifest(JSON.stringify(manifest)), normalizeRootManifest(JSON.stringify(changedManifest)));

  const changedLockfile = LOCKFILE.replace("version: 6.4.3", "version: 6.4.4");
  assert.equal(normalizeLockfileSlice(LOCKFILE), normalizeLockfileSlice(changedLockfile));

  const changedSettings = LOCKFILE.replace("autoInstallPeers: true", "autoInstallPeers: false");
  assert.equal(normalizeLockfileSlice(LOCKFILE), normalizeLockfileSlice(changedSettings));
});

test("skips unrelated web/docs and root manifest changes", () => {
  withRepo((repo) => {
    const docs = commit(repo.cwd, { "website/notes.md": "docs\n", "README.md": "updated\n" }, "docs");
    assert.equal(run(repo, repo.base, docs).deploy, false);

    const manifest = JSON.parse(readFileSync(join(repo.cwd, "package.json"), "utf8"));
    manifest.description = "unrelated metadata";
    const root = commit(repo.cwd, { "package.json": `${JSON.stringify(manifest, null, 2)}\n` }, "metadata");
    assert.equal(run(repo, docs, root).deploy, false);

    manifest.devDependencies["@resvg/resvg-js"] = "2.6.3";
    const unrelatedDependency = commit(repo.cwd, { "package.json": `${JSON.stringify(manifest, null, 2)}\n` }, "unrelated root dependency");
    assert.equal(run(repo, root, unrelatedDependency).deploy, false);

    manifest.pnpm.autoInstallPeers = false;
    const unrelatedPnpmSetting = commit(repo.cwd, { "package.json": `${JSON.stringify(manifest, null, 2)}\n` }, "unrelated pnpm setting");
    assert.equal(run(repo, unrelatedDependency, unrelatedPnpmSetting).deploy, false);
  });
});

test("deploys for Worker paths, the conservative tunnel, tsconfig, and workflow inputs", () => {
  withRepo((repo) => {
    for (const [file, contents] of [
      ["relay-worker/src/index.ts", "export {};\n"],
      ["packages/tunnel/src/index.ts", "export {};\n"],
      ["tsconfig.base.json", "{\"compilerOptions\":{\"strict\":false}}\n"],
      [".github/workflows/ci.yml", "name: changed\n"],
      ["scripts/relay-deploy-decision.mjs", "export {};\n"],
      ["scripts/relay-deploy-decision.spec.mjs", "export {};\n"],
    ]) {
      const head = commit(repo.cwd, { [file]: contents }, file);
      assert.equal(run(repo, repo.base, head).deploy, true, file);
      if (file.startsWith("packages/tunnel/")) {
        assert.match(run(repo, repo.base, head).reason, /relay test dependency, not a Worker runtime dependency/);
      }
    }
  });
});

test("retains a Worker trigger across a multiple-commit pushed range", () => {
  withRepo((repo) => {
    const first = commit(repo.cwd, { "relay-worker/src/index.ts": "export const first = true;\n" }, "worker");
    const second = commit(repo.cwd, { "website/notes.md": "unrelated later commit\n" }, "docs");
    const decision = run(repo, repo.base, second);
    assert.equal(decision.deploy, true);
    assert.match(decision.reason, /relay Worker/);
    assert.ok(first);
  });
});

test("deploys for selected root toolchain fields but not unrelated scripts", () => {
  withRepo((repo) => {
    const manifest = JSON.parse(readFileSync(join(repo.cwd, "package.json"), "utf8"));
    manifest.scripts.test = "changed test";
    const unrelated = commit(repo.cwd, { "package.json": `${JSON.stringify(manifest, null, 2)}\n` }, "unrelated script");
    assert.equal(run(repo, repo.base, unrelated).deploy, false);

    manifest.packageManager = "pnpm@10.10.0";
    const relevant = commit(repo.cwd, { "package.json": `${JSON.stringify(manifest, null, 2)}\n` }, "toolchain");
    assert.equal(run(repo, unrelated, relevant).deploy, true);

    manifest.devDependencies.typescript = "^5.9.3";
    const relevantDependency = commit(repo.cwd, { "package.json": `${JSON.stringify(manifest, null, 2)}\n` }, "Worker compiler");
    assert.equal(run(repo, relevant, relevantDependency).deploy, true);

    manifest.pnpm.onlyBuiltDependencies = ["better-sqlite3"];
    const relevantPnpmSetting = commit(repo.cwd, { "package.json": `${JSON.stringify(manifest, null, 2)}\n` }, "Worker bundler approval");
    assert.equal(run(repo, relevantDependency, relevantPnpmSetting).deploy, true);
  });
});

test("deploys for relevant lockfile importer/toolchain changes but not another importer", () => {
  withRepo((repo) => {
    const unrelatedLockfile = commit(repo.cwd, { "pnpm-lock.yaml": LOCKFILE.replace("version: 6.4.3", "version: 6.4.4") }, "web importer");
    assert.equal(run(repo, repo.base, unrelatedLockfile).deploy, false);

    const unrelatedRootImporter = commit(repo.cwd, { "pnpm-lock.yaml": LOCKFILE.replace("version: 2.6.2", "version: 2.6.3") }, "root application dependency");
    assert.equal(run(repo, unrelatedLockfile, unrelatedRootImporter).deploy, false);

    const relevantRootImporter = commit(repo.cwd, { "pnpm-lock.yaml": LOCKFILE.replace("version: 5.9.3", "version: 5.9.4") }, "root compiler importer");
    assert.equal(run(repo, unrelatedRootImporter, relevantRootImporter).deploy, true);

    const relevantImporter = commit(repo.cwd, { "pnpm-lock.yaml": LOCKFILE.replace("version: 4.114.0", "version: 4.115.0") }, "worker importer");
    assert.equal(run(repo, relevantRootImporter, relevantImporter).deploy, true);

    const relevantToolchain = commit(repo.cwd, { "pnpm-lock.yaml": LOCKFILE.replace("sha512-typescript", "sha512-new-typescript") }, "toolchain record");
    assert.equal(run(repo, relevantImporter, relevantToolchain).deploy, true);
  });
});

test("fails open for missing, unreachable, and ambiguous comparisons", () => {
  withRepo((repo) => {
    const head = commit(repo.cwd, { "README.md": "head\n" }, "head");
    for (const before of [undefined, "", "0000000000000000000000000000000000000000", "not-a-revision"]) {
      const decision = run(repo, before, head);
      assert.equal(decision.deploy, true, String(before));
      assert.match(decision.reason, /fail-open deployment/);
    }
  });
});

test("formats the revisions, action, and reason for the Actions output", () => {
  withRepo((repo) => {
    const head = commit(repo.cwd, { "README.md": "head\n" }, "head");
    const output = formatDecision(run(repo, repo.base, head));
    assert.match(output, new RegExp(`deploy=false`));
    assert.match(output, new RegExp(`before=${repo.base}`));
    assert.match(output, new RegExp(`after=${head}`));
    assert.match(output, /reason=Compared/);
  });
});

test("keeps Pages unconditional and gates only the Worker on the full-range output", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.match(workflow, /needs: \[verify, commit-installers, relay_decision\]/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /if: needs\.relay_decision\.outputs\.deploy == 'true'\n        run: pnpm --filter @codor\/relay-worker run deploy/);
  assert.match(workflow, /- name: Build, verify, and deploy codor\.app\n        run: pnpm deploy:app/);
  assert.match(workflow, /RELAY_COMPARE_BEFORE: \$\{\{ github\.event\.before \}\}/);
  assert.match(workflow, /RELAY_COMPARE_AFTER: \$\{\{ github\.sha \}\}/);
});
// harn:end relay-worker-deploy-decision-is-full-range-and-fail-open
