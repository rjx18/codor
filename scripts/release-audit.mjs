import assert from 'node:assert/strict';
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

process.stdout.write('release audit passed: pre-tag gates, relay disclosure, and acceptance provenance\n');
