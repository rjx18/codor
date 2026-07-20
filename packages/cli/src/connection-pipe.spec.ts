import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Daemon, LedgerManager, localSocketPath, startServer } from '@codor/switchboard';
import { ProtocolClient } from './connection.js';

describe('Windows named pipe / local socket integration', () => {
  it('successfully starts a server and exchanges frames over local transport', async () => {
    const tmpDataDir = mkdtempSync(join(tmpdir(), 'codor-cli-pipe-test-'));
    const daemon = new Daemon({
      dbPath: join(tmpDataDir, 'db.sqlite'),
      blobRoot: join(tmpDataDir, 'blobs'),
      adapters: [],
      ledger: new LedgerManager({ dataDir: tmpDataDir }),
      homeDir: tmpDataDir,
    });

    try {
      daemon.createRoom({
        id: 'test-room',
        name: 'Test Room',
        owner: { handle: 'richard', display_name: 'Richard' },
      });

      const token = 'test-token-123';
      const socketPath = localSocketPath(tmpDataDir);

      const server = await startServer({
        daemon,
        token,
        socketPath,
      });

      try {
        const client = await ProtocolClient.connect({
          dataDir: tmpDataDir,
          token,
        });

        try {
          client.send({ type: 'list_rooms' });
          const response = await client.next();
          expect(response.type).toBe('rooms');
          if (response.type === 'rooms') {
            expect(response.rooms.map(r => r.id)).toContain('test-room');
          }
        } finally {
          await client.close();
        }
      } finally {
        await server.close();
      }
    } finally {
      await daemon.close();
      rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });
});
