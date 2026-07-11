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
const source = tracked.filter((path) => /\.(?:css|js|mjs|sh|ts|tsx)$/.test(path));
const spdxPattern = new RegExp(`${['SPDX', 'License-Identifier'].join('-')}:\\s*([^\\s*]+)`);
const agplHeaderPattern = new RegExp(['GNU', 'AFFERO', 'GENERAL', 'PUBLIC', 'LICENSE'].join(' '), 'i');
for (const path of source) {
  const body = await readFile(new URL(path, root), 'utf8');
  const spdx = body.match(spdxPattern);
  assert.ok(!spdx || spdx[1] === 'MIT', `${path} carries conflicting SPDX license ${spdx?.[1]}`);
  assert.doesNotMatch(body, agplHeaderPattern, `${path} contains an AGPL license header`);
}

process.stdout.write(`license audit passed: LICENSE, ${manifests.length} manifests, ${source.length} source files\n`);
