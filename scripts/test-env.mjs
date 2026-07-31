#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  process.stderr.write('usage: test-env.mjs <command> [args...]\n');
  process.exit(2);
}

// harn:assume cli-tests-delete-inherited-codor-environment ref=cli-test-environment-wrapper
const env = { ...process.env };
const removed = Object.keys(env).filter((key) => key.startsWith('CODOR_')).sort();
for (const key of removed) delete env[key];
if (removed.length > 0) {
  process.stderr.write(`test-env: removed ${String(removed.length)} inherited CODOR_ variable(s): ${removed.join(', ')}\n`);
}
// harn:assume cli-tests-isolate-operator-home ref=cli-test-home-isolation
// Isolate HOME so CLI tests never read the operator's real ~/.config/codor (e.g.
// the installed service token file), which would otherwise let a test resolve a
// real bearer and reach the operator's live service instead of its own fixtures.
env.HOME = mkdtempSync(join(tmpdir(), 'codor-test-home-'));
// harn:end cli-tests-isolate-operator-home

const child = spawn(command, args, { stdio: 'inherit', env });
child.on('error', (error) => {
  process.stderr.write(`test-env: failed to spawn ${command}: ${error.message}\n`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
// harn:end cli-tests-delete-inherited-codor-environment
