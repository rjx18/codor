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
const tag = checklist.indexOf('signed `v0.1.0` tag');
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
for (const path of existingTracked.filter((candidate) =>
  candidate.startsWith('packages/web-next/src/') &&
  /\.(?:ts|tsx)$/.test(candidate) &&
  !/\.spec\.(?:ts|tsx)$/.test(candidate))) {
  const body = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  for (const pattern of visibleRoomPatterns) {
    assert.doesNotMatch(body, pattern, `${path} contains operator-visible room wording`);
  }
}
// harn:end release-audits-enforce-codor-clean-break

const landingSource = await readFile(new URL('../packages/web-next/src/surfaces/LandingPage.tsx', import.meta.url), 'utf8');

// harn:assume unpaired-root-offers-two-step-local-setup ref=landing-setup-truth-audit
assert.equal((landingSource.match(/className="nx-setup-step"/g) ?? []).length, 2, 'landing setup must have exactly two steps');
assert.match(landingSource, /npx @richhardry\/codor setup/);
assert.match(landingSource, /localhost/);
assert.match(landingSource, /Tailscale/);
assert.doesNotMatch(landingSource, /relay|cloudflare|hosted[ -]cloud/i);
// harn:end unpaired-root-offers-two-step-local-setup

// harn:assume landing-demo-plays-once-and-settles ref=landing-motion-release-audit
assert.match(landingSource, /prefers-reduced-motion: reduce/);
assert.match(landingSource, /Pause demo/);
assert.match(landingSource, /phase >= FINAL_PHASE/);
// harn:end landing-demo-plays-once-and-settles

process.stdout.write('release audit passed: pre-tag gates, rename, relay disclosure, and acceptance provenance\n');
