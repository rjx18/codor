#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

export { ProtocolClient } from './connection.js';
export type { ProtocolClientOptions } from './connection.js';
export { detectSession, findCodexSessionFile } from './detect.js';
export type { DetectedSession } from './detect.js';
export { parseMirrorHook } from './mirror.js';
export { createProgram, runCli } from './program.js';
export type { CliContext } from './program.js';
export { startWireroom } from './up.js';
export type { RunningWireroom, UpOptions } from './up.js';

export function packageName(): string {
  return '@wireroom/cli';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { runCli } = await import('./program.js');
  await runCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
