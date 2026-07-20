import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';

// harn:assume windows-named-pipe-shares-local-websocket-protocol ref=windows-local-socket-selection
export function isPipePath(path: string): boolean {
  return path.startsWith('\\\\.\\pipe\\');
}

export function localSocketPath(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const resolved = win32.resolve(dataDir).toLowerCase();
    const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\codor-${hash}`;
  }
  return posix.join(dataDir, 'codor.sock');
}
// harn:end windows-named-pipe-shares-local-websocket-protocol
