import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Daemon, LedgerManager, localSocketPath, startServer } from '@codor/switchboard';
import { describe, expect, it } from 'vitest';

import { ProtocolClient } from './connection.js';

// harn:assume windows-named-pipe-shares-local-websocket-protocol ref=windows-pipe-regression
describe('platform local transport integration', () => {
  it('exchanges the existing room frames over the selected local endpoint', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'codor-local-transport-'));
    const daemon = new Daemon({
      dbPath: join(dataDir, 'db.sqlite'),
      blobRoot: join(dataDir, 'blobs'),
      adapters: [],
      ledger: new LedgerManager({ dataDir }),
      homeDir: dataDir,
    });
    daemon.createRoom({
      id: 'test-room',
      name: 'Test Room',
      owner: { handle: 'richard', display_name: 'Richard' },
    });
    const server = await startServer({
      daemon,
      token: 'test-token-123',
      socketPath: localSocketPath(dataDir),
    });

    try {
      const client = await ProtocolClient.connect({ dataDir, token: 'test-token-123' });
      try {
        client.send({ type: 'list_rooms' });
        const response = await client.next();
        expect(response.type).toBe('rooms');
        if (response.type === 'rooms') {
          expect(response.rooms.map((room) => room.id)).toContain('test-room');
        }
      } finally {
        await client.close();
      }
    } finally {
      await server.close();
      await daemon.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
// harn:end windows-named-pipe-shares-local-websocket-protocol
