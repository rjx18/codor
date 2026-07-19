import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';

export function isPipePath(path: string): boolean {
  return path.startsWith('\\\\.\\pipe\\');
}

export function localSocketPath(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const resolved = win32.resolve(dataDir);
    const hash = createHash('sha256').update(resolved).digest('hex').substring(0, 16);
    return `\\\\.\\pipe\\codor-${hash}`;
  }
  return posix.join(dataDir, 'codor.sock');
}
