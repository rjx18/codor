import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
const manifests = ['package.json', 'relay/package.json', 'website/package.json'];

for (const entry of await readdir(new URL('../packages/', import.meta.url), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (entry.name === 'adapters' || entry.name === 'bridges') {
    for (const nested of await readdir(new URL(`../packages/${entry.name}/`, import.meta.url), { withFileTypes: true })) {
      if (nested.isDirectory()) manifests.push(`packages/${entry.name}/${nested.name}/package.json`);
    }
  } else {
    manifests.push(`packages/${entry.name}/package.json`);
  }
}

for (const path of manifests.sort()) {
  const manifest = JSON.parse(await readFile(new URL(path, root), 'utf8'));
  assert.equal(manifest.license, 'MIT', `${path} must declare license MIT`);
}

const license = await readFile(new URL('../LICENSE', import.meta.url), 'utf8');
assert.match(license, /^MIT License\n/);
assert.match(license, /Copyright \(c\) 2026 Richard Xiong/);

const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: new URL('../', import.meta.url),
  encoding: 'utf8',
}).split('\0').filter(Boolean);
const source = tracked.filter((path) => /\.(?:cjs|css|html|js|jsx|mjs|scss|sh|ts|tsx|vue)$/.test(path));
const spdxPattern = new RegExp(`${['SPDX', 'License-Identifier'].join('-')}:\\s*([^\\s*]+)`, 'g');
const incompatibleHeaderPattern = new RegExp(
  [
    'GNU\\s+(?:(?:AFFERO|LESSER)\\s+)?GENERAL\\s+PUBLIC\\s+LICENSE',
    'Apache\\s+License',
    'Mozilla\\s+Public\\s+License',
    'All\\s+rights\\s+reserved',
  ].join('|'),
  'i',
);

function validateSource(path, body) {
  const spdxTags = [...body.matchAll(spdxPattern)].map((match) => match[1]);
  for (const spdx of spdxTags) {
    assert.equal(spdx, 'MIT', `${path} carries conflicting SPDX license ${spdx}`);
  }
  assert.doesNotMatch(body, incompatibleHeaderPattern, `${path} contains an incompatible license header`);
}

const spdxLabel = ['SPDX', 'License-Identifier'].join('-');
assert.throws(
  () => validateSource('multiple-header fixture', `// ${spdxLabel}: MIT\n// ${spdxLabel}: GPL-3.0-only`),
  /GPL-3\.0-only/,
);
assert.throws(
  () => validateSource('wrapped-header fixture', ['GNU AFFERO', 'GENERAL PUBLIC LICENSE'].join('\n')),
  /incompatible license header/,
);

for (const path of source) {
  const body = await readFile(new URL(path, root), 'utf8');
  validateSource(path, body);
}

process.stdout.write(`license audit passed: LICENSE, ${manifests.length} manifests, ${source.length} source files\n`);
