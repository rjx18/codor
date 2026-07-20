import { describe, expect, it } from 'vitest';
import { isPipePath, localSocketPath } from './local-socket.js';

describe('localSocketPath', () => {
  it('returns local unix socket path on non-win32 platforms', () => {
    const path = localSocketPath('/tmp/data', 'linux');
    expect(path).toBe('/tmp/data/codor.sock');
    expect(isPipePath(path)).toBe(false);
  });

  it('returns a named pipe path on win32 platform', () => {
    const path = localSocketPath('C:\\data', 'win32');
    expect(path.startsWith('\\\\.\\pipe\\codor-')).toBe(true);
    expect(isPipePath(path)).toBe(true);
  });

  it('is deterministic for the same dataDir on win32', () => {
    const path1 = localSocketPath('C:\\data\\dir', 'win32');
    const path2 = localSocketPath('C:\\data\\dir', 'win32');
    expect(path1).toBe(path2);
  });

  it('generates distinct names for distinct dataDirs on win32', () => {
    const path1 = localSocketPath('C:\\data\\dir1', 'win32');
    const path2 = localSocketPath('C:\\data\\dir2', 'win32');
    expect(path1).not.toBe(path2);
  });
});
