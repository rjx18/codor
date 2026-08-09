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
export {
  ManagementError,
  MANAGEMENT_EXIT_CODES,
  cliExitCode,
  classifyManagementError,
  confirmArchive,
  formatCliError,
  redactDiagnostic,
  renderChannel,
  renderChannelList,
} from './management.js';
export type { ChannelProjection, ManagementExitCode, ConfirmationOptions } from './management.js';
export { runSetup } from './setup.js';
export type { SetupOptions, SetupOverrides } from './setup.js';
export { renderTerminalQr } from './terminal-qr.js';
export { startCodor } from './up.js';
export type { RunningCodor, UpOptions } from './up.js';

export function packageName(): string {
  return '@codor/cli';
}

// harn:assume source-cli-installers-remain-idempotent-fallback ref=per-user-cli-install-script
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { runCli } = await import('./program.js');
  const { cliExitCode, formatCliError } = await import('./management.js');
  await runCli().catch((error: unknown) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = cliExitCode(error);
  });
}
// harn:end source-cli-installers-remain-idempotent-fallback
