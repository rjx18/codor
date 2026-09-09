import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { Daemon } from './daemon.js';
import { startServer } from './server.js';

describe('sender-owned receipt projection', () => {
  it('projects existing receipts only to their sender through indexed returned-record probes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'receipt-projection-'));
    const daemon = new Daemon({ dbPath: join(dir, 'db.sqlite'), blobRoot: join(dir, 'blobs'), adapters: [], homeDir: dir });
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      daemon.createRoom({ id: 'eng', name: 'Eng', owner: { handle: 'owner', display_name: 'Owner' } });
      const reader = daemon.store.addMember('eng', { kind: 'human', handle: 'reader', display_name: 'Reader', role: 'member' });
      const actor = { id: daemon.ownerOf('eng').id, agent: false, room: 'eng' };
      const outcome = daemon.submitPost('owner', { type: 'post', room: 'eng', body: 'same', submission_id: 'mine' }, actor, () => {});
      if (outcome.kind !== 'message') throw new Error('expected message');
      const message = daemon.store.getMessage('eng', outcome.message_id)!;
      expect(message).not.toHaveProperty('submission_id');
      for (let i=0;i<19;i++) daemon.submitPost('owner', {type:'post',room:'eng',body:`page ${i}`,submission_id:`page-${i}`},actor,()=>{});
      expect(daemon.store.correlatePosts('owner', 'message', [message])[0]).toMatchObject({ submission_id: 'mine' });
      expect(daemon.store.correlatePosts('browser:other', 'message', [message])[0]).not.toHaveProperty('submission_id');
      expect(message).not.toHaveProperty('submission_id');
      const db = new Database(join(dir, 'db.sqlite'));
      try {
        const insert = db.prepare('INSERT INTO post_receipts VALUES (?, ?, ?, ?, ?)');
        db.exec('DROP INDEX post_receipts_destination');
        const unindexedStart = performance.now();
        db.transaction(() => { for (let i = 50_000; i < 100_000; i++) insert.run('owner', `load-${i}`, 'x', 'x', JSON.stringify({ kind: 'message', room: 'other', message_id: i, seq: i, delivery_ids: [] })); })();
        const unindexedWriteMs = performance.now() - unindexedStart;
        db.exec(`CREATE INDEX post_receipts_destination ON post_receipts (sender,json_extract(outcome,'$.kind'),json_extract(outcome,'$.room'),json_extract(outcome,'$.message_id'),json_extract(outcome,'$.schedule_id'))`);
        const seedStart = performance.now();
        db.transaction(() => { for (let i = 0; i < 50_000; i++) insert.run('owner', `load-${i}`, 'x', 'x', JSON.stringify({ kind: 'message', room: 'other', message_id: i, seq: i, delivery_ids: [] })); })();
        const indexedWriteMs = performance.now() - seedStart;
        const query = `SELECT submission_id FROM post_receipts WHERE sender=? AND json_extract(outcome,'$.kind')=?
          AND json_extract(outcome,'$.room')=? AND json_extract(outcome,'$.message_id') IS ? AND json_extract(outcome,'$.schedule_id') IS ? LIMIT 1`;
        const plan = db.prepare('EXPLAIN QUERY PLAN ' + query).all('owner', 'message', 'eng', message.id, null);
        expect(JSON.stringify(plan)).toContain('USING INDEX post_receipts_destination');
        expect(JSON.stringify(plan)).not.toContain('SCAN post_receipts');
        const storeDb = (daemon.store as unknown as { db: Database.Database }).db;
        const prepare = storeDb.prepare.bind(storeDb);
        let probes = 0;
        const spy = vi.spyOn(storeDb, 'prepare').mockImplementation((sql) => {
          const statement = prepare(sql);
          if (!sql.includes('SELECT submission_id FROM post_receipts')) return statement;
          return { get: (...params: unknown[]) => { probes++; return statement.get(...params); } } as Database.Statement;
        });
        try {
          daemon.store.correlatePosts('owner','message',Array(200).fill(message)); expect(probes).toBe(1);
          daemon.store.correlatePosts('unmatched','message',Array.from({length:20},(_,i)=>({...message,id:100000+i})));
          expect(probes).toBe(21);
        } finally { spy.mockRestore(); }
        const samples: number[] = [];
        for (let n = 0; n < 100; n++) { const start = performance.now(); daemon.store.correlatePosts('owner', 'message', Array(200).fill(message)); samples.push(performance.now() - start); }
        db.exec('DROP INDEX post_receipts_destination');
        const start = performance.now();
        db.exec(`CREATE INDEX post_receipts_destination ON post_receipts (sender,json_extract(outcome,'$.kind'),json_extract(outcome,'$.room'),json_extract(outcome,'$.message_id'),json_extract(outcome,'$.schedule_id'))`);
        const indexMs = performance.now() - start;
        const summary = (values: number[]) => {
          values.sort((a,b)=>a-b); return { median: values[Math.floor(values.length / 2)], p95: values[Math.floor(values.length * .95)] };
        };
        const measure = (fn: () => unknown) => { const values: number[] = []; for (let i=0;i<100;i++) {
          const start=performance.now(); fn(); values.push(performance.now()-start);
        } return summary(values); };
        const paired = (before:()=>unknown, after:()=>unknown) => {
          const samples:[number[],number[]] = [[],[]];
          for (let i=0;i<100;i++) for (const index of (i%2 ? [0,1] : [1,0])) {
            const start=performance.now(); (index===0?before:after)(); samples[index]!.push(performance.now()-start);
          }
          return samples.map(summary);
        };
        daemon.transcriptHistoryPage('eng'); // exclude the existing one-time history backfill
        const [headBefore,headAfter] = paired(() => daemon.transcriptHistoryPage('eng'),
          () => { const page = daemon.transcriptHistoryPage('eng').page; daemon.store.correlatePosts('owner','message',page.messages); });
        const head = daemon.transcriptHistoryPage('eng').page;
        expect(head.messages).toHaveLength(20);
        const headBytes = Buffer.byteLength(JSON.stringify(head));
        const correlatedHeadBytes = Buffer.byteLength(JSON.stringify({...head,messages:daemon.store.correlatePosts('owner','message',head.messages)}));
        const [liveBefore,liveAfter] = paired(() => JSON.stringify(message),
          () => JSON.stringify(daemon.store.correlatePosts('owner','message',[message])[0]));
        const missAfter = measure(() => daemon.store.correlatePosts('unmatched','message',[message]));
        let count = 0;
        const accept = () => daemon.submitPost('owner', { type:'post', room:'eng', body:'measured', submission_id:`bench-${count++}` }, actor, () => {});
        const acceptanceAfter = measure(accept);
        db.exec('DROP INDEX post_receipts_destination');
        const acceptanceBefore = measure(accept);
        db.exec(`CREATE INDEX post_receipts_destination ON post_receipts (sender,json_extract(outcome,'$.kind'),json_extract(outcome,'$.room'),json_extract(outcome,'$.message_id'),json_extract(outcome,'$.schedule_id'))`);
        console.log('[before-after-ms]', JSON.stringify({ liveBefore,liveAfter,headBefore,headAfter,missAfter,acceptanceBefore,acceptanceAfter,headBytes,correlatedHeadBytes }));
        console.log('[correlation-cost]', JSON.stringify({ receipts: 100020, repeatedToolRecords: 200, uniqueRecords: 1,
          samples: samples.length, medianMs: samples.sort((a,b)=>a-b)[50], p95Ms: samples[95], unindexedWriteMs, indexedWriteMs, indexMs,
          payloadDelta: JSON.stringify(daemon.store.correlatePosts('owner', 'message', [message])).length - JSON.stringify([message]).length }));
      } finally { db.close(); }
      server = await startServer({ daemon, token: 'test', homeDir: dir, principals: [{ token: 'other', member_id: reader.id }] });
      const response = await fetch(`http://127.0.0.1:${server.port}/api/rooms/eng/transcript-history`, { headers: { authorization: 'Bearer test' } });
      const page = await response.json() as { messages: Array<{ submission_id?: string }> };
      expect(page.messages.every(message => message.submission_id !== undefined)).toBe(true);
      const other = await (await fetch(`http://127.0.0.1:${server.port}/api/rooms/eng/transcript-history`, { headers: { authorization: 'Bearer other' } })).json() as typeof page;
      expect(other.messages.every(message => message.submission_id === undefined)).toBe(true);
      daemon.deleteMessage('eng', outcome.message_id, actor.id);
      const tombstone = daemon.store.getMessage('eng', outcome.message_id)!;
      expect(daemon.store.correlatePosts('owner','message',[tombstone])[0]).toMatchObject({ submission_id:'mine', deleted:true, body:'' });
      const scheduled = daemon.submitPost('owner', { type:'post',room:'eng',body:'[send_in=1h] @reader scheduled',submission_id:'schedule-mine' },actor,()=>{});
      if (scheduled.kind !== 'schedule') throw new Error('expected schedule');
      expect(daemon.store.correlatePosts('owner','schedule',[daemon.store.getSchedule('eng',scheduled.schedule_id)!])[0]).toMatchObject({submission_id:'schedule-mine'});
    } finally { await server?.close(); await daemon.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
