import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BUILTIN_ADAPTER_IDS,
  loadAdapterRegistry,
  resolveAdapterModuleSpecifier,
} from './adapter-registry.js';
import { Daemon } from './daemon.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const switchboardRoot = resolve(import.meta.dirname, '..');
const fixtureModule = './test-fixtures/third-party-adapter.mjs';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function dataModule(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

// harn:assume adapter-registry-sole-harness-source ref=third-party-hot-swap-acceptance
describe('configured adapter hot-swap', () => {
  it('loads a new module and completes a routed room turn without a core import', async () => {
    expect(resolveAdapterModuleSpecifier(fixtureModule, switchboardRoot)).toBe(
      pathToFileURL(join(switchboardRoot, 'test-fixtures', 'third-party-adapter.mjs')).href,
    );
    const adapters = await loadAdapterRegistry({
      adapters: { 'fixture-harness': fixtureModule },
      baseDir: switchboardRoot,
    });
    expect(adapters.map((adapter) => adapter.id)).toEqual([
      ...BUILTIN_ADAPTER_IDS,
      'fixture-harness',
    ]);

    const directory = mkdtempSync(join(tmpdir(), 'codor-hot-swap-'));
    temporaryDirectories.push(directory);
    const daemon = new Daemon({
      dbPath: join(directory, 'switchboard.sqlite'),
      blobRoot: join(directory, 'blobs'),
      adapters,
    });
    try {
      const created = daemon.createRoom({
        id: 'sdk',
        name: 'Adapter SDK',
        owner: { handle: 'richard', display_name: 'Richard' },
      });
      const owner = created.owner;
      const member = daemon.spawnMember('sdk', {
        harness: 'fixture-harness',
        handle: 'outsider',
        cwd: directory,
      });
      daemon.postHumanMessage('sdk', '@outsider prove the adapter boundary');
      await daemon.settle();

      expect(daemon.store.getMember('sdk', member.id)).toMatchObject({
        state: 'idle',
        session_ref: 'third-party-session-1',
      });
      const run = daemon.store.listMessages('sdk', { limit: 20 })
        .find((message) => message.kind === 'run');
      expect(run?.run).toMatchObject({
        status: 'completed',
        final_text: '@richard third-party adapter completed the boundary turn',
        usage: { input_tokens: 7, output_tokens: 5 },
      });
      expect(daemon.store.listDeliveries('sdk', { recipient: owner.id })).toEqual([
        expect.objectContaining({ message_id: run?.id, state: 'consumed' }),
      ]);
    } finally {
      await daemon.close();
    }
  });

  it('uses configured modules as deliberate same-name replacements and creates fresh instances', async () => {
    const options = {
      adapters: { codex: fixtureModule },
      baseDir: switchboardRoot,
    };
    const first = await loadAdapterRegistry(options);
    const second = await loadAdapterRegistry(options);
    const replacement = first.find((adapter) => adapter.id === 'codex');
    expect(first.filter((adapter) => adapter.id === 'codex')).toHaveLength(1);
    expect(replacement?.capabilities.discover).toBe(false);
    expect(replacement).not.toBe(second.find((adapter) => adapter.id === 'codex'));
  });

  it('fails startup contextually for missing factories, bad ids, and malformed adapters', async () => {
    await expect(loadAdapterRegistry({
      adapters: { missing: dataModule('export const value = 1') },
    })).rejects.toThrow(/configured adapter 'missing'.*must export createAdapter/);

    await expect(loadAdapterRegistry({
      adapters: {
        expected: dataModule('export function createAdapter(){return {id:"other"}}'),
      },
    })).rejects.toThrow(/configured adapter 'expected'.*returned id 'other'/);

    await expect(loadAdapterRegistry({
      adapters: {
        broken: dataModule('export function createAdapter({id}){return {id,capabilities:{}}}'),
      },
    })).rejects.toThrow(/configured adapter 'broken'.*invalid capabilities/);

    await expect(loadAdapterRegistry({
      adapters: {
        throws: dataModule('export function createAdapter(){throw new Error("factory boom")}'),
      },
    })).rejects.toThrow(/configured adapter 'throws'.*factory boom/);
  });
});
// harn:end adapter-registry-sole-harness-source

const productionExtension = /\.(?:[cm]?[jt]sx?)$/;

function productionSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return ['dist', 'fixtures', 'node_modules', 'test-fixtures'].includes(entry.name)
        ? []
        : productionSourceFiles(path);
    }
    if (!entry.isFile() || !productionExtension.test(path)) return [];
    return /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path) ? [] : [path];
  });
}

// harn:assume adapter-registry-sole-harness-source ref=hardcoded-list-guard
it('keeps every built-in adapter package import inside the sole registry', () => {
  const productionRoots = [join(repoRoot, 'packages'), join(repoRoot, 'relay')];
  const importPattern = /(['"])@codor\/adapter-[^'"]+\1/g;
  const hits = productionRoots.flatMap(productionSourceFiles).flatMap((file) => {
    const matches = readFileSync(file, 'utf8').match(importPattern) ?? [];
    return matches.map((match) => ({ file: relative(repoRoot, file).replaceAll('\\', '/'), match }));
  });
  expect(hits).toHaveLength(BUILTIN_ADAPTER_IDS.length);
  expect(new Set(hits.map((hit) => hit.file))).toEqual(
    new Set(['packages/switchboard/src/adapter-registry.ts']),
  );
});
// harn:end adapter-registry-sole-harness-source
