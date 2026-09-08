import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ModelCatalog } from '@codor/protocol';
import { CodexAppServerClient, type CodexAppServerFactory } from './app-server-transport.js';

// harn:assume codex-model-probe-is-native-bounded-and-read-only ref=native-model-probe
async function stopProbe(child: ChildProcessWithoutNullStreams, client?: CodexAppServerClient): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) { client?.dispose(); return; }
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(escalate); clearTimeout(deadline); child.off('exit', exited);
      if (error) reject(error); else resolve();
    };
    const exited = (): void => finish();
    const escalate = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* exit confirmation below remains required */ }
    }, 1_000);
    const deadline = setTimeout(() => finish(new Error('Codex model probe did not exit')), 2_000);
    child.once('exit', exited);
    try {
      if (client) client.dispose();
      else { child.stdin.end(); child.kill('SIGTERM'); }
    } catch (error) { finish(error instanceof Error ? error : new Error('Codex model probe cleanup failed')); }
  });
}

/** A listing-only process: no thread, turn, model override or configuration write. */
export async function discoverCodexModels(
  factory: CodexAppServerFactory,
  command: string,
  timeoutMs = 10_000,
): Promise<ModelCatalog> {
  let child: ChildProcessWithoutNullStreams | undefined;
  let client: CodexAppServerClient | undefined;
  let retired = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const budget = Math.max(1, Math.min(timeoutMs, 10_000));
  const work = async (): Promise<ModelCatalog> => {
    const spawned = await factory({ command, cwd: process.cwd(), env: { ...process.env } });
    if (retired) { await stopProbe(spawned); throw new Error('Codex model probe expired during spawn'); }
    child = spawned;
    client = new CodexAppServerClient(child, () => undefined);
    await client.request('initialize', { clientInfo: { name: 'codor-model-discovery', version: '1' } }, budget);
    client.notify('initialized');
    const models = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const value = await client.request('model/list', { cursor, limit: 100, includeHidden: false }, budget);
      if (value === null || typeof value !== 'object') throw new Error('Invalid Codex model catalog');
      const page = value as { data?: unknown; nextCursor?: unknown };
      if (!Array.isArray(page.data)) throw new Error('Invalid Codex model catalog data');
      for (const row of page.data) {
        if (row === null || typeof row !== 'object' || row.hidden === true) continue;
        if (row.hidden !== undefined && typeof row.hidden !== 'boolean') throw new Error('Invalid Codex model visibility');
        const model = row.model ?? row.id;
        if (typeof model === 'string' && /^\w[\w.:-]*(?:\/[\w.:-]+)*$/.test(model)) models.add(model);
      }
      if (page.nextCursor === null || page.nextCursor === undefined) return { models: [...models], source: 'discovered' };
      if (typeof page.nextCursor !== 'string' || cursors.has(page.nextCursor)) throw new Error('Invalid Codex model pagination');
      cursor = page.nextCursor; cursors.add(cursor);
    }
    throw new Error('Codex model catalog exceeded the page limit');
  };
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => { retired = true; reject(new Error('Codex model discovery timed out')); }, budget);
      }),
    ]);
  } finally {
    retired = true;
    clearTimeout(deadline);
    if (child) await stopProbe(child, client);
  }
}
// harn:end codex-model-probe-is-native-bounded-and-read-only
