import { describe, expect, it } from 'vitest';

import { isPipePath, localSocketPath } from './local-socket.js';

// harn:assume windows-named-pipe-shares-local-websocket-protocol ref=windows-pipe-regression
describe('localSocketPath', () => {
  it('keeps the private Unix socket path outside Windows', () => {
    expect(localSocketPath('/tmp/data', 'linux')).toBe('/tmp/data/codor.sock');
    expect(isPipePath(localSocketPath('/tmp/data', 'linux'))).toBe(false);
  });

  it('derives one deterministic named pipe per resolved Windows data directory', () => {
    const first = localSocketPath('C:\\data\\dir', 'win32');
    expect(first).toMatch(/^\\\\\.\\pipe\\codor-[0-9a-f]{16}$/);
    expect(isPipePath(first)).toBe(true);
    expect(localSocketPath('c:\\DATA\\dir\\.', 'win32')).toBe(first);
    expect(localSocketPath('C:\\data\\other', 'win32')).not.toBe(first);
  });
});
// harn:end windows-named-pipe-shares-local-websocket-protocol
