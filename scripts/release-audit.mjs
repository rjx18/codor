import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const manual = await readFile(new URL('../MANUAL-VERIFY.md', import.meta.url), 'utf8');
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

const checklistStart = manual.indexOf('## Final operator release checklist');
const checklistEnd = manual.indexOf('## Launch-sweep live acceptance record');
assert.ok(checklistStart >= 0 && checklistEnd > checklistStart, 'release checklist boundaries are missing');
const checklist = manual.slice(checklistStart, checklistEnd);

const codexGate = checklist.indexOf('full-repository Codex review');
const liveGate = checklist.indexOf('M0 and M1 live acceptances');
const tag = checklist.indexOf('signed release tag');
assert.ok(codexGate >= 0 && liveGate >= 0 && tag >= 0, 'pre-tag gates or tag step are missing');
assert.ok(codexGate < tag, 'full-repository Codex review must precede the release tag');
assert.ok(liveGate < tag, 'M0/M1 live acceptance must precede the release tag');
assert.match(checklist, /Both\n?\s*exact chains must pass before tagging 0\.1\.0/);

assert.match(readme, /sealed payloads plus delivery\nmetadata/);
assert.doesNotMatch(readme, /sealed payloads but delivery/);

assert.match(manual, /historical M0 transcript was an\nignored run artifact until `27d7944`/);
assert.match(manual, /successful completion recorded in\n`1a8ae03`/);
assert.match(manual, /prior tracked M1 pass is in `79eac33`/);

// harn:assume release-audits-enforce-codor-clean-break ref=rename-release-audit
const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
}).split('\0').filter(Boolean);
const existingTracked = tracked.filter((path) => existsSync(new URL(`../${path}`, import.meta.url)));

// harn:assume supported-browser-is-standalone-web-next ref=standalone-browser-release-audit
assert.ok(
  !existsSync(new URL('../packages/web', import.meta.url)),
  'the deprecated packages/web workspace must not ship',
);
for (const path of existingTracked.filter((candidate) =>
  candidate.startsWith('packages/web-next/') &&
  /\.(?:html|js|json|mjs|ts|tsx)$/.test(candidate))) {
  const body = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  assert.doesNotMatch(body, /@legacy|\.\.\/web\/src|packages\/web\/src/, `${path} depends on the legacy web source tree`);
}
// harn:end supported-browser-is-standalone-web-next

const legacyName = ['wire', 'room'].join('');
const immutableRecordedFixtures = new Set([
  'packages/adapters/claude-code/fixtures/permission-deny.jsonl',
  'packages/adapters/claude-code/fixtures/permission-deny.stdin.jsonl',
]);

for (const path of existingTracked) {
  if (
    path === 'CHANGELOG.md' ||
    path.startsWith('.harn/') ||
    path.startsWith('tmp/') ||
    immutableRecordedFixtures.has(path)
  ) continue;
  const bytes = await readFile(new URL(`../${path}`, import.meta.url));
  if (bytes.includes(0)) continue;
  let body = bytes.toString('utf8');
  if (path === 'MANUAL-VERIFY.md') {
    body = body
      .split('\n')
      .filter((line) => !(line.includes(`/home/richard/git/${legacyName}`) && line.includes('mode, ran from')))
      .join('\n');
  }
  assert.doesNotMatch(body, new RegExp(legacyName, 'i'), `${path} contains legacy product branding`);
}

const visibleRoomPatterns = [
  /\b(?:aria-label|title|placeholder)=["'][^"']*\brooms?\b/i,
  /<[A-Za-z][^>\n]*>[ \t]*[A-Za-z][^<{\n]*\brooms?\b/i,
  /\b(?:throw new Error|setNotice)\(\s*["'`][^"'`]*\brooms?\b/i,
  /\breturn\s+["'`](?![^"'`]*(?:\?|room:|\/api\/))[^"'`]*\brooms?\b/i,
];
const approvedGenericRoomCopy = new Map([
  ['packages/web-next/src/app/computer-sessions.ts', [
    "throw new Error('stale tunnel generation after room loading')",
  ]],
  ['packages/web-next/src/room/RoomPage.tsx', ["throw new Error('RoomPage requires a room connector')"]],
  ['packages/web-next/src/surfaces/SettingsPage.tsx', ["throw new Error('Settings requires a room connector')"]],
  ['packages/web-next/src/surfaces/LandingPage.tsx', [
    'doing so beside the daemon would fork the room.',
    'title="Voice control that stays in the room."',
  ]],
]);
for (const path of existingTracked.filter((candidate) =>
  candidate.startsWith('packages/web-next/src/') &&
  /\.(?:ts|tsx)$/.test(candidate) &&
  !/\.spec\.(?:ts|tsx)$/.test(candidate))) {
  let body = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  // These exact strings use "room" generically or in internal invariant errors;
  // they are not product-facing names for Channels. Keep the exception exact so
  // any additional legacy UI terminology still fails this audit.
  for (const approved of approvedGenericRoomCopy.get(path) ?? []) {
    body = body.replace(approved, '');
  }
  for (const pattern of visibleRoomPatterns) {
    assert.doesNotMatch(body, pattern, `${path} contains operator-visible room wording`);
  }
}
// harn:end release-audits-enforce-codor-clean-break

const landingSource = await readFile(new URL('../packages/web-next/src/surfaces/LandingPage.tsx', import.meta.url), 'utf8');
const firstChannelSource = await readFile(new URL('../packages/web-next/src/surfaces/NoChannels.tsx', import.meta.url), 'utf8');
const agentControlsSource = await readFile(new URL('../packages/web-next/src/room/AgentControls.tsx', import.meta.url), 'utf8');

// harn:assume unpaired-root-explains-primary-install-and-hosted-access ref=landing-access-truth-audit
assert.equal((landingSource.match(/className="nx-setup-step"/g) ?? []).length, 2, 'landing setup must have exactly two steps');
assert.match(landingSource, /npx @richhardry\/codor install/);
assert.match(landingSource, /localhost/);
assert.match(landingSource, /Tailscale/);
// The blind relay is implemented, so the landing must name the hosted third
// access path (browser at codor.app -> self-hosted switchboard) AND describe the
// relay's limits truthfully per PLAN §2.2: it never receives channel keys and
// sees ciphertext only. The
// paired asserts fail if the honest explanation is deleted while a codor.app link survives.
assert.match(landingSource, /codor\.app/, 'landing must name the hosted codor.app access path');
assert.match(landingSource, /never receives your channel keys/, 'landing must state the relay never receives channel keys');
assert.match(landingSource, /Relay sees ciphertext only/, 'landing must state the relay sees ciphertext only');
// harn:end unpaired-root-explains-primary-install-and-hosted-access

// harn:assume landing-demo-settles-without-playback-controls ref=landing-motion-release-audit
assert.match(landingSource, /prefers-reduced-motion: reduce/);
assert.match(landingSource, /phase >= FINAL_PHASE/);
// harn:end landing-demo-settles-without-playback-controls

// harn:assume paired-empty-state-creates-first-channel ref=first-channel-onboarding-audit
assert.match(firstChannelSource, /createRoom\(/);
assert.match(firstChannelSource, /first-channel-name/);
assert.match(firstChannelSource, /nameEdited/);
assert.match(firstChannelSource, /AgentControls/);
assert.doesNotMatch(firstChannelSource, /Create one from another surface/);
// harn:end paired-empty-state-creates-first-channel

// harn:assume shared-form-sections-follow-their-host-outline ref=shared-section-heading-audit
assert.match(agentControlsSource, /headingLevel\?: 2 \| 3/);
assert.equal((firstChannelSource.match(/headingLevel=\{2\}/g) ?? []).length, 2);
// harn:end shared-form-sections-follow-their-host-outline

const selfHost = await readFile(new URL('../docs/SELF-HOST.md', import.meta.url), 'utf8');
const setupGuide = await readFile(new URL('../docs/SETUP.md', import.meta.url), 'utf8');
const rootManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const switchboardManifest = JSON.parse(await readFile(new URL('../packages/switchboard/package.json', import.meta.url), 'utf8'));
const workspaceManifest = await readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8');
const ciWorkflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const releaseWorkflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const releaseArtifactBuilder = await readFile(new URL('../scripts/package-release-artifacts.sh', import.meta.url), 'utf8');
const copilotBridgeReadme = await readFile(
  new URL('../packages/adapters/copilot/vscode-extension/README.md', import.meta.url),
  'utf8',
);

// harn:assume installed-or-published-release-artifacts-are-version-immutable ref=replaceable-preinstall-release-audit
assert.match(manual, /Versioned release artifact immutability/);
assert.match(manual, /source commit, versioned filename,\s*byte size, and SHA-256 digest/s);
assert.match(manual, /Once that version is published or\s*installed, its filename and payload bytes are immutable/);
assert.match(manual, /advance the\s*release version before rebuilding or sending it/);
assert.match(manual, /explicitly withdraw and replace a candidate at the same version only after\s*confirming it was not published or installed/);
assert.match(manual, /Treat every previously transferred copy as invalid/);
assert.equal(rootManifest.version, '0.10.14-alpha.4', 'the release candidate must advance to 0.10.14-alpha.4');
const legacyPackageVersions = new Set([
  'packages/adapters/grok/package.json',
  'packages/tunnel/package.json',
  'relay-worker/package.json',
]);
for (const path of tracked.filter((candidate) => candidate.endsWith('package.json'))) {
  if (legacyPackageVersions.has(path)) continue;
  const manifestPath = new URL(`../${path}`, import.meta.url);
  if (!existsSync(manifestPath)) continue;
  const manifestBody = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (typeof manifestBody.version === 'string') {
    assert.equal(manifestBody.version, rootManifest.version, `${path} must share the release version`);
  }
}
const acpAdapterSource = await readFile(new URL('../packages/adapters/acp/src/adapter.ts', import.meta.url), 'utf8');
assert.match(acpAdapterSource, /clientInfo:\s*\{\s*name: 'Codor', version: '0\.10\.14-alpha\.4'/);
// harn:end installed-or-published-release-artifacts-are-version-immutable

// harn:assume switchboard-static-serving-dependency-is-security-patched ref=patched-fastify-static-release-audit
const staticRange = switchboardManifest.dependencies?.['@fastify/static'];
assert.match(staticRange ?? '', /^\^10\.\d+\.\d+$/, 'switchboard must use @fastify/static major 10');
const [staticMajor, staticMinor, staticPatch] = staticRange.slice(1).split('.').map(Number);
assert.equal(staticMajor, 10);
assert.ok(
  staticMinor > 1 || (staticMinor === 1 && staticPatch >= 2),
  'switchboard must use security-patched @fastify/static >=10.1.2 within major 10',
);
// harn:end switchboard-static-serving-dependency-is-security-patched

// harn:assume pnpm-build-approvals-span-pinned-and-current-config ref=pnpm-build-approval-equivalence-audit
const requiredBuildApprovals = ['better-sqlite3', 'esbuild', 'sodium-native', 'udx-native'];
const legacyBuildApprovals = [...(rootManifest.pnpm?.onlyBuiltDependencies ?? [])].sort();
const allowBuilds = workspaceManifest.match(/^allowBuilds:\n((?:^  [^\n]+\n?)*)/m);
assert.ok(allowBuilds, 'pnpm-workspace.yaml must declare allowBuilds');
const currentBuildApprovals = [...allowBuilds[1].matchAll(/^  ([^:#\n]+): true$/gm)]
  .map((match) => match[1])
  .sort();
assert.deepEqual(
  legacyBuildApprovals,
  requiredBuildApprovals,
  'package.json pnpm.onlyBuiltDependencies must approve every required build script',
);
assert.deepEqual(
  currentBuildApprovals,
  legacyBuildApprovals,
  'pnpm-workspace.yaml allowBuilds must match package.json pnpm.onlyBuiltDependencies',
);
// harn:end pnpm-build-approvals-span-pinned-and-current-config

// harn:assume public-npx-install-is-primary-install ref=release-install-audit
for (const [name, body] of [['README', readme], ['self-host guide', selfHost], ['setup guide', setupGuide]]) {
  assert.match(body, /npx @richhardry\/codor install/, `${name} must document the public install command`);
  assert.match(body, /setup.*backward-compatible alias/i, `${name} must retain the setup compatibility alias`);
}
assert.equal(rootManifest.engines?.node, '>=22.12.0');
assert.doesNotMatch(readme.slice(0, readme.indexOf('## Everyday CLI')), /scripts\/install-cli\.sh\s*\n(?:codor setup)?/);
// harn:end public-npx-install-is-primary-install

// harn:assume packed-release-proof-runs-install-runtime ref=root-release-gate
assert.match(rootManifest.scripts?.['release:check'] ?? '', /scripts\/packed-install-test\.sh/);
assert.match(rootManifest.scripts?.['release:check'] ?? '', /scripts\/fresh-install-test\.sh/);
// harn:end packed-release-proof-runs-install-runtime

// harn:assume packed-release-proof-runs-install-runtime ref=release-proof-audit
const packedProof = await readFile(new URL('../scripts/packed-install-test.sh', import.meta.url), 'utf8');
const packedSourceCapture = packedProof.indexOf('SOURCE_ROOT="${CODOR_PACKED_SOURCE');
const packedRefCapture = packedProof.indexOf('SOURCE_REF="${CODOR_PACKED_REF');
const packedRuntimeScrub = packedProof.indexOf("compgen -A variable | grep '^CODOR_'");
assert.ok(packedSourceCapture >= 0 && packedSourceCapture < packedRuntimeScrub);
assert.ok(packedRefCapture >= 0 && packedRefCapture < packedRuntimeScrub);
assert.match(packedProof, /--network none/);
assert.match(packedProof, /--package="\$TARBALL" codor install --dry-run/);
assert.match(packedProof, /\/sw\.js/);
assert.match(packedProof, /third-party-adapter\.mjs/);
// harn:assume packed-local-tgz-npx-proof-runs-fresh-default-audit ref=packed-npx-fresh-default-audit-audit
assert.match(packedProof, /test ! -e "\$NPX_PROOF_CACHE"/);
assert.match(packedProof, /export npm_config_cache="\$NPX_PROOF_CACHE"/);
assert.match(packedProof, /PACKAGED_WARM_DRY_RUN=.*npx --yes --package="\$TARBALL"/);
assert.doesNotMatch(packedProof, /npm_config_audit|--no-audit/);
// harn:end packed-local-tgz-npx-proof-runs-fresh-default-audit
// harn:end packed-release-proof-runs-install-runtime

// harn:assume verified-commit-installers-are-sha-addressed-and-ephemeral ref=commit-installer-release-audit
const commitInstallerJobStart = ciWorkflow.indexOf('commit-installers:');
const commitInstallerJobEnd = ciWorkflow.indexOf('deploy-production:', commitInstallerJobStart);
assert.ok(commitInstallerJobStart >= 0 && commitInstallerJobEnd > commitInstallerJobStart);
const commitInstallerJob = ciWorkflow.slice(commitInstallerJobStart, commitInstallerJobEnd);
assert.match(commitInstallerJob, /needs:\s+verify/);
assert.match(commitInstallerJob, /permissions:\s+contents:\s+read/);
assert.match(commitInstallerJob, /scripts\/package-release-artifacts\.sh/);
assert.match(commitInstallerJob, /actions\/upload-artifact@v7/);
assert.match(commitInstallerJob, /name: codor-installers-\$\{\{\s*github\.sha\s*\}\}/);
assert.match(commitInstallerJob, /retention-days:\s*14/);
assert.doesNotMatch(commitInstallerJob, /npm\s+publish|gh\s+release|CLOUDFLARE_|deploy:app/);
assert.match(releaseArtifactBuilder, /pnpm build:artifact/);
assert.match(releaseArtifactBuilder, /\$ROOT\/packages\/adapters\/copilot\/node_modules\/\.bin\/vsce" package/);
assert.doesNotMatch(releaseArtifactBuilder, /pnpm dlx|rm -rf -- "\$OUT_DIR"/);
assert.match(releaseArtifactBuilder, /SHA256SUMS/);
assert.match(manual, /codor-installers-<full commit SHA>/);
// harn:end verified-commit-installers-are-sha-addressed-and-ephemeral

// harn:assume github-tags-publish-numbered-semver-alpha-or-stable-release ref=github-release-policy-audit
assert.match(releaseWorkflow, /tags:\s*\n\s+- ['"]v\*\.\*\.\*['"]/);
assert.match(releaseWorkflow, /permissions:\s*\{\}/);
assert.match(releaseWorkflow, /contents:\s+write/);
assert.match(releaseWorkflow, /id-token:\s+write/);
assert.match(releaseWorkflow, /environment:\s*\n\s+name:\s+release/);
assert.match(releaseWorkflow, /registry-url:\s*https:\/\/registry\.npmjs\.org/);
assert.match(releaseWorkflow, /package-manager-cache:\s*false/);
assert.doesNotMatch(releaseWorkflow, /cache:\s*pnpm/);
assert.match(releaseWorkflow, /npm install --global npm@11\.19\.0/);
assert.match(releaseWorkflow, /pnpm release:check/);
assert.match(
  releaseWorkflow,
  /name:\s*Run the complete release gate[\s\S]*?CODOR_FRESH_REF:\s*\$\{\{\s*github\.ref_name\s*\}\}/,
);
assert.match(
  releaseWorkflow,
  /name:\s*Run the complete release gate[\s\S]*?CODOR_PACKED_REF:\s*\$\{\{\s*github\.ref_name\s*\}\}/,
);
assert.match(releaseWorkflow, /git merge-base[\s\S]*origin\/main/);
assert.match(releaseWorkflow, /git merge-base[\s\S]*origin\/alpha/);
assert.match(releaseWorkflow, /vX\.Y\.Z or vX\.Y\.Z-alpha\.N/);
assert.ok(releaseWorkflow.includes('^v[0-9]+\\.[0-9]+\\.[0-9]+-alpha\\.(0|[1-9][0-9]*)$'));
assert.match(releaseWorkflow, /RELEASE_KIND=stable[\s\S]*NPM_TAG=latest/);
assert.match(releaseWorkflow, /RELEASE_KIND=alpha[\s\S]*NPM_TAG=alpha/);
assert.match(releaseWorkflow, /stable tag commit is not contained in main/);
assert.match(releaseWorkflow, /alpha tag commit must be outside main and contained in the curated alpha branch/);
assert.match(releaseWorkflow, /NPM_TAG=latest/);
assert.match(releaseWorkflow, /NPM_TAG=alpha/);
assert.match(releaseWorkflow, /npm view[\s\S]*@richhardry\/codor/);
assert.match(releaseWorkflow, /gh release view/);
assert.match(releaseWorkflow, /npm publish[\s\S]*--access public[\s\S]*--tag/);
assert.match(releaseWorkflow, /--provenance/);
assert.match(releaseWorkflow, /gh release create/);
assert.match(releaseWorkflow, /ARGS=\(--repo "\$GITHUB_REPOSITORY" --verify-tag --title/);
assert.doesNotMatch(releaseWorkflow, /--verify-tag\s+"\$GITHUB_REF_NAME"/);
assert.match(releaseWorkflow, /--prerelease/);
assert.match(releaseWorkflow, /SHA256SUMS/);
assert.doesNotMatch(releaseWorkflow, /pull_request/);
assert.doesNotMatch(releaseWorkflow, /NPM_TOKEN/);
assert.match(copilotBridgeReadme, /matching Codor GitHub\s+Release/);
assert.doesNotMatch(copilotBridgeReadme, /Install this extension from its Marketplace page/i);
// harn:end github-tags-publish-numbered-semver-alpha-or-stable-release

process.stdout.write('release audit passed: pre-tag gates, rename, relay disclosure, and acceptance provenance\n');
