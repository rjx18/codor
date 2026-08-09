import { execFileSync } from "node:child_process";

// harn:assume relay-worker-deploy-decision-is-full-range-and-fail-open ref=relay-deploy-decision
const DIRECT_DEPLOY_PATHS = new Map([
  ["tsconfig.base.json", "the shared TypeScript configuration changed"],
  [".github/workflows/ci.yml", "the deployment workflow changed"],
  ["scripts/relay-deploy-decision.mjs", "the deployment decision changed"],
  ["scripts/relay-deploy-decision.spec.mjs", "the deployment decision regression changed"],
]);

// packages/tunnel is intentionally conservative: it is currently a relay test
// dependency rather than a Worker runtime dependency, but its shared contract
// can still require a Worker redeploy.

const TOOLCHAIN_RECORD_PREFIXES = [
  "@cloudflare/",
  "@esbuild/",
  "@types/node@",
  "@vitest/",
  "esbuild@",
  "miniflare@",
  "typescript@",
  "vitest@",
  "workerd@",
  "wrangler@",
];

const RELEVANT_IMPORTERS = new Set([".", "packages/tunnel", "relay-worker"]);
// Only these root manifest paths can affect the Worker build/install toolchain.
// In particular, root application dependencies, arbitrary scripts, and
// unrelated pnpm settings must not turn a Pages-only change into a Worker
// deploy.
const ROOT_IMPORTER_TOOLCHAIN_DEPENDENCIES = new Set(["@types/node", "typescript", "vitest"]);
const ROOT_PNPM_TOOLCHAIN_DEPENDENCIES = new Set(["esbuild"]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function pick(object, keys) {
  const source = object && typeof object === "object" && !Array.isArray(object) ? object : {};
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));
}

export function normalizeRootManifest(source) {
  const manifest = JSON.parse(source);
  const onlyBuiltDependencies = manifest.pnpm?.onlyBuiltDependencies;
  return stableJson({
    packageManager: manifest.packageManager ?? null,
    engines: pick(manifest.engines, ["node"]),
    scripts: pick(manifest.scripts, ["build"]),
    devDependencies: pick(manifest.devDependencies, [...ROOT_IMPORTER_TOOLCHAIN_DEPENDENCIES].sort()),
    pnpm: {
      onlyBuiltDependencies: Array.isArray(onlyBuiltDependencies)
        ? onlyBuiltDependencies.filter((dependency) => ROOT_PNPM_TOOLCHAIN_DEPENDENCIES.has(dependency)).sort()
        : onlyBuiltDependencies ?? null,
    },
  });
}

function topLevelBlock(lines, section) {
  const start = lines.findIndex((line) => line === `${section}:`);
  if (start < 0) return null;
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 0 && !line.startsWith(" ")) break;
    block.push(line);
  }
  return block.join("\n").trimEnd();
}

function childBlocks(lines, section) {
  const start = lines.findIndex((line) => line === `${section}:`);
  if (start < 0) return null;
  const blocks = new Map();
  let current = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 0 && !line.startsWith(" ")) break;
    const match = line.match(/^  ([^\s].*?):\s*$/);
    if (match) {
      current = { key: match[1].replace(/^['"]|['"]$/g, ""), lines: [line] };
      blocks.set(current.key, current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return blocks;
}

function stripYamlKey(key) {
  return key.replace(/^['"]|['"]$/g, "");
}

function importerDependencyBlocks(lines) {
  const sections = new Map();
  let section = null;
  let current = null;
  for (const line of lines.slice(1)) {
    const sectionMatch = line.match(/^    ([^\s].*?):\s*$/);
    if (sectionMatch) {
      section = stripYamlKey(sectionMatch[1]);
      current = null;
      if (!sections.has(section)) sections.set(section, new Map());
      continue;
    }
    const dependencyMatch = line.match(/^      ([^\s].*?):\s*$/);
    if (section && dependencyMatch) {
      const key = stripYamlKey(dependencyMatch[1]);
      current = { key, lines: [line] };
      sections.get(section).set(key, current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return sections;
}

function normalizeRootImporter(block) {
  if (!block) return null;
  const sections = importerDependencyBlocks(block.lines);
  return Object.fromEntries(
    [...sections.entries()]
      .map(([section, dependencies]) => [
        section,
        Object.fromEntries(
          [...dependencies.entries()]
            .filter(([key]) => ROOT_IMPORTER_TOOLCHAIN_DEPENDENCIES.has(key))
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, dependency]) => [key, dependency.lines.join("\n")]),
        ),
      ])
      .filter(([, dependencies]) => Object.keys(dependencies).length > 0),
  );
}

function isToolchainRecord(key) {
  return TOOLCHAIN_RECORD_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function normalizeLockfileSlice(source) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const lockfileVersion = lines.find((line) => line.startsWith("lockfileVersion:"));
  const settings = topLevelBlock(lines, "settings");
  const importerBlocks = childBlocks(lines, "importers");
  const packageBlocks = childBlocks(lines, "packages");
  const snapshotBlocks = childBlocks(lines, "snapshots");

  if (!lockfileVersion || !settings || !importerBlocks || !packageBlocks || !snapshotBlocks) {
    throw new Error("lockfile does not contain the expected pnpm sections");
  }

  const selectedImporters = Object.fromEntries(
    [...RELEVANT_IMPORTERS]
      .sort()
      .map((key) => [
        key,
        key === "."
          ? normalizeRootImporter(importerBlocks.get(key))
          : importerBlocks.get(key)?.lines.join("\n") ?? null,
      ]),
  );
  const selectedToolchain = (blocks) =>
    Object.fromEntries(
      [...blocks.entries()]
        .filter(([key]) => isToolchainRecord(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, block]) => [key, block.lines.join("\n")]),
    );

  return stableJson({
    lockfileVersion,
    importers: selectedImporters,
    packages: selectedToolchain(packageBlocks),
    snapshots: selectedToolchain(snapshotBlocks),
  });
}

function normalizeRevision(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function displayRevision(value) {
  return value || "<missing>";
}

function gitCommand(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function revisionCommit(cwd, revision) {
  const resolved = gitCommand(cwd, ["rev-parse", "--verify", `${revision}^{commit}`]);
  if (!/^[0-9a-f]{40}$/i.test(resolved)) throw new Error("revision is not a single commit");
  return resolved;
}

function revisionFile(cwd, revision, file) {
  return gitCommand(cwd, ["show", `${revision}:${file}`]);
}

function result({ deploy, before, after, reason, changedPaths = [] }) {
  return {
    deploy,
    action: deploy ? "deploy" : "skip",
    before,
    after,
    reason,
    changedPaths,
  };
}

function unavailable({ before, after, detail }) {
  return result({
    deploy: true,
    before,
    after,
    reason: `Comparison unavailable for ${displayRevision(before)} -> ${displayRevision(after)} (${detail}); fail-open deployment is required.`,
  });
}

function relevantManifestChanged(cwd, before, after) {
  try {
    return normalizeRootManifest(revisionFile(cwd, before, "package.json")) !== normalizeRootManifest(revisionFile(cwd, after, "package.json"));
  } catch (error) {
    throw new Error(`package.json comparison is ambiguous: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function relevantLockfileChanged(cwd, before, after) {
  try {
    return normalizeLockfileSlice(revisionFile(cwd, before, "pnpm-lock.yaml")) !== normalizeLockfileSlice(revisionFile(cwd, after, "pnpm-lock.yaml"));
  } catch (error) {
    throw new Error(`pnpm-lock.yaml comparison is ambiguous: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isMissingBase(before) {
  return !before || /^0+$/.test(before);
}

/**
 * Decide whether the relay Worker must be deployed for a complete pushed range.
 * This function deliberately uses git without a shell so callers can safely pass
 * GitHub-provided revisions and the workflow can fail open on any comparison
 * problem instead of silently skipping a potentially stale Worker.
 */
export function decideRelayDeployment({ before, after, cwd = process.cwd() }) {
  const normalizedBefore = normalizeRevision(before);
  const normalizedAfter = normalizeRevision(after);

  if (isMissingBase(normalizedBefore)) {
    return unavailable({ before: normalizedBefore, after: normalizedAfter, detail: "the before SHA is missing" });
  }
  if (!normalizedAfter) {
    return unavailable({ before: normalizedBefore, after: normalizedAfter, detail: "the after SHA is missing" });
  }

  let beforeCommit;
  let afterCommit;
  try {
    beforeCommit = revisionCommit(cwd, normalizedBefore);
    afterCommit = revisionCommit(cwd, normalizedAfter);
    gitCommand(cwd, ["merge-base", "--is-ancestor", beforeCommit, afterCommit]);
  } catch (error) {
    return unavailable({
      before: normalizedBefore,
      after: normalizedAfter,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  let changedPaths;
  try {
    changedPaths = gitCommand(cwd, ["diff", "--name-only", "--no-renames", beforeCommit, afterCommit])
      .split("\n")
      .map((path) => path.trim())
      .filter(Boolean);
  } catch (error) {
    return unavailable({
      before: normalizedBefore,
      after: normalizedAfter,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const changedSet = new Set(changedPaths);
  for (const path of changedPaths) {
    if (path.startsWith("relay-worker/")) {
      return result({ deploy: true, before: normalizedBefore, after: normalizedAfter, changedPaths, reason: `Compared ${normalizedBefore} -> ${normalizedAfter}: ${path} changes the relay Worker.` });
    }
    if (path.startsWith("packages/tunnel/")) {
      return result({ deploy: true, before: normalizedBefore, after: normalizedAfter, changedPaths, reason: `Compared ${normalizedBefore} -> ${normalizedAfter}: ${path} changes the conservative tunnel shared-contract trigger (currently a relay test dependency, not a Worker runtime dependency).` });
    }
    const directReason = DIRECT_DEPLOY_PATHS.get(path);
    if (directReason) {
      return result({ deploy: true, before: normalizedBefore, after: normalizedAfter, changedPaths, reason: `Compared ${normalizedBefore} -> ${normalizedAfter}: ${directReason}.` });
    }
  }

  if (changedSet.has("package.json")) {
    try {
      if (relevantManifestChanged(cwd, beforeCommit, afterCommit)) {
        return result({ deploy: true, before: normalizedBefore, after: normalizedAfter, changedPaths, reason: `Compared ${normalizedBefore} -> ${normalizedAfter}: a selected root manifest build/deploy/toolchain field changed.` });
      }
    } catch (error) {
      return unavailable({ before: normalizedBefore, after: normalizedAfter, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  if (changedSet.has("pnpm-lock.yaml")) {
    try {
      if (relevantLockfileChanged(cwd, beforeCommit, afterCommit)) {
        return result({ deploy: true, before: normalizedBefore, after: normalizedAfter, changedPaths, reason: `Compared ${normalizedBefore} -> ${normalizedAfter}: a selected lockfile importer or toolchain record changed.` });
      }
    } catch (error) {
      return unavailable({ before: normalizedBefore, after: normalizedAfter, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  return result({
    deploy: false,
    before: normalizedBefore,
    after: normalizedAfter,
    changedPaths,
    reason: `Compared ${normalizedBefore} -> ${normalizedAfter}: no relay Worker, conservative tunnel, deployment, or selected toolchain input changed; skip the Worker and deploy Pages only.`,
  });
}

export function formatDecision(decision) {
  return [
    `deploy=${decision.deploy}`,
    `before=${displayRevision(decision.before)}`,
    `after=${displayRevision(decision.after)}`,
    `reason=${decision.reason}`,
  ].join("\n");
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const before = argumentValue(process.argv.slice(2), "--before") ?? process.env.RELAY_COMPARE_BEFORE;
  const after = argumentValue(process.argv.slice(2), "--after") ?? process.env.RELAY_COMPARE_AFTER;
  console.log(formatDecision(decideRelayDeployment({ before, after })));
}
// harn:end relay-worker-deploy-decision-is-full-range-and-fail-open
