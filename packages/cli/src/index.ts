#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export { ProtocolClient } from './connection.js';
export type { ProtocolClientOptions } from './connection.js';
export { nativeResumeCommand, superviseInteractiveAttach } from './attach.js';
export type { InteractiveCommand, InteractiveCommandResolver, InteractiveSpawner } from './attach.js';
export { detectSession, findCodexSessionFile } from './detect.js';
export type { DetectedSession } from './detect.js';
export { parseMirrorHook } from './mirror.js';
export { createProgram, runCli } from './program.js';
export type { CliContext } from './program.js';
export { runSetup } from './setup.js';
export type { SetupOptions, SetupOverrides } from './setup.js';
export { renderTerminalQr } from './terminal-qr.js';
export { startWireroom } from './up.js';
export type { RunningWireroom, UpOptions } from './up.js';

export function packageName(): string {
  return '@codor/cli';
}

// harn:assume global-cli-install-is-idempotent ref=per-user-cli-install-script
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { runCli } = await import('./program.js');
  await runCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
// harn:end global-cli-install-is-idempotent
