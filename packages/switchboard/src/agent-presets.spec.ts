import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentPresetInput } from '@codor/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Daemon } from './daemon.js';
import { FakeAdapter } from './fake-adapter.js';
import { CryptoVault } from './crypto/pairing.js';
import {
  AgentPresetNotFoundError,
  AgentPresetReferenceConflictError,
  Store,
} from './store.js';
import { startServer, type RunningServer } from './server.js';

const nativeInput: AgentPresetInput = {
  label: 'Review helper',
  handle: 'review-helper',
  display_name: 'Review Helper',
  harness: 'fake',
  model: 'fake-model',
  thinking: 'high',
  policy: 'workspace-write',
};

const customAcpInput: AgentPresetInput = {
  label: 'Custom ACP',
  handle: 'custom-acp',
  display_name: 'Custom ACP',
  harness: 'acp',
  acp_launch: { executable: process.execPath, argv: ['--acp'] },
};

let dir: string;

// harn:assume individual-agent-presets-are-versioned-local-state ref=individual-agent-preset-persistence-regression
describe('agent preset Store persistence', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codor-agent-presets-store-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('migrates a populated pre-feature database, persists CRUD, and keeps identity stable', () => {
    const path = join(dir, 'switchboard.sqlite');
    let store = new Store(path);
    const room = store.createRoom({
      id: 'eng', name: 'Eng', owner: { handle: 'richard', display_name: 'Richard' },
    });
    const originalMembers = store.listMembers('eng');

    store.close();
    const legacy = new Database(path);
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
      DROP TABLE default_roster_items;
      DROP TABLE default_rosters;
      DROP TABLE agent_presets;
    `);
    legacy.close();

    store = new Store(path);
    expect(store.getDefaultRoster()).toMatchObject({
      id: 'default', schema_version: 1, preset_ids: [],
    });

    const preset = store.createAgentPreset(nativeInput);
    const custom = store.createAgentPreset(customAcpInput);
    expect(preset.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(preset.schema_version).toBe(1);
    expect(preset.created_ts).toBe(preset.updated_ts);
    expect(store.getAgentPreset(custom.id)?.acp_launch).toEqual(customAcpInput.acp_launch);

    const replaced = store.updateAgentPreset(preset.id, {
      ...nativeInput,
      label: 'Updated helper',
      handle: 'updated-helper',
      model: undefined,
    });
    expect(replaced.id).toBe(preset.id);
    expect(replaced.created_ts).toBe(preset.created_ts);
    expect(replaced.label).toBe('Updated helper');
    expect(replaced.updated_ts).toBeDefined();

    store.replaceDefaultRoster({ preset_ids: [custom.id, preset.id] });
    expect(store.getDefaultRoster().preset_ids).toEqual([custom.id, preset.id]);
    expect(() => store.deleteAgentPreset(preset.id)).toThrow(AgentPresetReferenceConflictError);
    expect(store.getDefaultRoster().preset_ids).toEqual([custom.id, preset.id]);
    store.replaceDefaultRoster({ preset_ids: [preset.id, custom.id] });
    expect(store.getDefaultRoster().preset_ids).toEqual([preset.id, custom.id]);
    const rosterBeforeRestart = store.getDefaultRoster();
    expect(rosterBeforeRestart).toMatchObject({
      id: 'default', schema_version: 1, preset_ids: [preset.id, custom.id],
      updated_ts: expect.any(String),
    });
    const customBeforeRestart = store.getAgentPreset(custom.id);
    expect(customBeforeRestart).toBeDefined();

    expect(() => store.replaceDefaultRoster({
      preset_ids: [preset.id, '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    })).toThrow('no such agent preset');
    expect(store.getDefaultRoster().preset_ids).toEqual([preset.id, custom.id]);

    store.close();
    store = new Store(path);
    expect(store.getAgentPreset(custom.id)).toEqual(customBeforeRestart);
    expect(store.getDefaultRoster()).toEqual(rosterBeforeRestart);
    expect(store.getRoom(room.room.id)).toEqual(room.room);
    expect(store.listMembers('eng')).toEqual(originalMembers);
    store.replaceDefaultRoster({ preset_ids: [] });
    store.deleteAgentPreset(preset.id);
    expect(store.getAgentPreset(preset.id)).toBeUndefined();
    store.close();
  });
});
// harn:end individual-agent-presets-are-versioned-local-state

// harn:assume default-roster-is-one-versioned-ordered-preset-reference-group ref=default-roster-order-regression
describe('default roster ordering', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codor-agent-presets-roster-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('replaces the complete ordered list atomically and rejects duplicate references', () => {
    const path = join(dir, 'switchboard.sqlite');
    let store = new Store(path);
    const first = store.createAgentPreset({ ...nativeInput, handle: 'first-preset', label: 'First' });
    const second = store.createAgentPreset({ ...nativeInput, handle: 'second-preset', label: 'Second' });

    const ordered = store.replaceDefaultRoster([second.id, first.id]);
    expect(ordered.preset_ids)
      .toEqual([second.id, first.id]);
    expect(ordered).toMatchObject({
      id: 'default', schema_version: 1, updated_ts: expect.any(String),
    });
    expect(() => store.replaceDefaultRoster({ preset_ids: [first.id, first.id] }))
      .toThrow();
    expect(store.getDefaultRoster().preset_ids).toEqual([second.id, first.id]);
    store.close();
    store = new Store(path);
    expect(store.getDefaultRoster()).toEqual(ordered);
    expect(store.replaceDefaultRoster({ preset_ids: [] }).preset_ids).toEqual([]);
    store.close();
  });
});
// harn:end default-roster-is-one-versioned-ordered-preset-reference-group

// harn:assume default-roster-references-block-preset-deletion ref=preset-roster-reference-regression
describe('preset reference integrity', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codor-agent-presets-reference-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('allows deletion only after a successful reference removal', () => {
    const store = new Store(join(dir, 'switchboard.sqlite'));
    const preset = store.createAgentPreset({ ...nativeInput, handle: 'referenced-preset' });
    store.replaceDefaultRoster({ preset_ids: [preset.id] });
    expect(() => store.deleteAgentPreset(preset.id)).toThrow(AgentPresetReferenceConflictError);
    expect(store.getAgentPreset(preset.id)).toBeDefined();
    store.replaceDefaultRoster({ preset_ids: [] });
    expect(() => store.deleteAgentPreset(preset.id)).not.toThrow();
    store.close();
  });
});
// harn:end default-roster-references-block-preset-deletion

const waitFor = async (condition: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

// harn:assume individual-agent-presets-are-bounded-catalog-validated-configurations ref=individual-agent-preset-direct-validation-regression
describe('direct daemon preset validation', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codor-agent-presets-daemon-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses installed/model/provider catalog truth without spawning', async () => {
    const fake = new FakeAdapter('fake', { thinking: true });
    const listModels = vi.fn(async () => ({ models: ['fake-model'], source: 'curated' as const }));
    Object.assign(fake, { listModels });
    const acp = Object.assign(new FakeAdapter('acp'), { configurable: true });
    const spawn = vi.spyOn(fake, 'spawn');
    const acpSpawn = vi.spyOn(acp, 'spawn');
    const executableOnPath = vi.fn((executable: string) =>
      executable === './relative-agent' || executable === 'kimi');
    const daemon = new Daemon({
      dbPath: join(dir, 'switchboard.sqlite'),
      blobRoot: join(dir, 'blobs'),
      adapters: [fake, acp],
      homeDir: dir,
      discoverModels: true,
      executableOnPath,
    });
    try {
      await waitFor(() => daemon.registeredAdapters().some((adapter) => adapter.models?.includes('fake-model')));
      const native = daemon.createAgentPreset(nativeInput);
      expect(native.model).toBe('fake-model');
      expect(spawn).not.toHaveBeenCalled();
      expect(acpSpawn).not.toHaveBeenCalled();
      const beforeInvalidCreate = daemon.listAgentPresets();
      expect(() => daemon.createAgentPreset({ ...nativeInput, model: 'not-in-catalog' }))
        .toThrow('not currently offered');
      expect(daemon.listAgentPresets()).toEqual(beforeInvalidCreate);
      expect(() => daemon.createAgentPreset({ ...nativeInput, policy: 'danger' as never }))
        .toThrow();
      expect(() => daemon.createAgentPreset({ ...nativeInput, handle: 'switchboard' }))
        .toThrow();

      const beforeInvalidUpdate = daemon.getAgentPreset(native.id);
      expect(beforeInvalidUpdate).toBeDefined();
      expect(() => daemon.updateAgentPreset(native.id, {
        ...nativeInput, model: 'not-in-catalog', handle: 'should-not-persist',
      })).toThrow('not currently offered');
      expect(daemon.getAgentPreset(native.id)).toEqual(beforeInvalidUpdate);
      expect(() => daemon.updateAgentPreset(
        '01ARZ3NDEKTSV4RRFFQ69G5FAV', nativeInput,
      )).toThrow(AgentPresetNotFoundError);

      const named = daemon.createAgentPreset({
        label: 'Named ACP', handle: 'named-provider', harness: 'acp', acp_provider: 'kimi',
      });
      expect(named.acp_provider).toBe('kimi');
      const custom = daemon.createAgentPreset({ ...customAcpInput, handle: 'custom-provider' });
      expect(custom.acp_launch).toEqual(customAcpInput.acp_launch);
      expect(acpSpawn).not.toHaveBeenCalled();
      const beforeUnavailableCustom = daemon.listAgentPresets();
      expect(() => daemon.createAgentPreset({
        ...customAcpInput,
        handle: 'unavailable-custom',
        acp_launch: { executable: 'missing-custom-agent', argv: ['--acp'] },
      })).toThrow('executable is unavailable');
      expect(daemon.listAgentPresets()).toEqual(beforeUnavailableCustom);
      expect(executableOnPath('./relative-agent')).toBe(true);
      const beforeRelativeUpdate = daemon.getAgentPreset(custom.id);
      const beforeRelativeRoster = daemon.getDefaultRoster();
      expect(() => daemon.updateAgentPreset(custom.id, {
        ...customAcpInput,
        handle: 'relative-update',
        acp_launch: { executable: './relative-agent', argv: ['--acp'] },
      })).toThrow('executable is unavailable');
      expect(daemon.getAgentPreset(custom.id)).toEqual(beforeRelativeUpdate);
      expect(daemon.getDefaultRoster()).toEqual(beforeRelativeRoster);
      executableOnPath.mockImplementation((executable) => executable !== 'kimi');
      expect(() => daemon.createAgentPreset({
        label: 'Unavailable named ACP', handle: 'unavailable-named',
        harness: 'acp', acp_provider: 'kimi',
      })).toThrow('not currently installed');
      expect(acpSpawn).not.toHaveBeenCalled();
      expect(() => daemon.createAgentPreset({
        label: 'Missing provider', handle: 'missing-provider', harness: 'acp', acp_provider: 'unknown',
      })).toThrow('unknown ACP provider');
    } finally {
      await daemon.close();
    }
  });

  it('requires the generic ACP adapter registration to be configurable', async () => {
    const acp = new FakeAdapter('acp');
    const daemon = new Daemon({
      dbPath: join(dir, 'unconfigurable.sqlite'),
      blobRoot: join(dir, 'unconfigurable-blobs'),
      adapters: [acp],
      homeDir: dir,
      executableOnPath: () => true,
      discoverModels: false,
    });
    try {
      expect(() => daemon.createAgentPreset(customAcpInput)).toThrow('not registered as configurable');
      expect(daemon.listAgentPresets()).toEqual([]);
    } finally {
      await daemon.close();
    }
  });

  it('rejects an unavailable native harness before Store mutation', async () => {
    const fake = new FakeAdapter('fake');
    Object.assign(fake, { executable: 'fake' });
    const daemon = new Daemon({
      dbPath: join(dir, 'switchboard.sqlite'),
      blobRoot: join(dir, 'blobs'),
      adapters: [fake],
      homeDir: dir,
      executableOnPath: () => false,
      discoverModels: false,
    });
    try {
      expect(() => daemon.createAgentPreset(nativeInput)).toThrow('not installed');
      expect(daemon.listAgentPresets()).toEqual([]);
      expect(daemon.getDefaultRoster().preset_ids).toEqual([]);
    } finally {
      await daemon.close();
    }
  });
});
// harn:end individual-agent-presets-are-bounded-catalog-validated-configurations

// harn:assume default-roster-channel-selection-is-exclusive-and-preflighted ref=default-roster-expansion-regression
// harn:assume default-roster-channel-members-are-detached-ordered-snapshots ref=default-roster-snapshot-regression
describe('default roster room creation', () => {
  let daemon: Daemon;
  let fake: FakeAdapter;
  let acp: FakeAdapter & { configurable: true };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codor-default-roster-create-'));
    fake = new FakeAdapter('fake');
    Object.assign(fake, { executable: 'fake' });
    acp = Object.assign(new FakeAdapter('acp'), { configurable: true });
    daemon = new Daemon({
      dbPath: join(dir, 'switchboard.sqlite'),
      blobRoot: join(dir, 'blobs'),
      adapters: [fake, acp],
      homeDir: dir,
      executableOnPath: () => true,
      discoverModels: false,
    });
  });

  afterEach(async () => {
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('snapshots native, named ACP, and custom ACP entries in roster order', () => {
    const first = daemon.createAgentPreset({
      label: 'First', handle: 'first-roster', harness: 'fake',
    });
    const named = daemon.createAgentPreset({
      label: 'Named', handle: 'named-roster', harness: 'acp', acp_provider: 'kimi',
    });
    const custom = daemon.createAgentPreset({
      ...customAcpInput, handle: 'custom-roster',
    });
    daemon.replaceDefaultRoster({ preset_ids: [first.id, named.id, custom.id] });

    const sessions: ReturnType<FakeAdapter['spawn']>[] = [];
    const originalFakeSpawn = fake.spawn.bind(fake);
    vi.spyOn(fake, 'spawn').mockImplementation((opts) => {
      const session = originalFakeSpawn(opts);
      session.session_ref = `fake-roster-${String(sessions.length)}`;
      sessions.push(session);
      return session;
    });
    const originalAcpSpawn = acp.spawn.bind(acp);
    vi.spyOn(acp, 'spawn').mockImplementation((opts) => {
      const session = originalAcpSpawn(opts);
      session.session_ref = `acp-roster-${String(sessions.length)}`;
      sessions.push(session);
      return session;
    });

    const created = daemon.createRoom({
      id: 'roster-room', name: 'Roster Room', owner: { handle: 'owner', display_name: 'Owner' },
      cwd: dir, default_roster: true,
    });
    expect(created.initialAgents.map((member) => member.handle))
      .toEqual(['first-roster', 'named-roster', 'custom-roster']);
    expect(created.initialAgents.map((member) => member.state)).toEqual(['idle', 'idle', 'idle']);
    expect(created.initialAgents.map((member) => member.id)).toEqual([
      expect.any(String), expect.any(String), expect.any(String),
    ]);
    expect(new Set(created.initialAgents.map((member) => member.id)).size).toBe(3);
    expect(created.room.config.starting_agent_handle).toBeUndefined();
    expect(created.initialAgents.every((member) => member.cwd === dir)).toBe(true);
    expect(created.initialAgents.find((member) => member.handle === 'first-roster'))
      .toMatchObject({ display_name: 'first-roster', policy: 'read-only', harness: 'fake' });
    expect(created.initialAgents.find((member) => member.handle === 'named-roster'))
      .toMatchObject({ acp_provider: 'kimi', harness: 'acp' });
    expect(JSON.stringify(created.initialAgents)).not.toContain(process.execPath);
    expect(daemon.store.getAgentRuntimeConfig('roster-room', created.initialAgents[1]!.id))
      .toMatchObject({ acp_launch: expect.any(Object) });
    expect(daemon.store.getAgentRuntimeConfig('roster-room', created.initialAgents[2]!.id))
      .toEqual({ acp_launch: customAcpInput.acp_launch });
    expect(sessions).toHaveLength(3);
    expect(new Set(sessions.map((session) => session.session_ref)).size).toBe(3);

    daemon.updateAgentPreset(first.id, {
      label: 'First changed', handle: 'first-renamed', harness: 'fake', policy: 'full-access',
    });
    daemon.replaceDefaultRoster({ preset_ids: [custom.id] });
    expect(daemon.store.getMemberByHandle('roster-room', 'first-roster')).toMatchObject({
      handle: 'first-roster', policy: 'read-only',
    });
    expect(daemon.store.getMemberByHandle('roster-room', 'first-renamed')).toBeUndefined();
  });

  // harn:assume initial-roster-runtime-failures-are-member-local-and-actionable ref=initial-agent-runtime-failure-regression
  it('keeps a failed seeded runtime dead and activates later entries independently', () => {
    const handles = ['failure-first', 'success-middle', 'success-last'];
    const presets = handles.map((handle) => daemon.createAgentPreset({
      label: handle, handle, harness: 'fake',
    }));
    daemon.replaceDefaultRoster({ preset_ids: presets.map((preset) => preset.id) });
    const originalSpawn = fake.spawn.bind(fake);
    const successfulSessions: ReturnType<FakeAdapter['spawn']>[] = [];
    const spawn = vi.spyOn(fake, 'spawn');
    spawn.mockImplementationOnce(() => { throw new Error('first runtime failed'); });
    spawn.mockImplementation((opts) => {
      const session = originalSpawn(opts);
      successfulSessions.push(session);
      return session;
    });

    const created = daemon.createRoom({
      id: 'partial-roster', name: 'Partial Roster', owner: { handle: 'owner', display_name: 'Owner' },
      default_roster: true,
    });
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(created.initialAgents.map((member) => [member.handle, member.state])).toEqual([
      ['failure-first', 'dead'], ['success-middle', 'idle'], ['success-last', 'idle'],
    ]);
    expect(daemon.store.listMessages('partial-roster', { limit: 20 }).filter((message) =>
      message.kind === 'system' && message.body.includes('failure-first'))).toHaveLength(1);
    expect(daemon.store.listMessages('partial-roster', { limit: 20 }).at(-1)?.body)
      .toContain('remove it and spawn a replacement');
    expect(daemon.store.getAgentRuntimeConfig('partial-roster', created.initialAgents[0]!.id))
      .toEqual({});

    // harn:assume initial-roster-runtime-failures-are-member-local-and-actionable ref=initial-agent-runtime-isolation-regression
    expect(successfulSessions).toHaveLength(2);
    expect(successfulSessions[0]).not.toBe(successfulSessions[1]);
    expect(successfulSessions[0]!.env?.CODOR_MEMBER_TOKEN)
      .toBeDefined();
    expect(successfulSessions[1]!.env?.CODOR_MEMBER_TOKEN)
      .toBeDefined();
    expect(successfulSessions[0]!.env?.CODOR_MEMBER_TOKEN)
      .not.toBe(successfulSessions[1]!.env?.CODOR_MEMBER_TOKEN);
    expect(successfulSessions[0]!.env?.CODOR_CHANNEL).toBe('partial-roster');
    expect(successfulSessions[1]!.env?.CODOR_CHANNEL).toBe('partial-roster');
    expect(successfulSessions[0]!.env?.CODOR_MEMBER_ID)
      .toBe(created.initialAgents[1]!.id);
    expect(successfulSessions[1]!.env?.CODOR_MEMBER_ID)
      .toBe(created.initialAgents[2]!.id);
    expect(daemon.authenticateAgentToken(successfulSessions[0]!.env!.CODOR_MEMBER_TOKEN!))
      .toMatchObject({ room: 'partial-roster', member: { id: created.initialAgents[1]!.id } });
    expect(daemon.authenticateAgentToken(successfulSessions[1]!.env!.CODOR_MEMBER_TOKEN!))
      .toMatchObject({ room: 'partial-roster', member: { id: created.initialAgents[2]!.id } });
    expect(JSON.stringify(daemon.store.listMembers('partial-roster')))
      .not.toContain(successfulSessions[0]!.env!.CODOR_MEMBER_TOKEN!);
    expect(JSON.stringify(daemon.store.listMembers('partial-roster')))
      .not.toContain(successfulSessions[1]!.env!.CODOR_MEMBER_TOKEN!);
    // The thrown first activation never returned a Session, received a token, or
    // gained a credential hash; its durable identity remains the only dead row.
    expect(created.initialAgents[0]!.state).toBe('dead');
    // harn:end initial-roster-runtime-failures-are-member-local-and-actionable
    // harn:assume agent-member-credentials-stay-secret ref=initial-agent-credential-isolation-regression
    expect(successfulSessions.map((session) => session.env?.CODOR_MEMBER_TOKEN))
      .toEqual(expect.arrayContaining([expect.any(String), expect.any(String)]));
    // harn:end agent-member-credentials-stay-secret
  });

  // harn:assume default-roster-channel-members-are-detached-ordered-snapshots ref=default-roster-default-recipient-regression
  // harn:assume default-recipient-fallback-chain ref=default-roster-default-recipient-regression
  it('keeps roster-created default-recipient behavior honest', async () => {
    const first = daemon.createAgentPreset({
      label: 'First default', handle: 'first-default', harness: 'fake',
    });
    const second = daemon.createAgentPreset({
      label: 'Second default', handle: 'second-default', harness: 'fake',
    });
    daemon.replaceDefaultRoster({ preset_ids: [first.id, second.id] });

    const multi = daemon.createRoom({
      id: 'multi-default', name: 'Multi Default',
      owner: { handle: 'multi-owner', display_name: 'Multi Owner' },
      default_roster: true,
    });
    expect(multi.room.config.starting_agent_handle).toBeUndefined();
    const suppressPump = vi.spyOn(daemon, 'maybeStartTurn').mockResolvedValue();
    const commentary = daemon.postHumanMessage('multi-default', 'fresh roster commentary');
    expect(daemon.store.listDeliveries('multi-default', { state: 'queued' })
      .filter((delivery) => delivery.message_id === commentary.id)).toEqual([]);

    const sole = daemon.createAgentPreset({
      label: 'Sole default', handle: 'sole-default', harness: 'fake',
    });
    daemon.replaceDefaultRoster({ preset_ids: [sole.id] });
    const single = daemon.createRoom({
      id: 'single-default', name: 'Single Default',
      owner: { handle: 'single-owner', display_name: 'Single Owner' },
      default_roster: true,
    });
    expect(single.room.config.starting_agent_handle).toBeUndefined();
    const fallback = daemon.postHumanMessage('single-default', 'sole live fallback');
    expect(daemon.store.listDeliveries('single-default', { recipient: single.initialAgents[0]!.id }))
      .toContainEqual(expect.objectContaining({ message_id: fallback.id, state: 'queued' }));
    suppressPump.mockRestore();

    daemon.replaceDefaultRoster({ preset_ids: [first.id, second.id] });
    fake.enqueue({ kind: 'complete', final_text: '@multi-owner established first default' });
    const latest = daemon.createRoom({
      id: 'latest-default', name: 'Latest Default',
      owner: { handle: 'latest-owner', display_name: 'Latest Owner' },
      default_roster: true,
    });
    daemon.postHumanMessage('latest-default', '@first-default establish the latest default');
    await daemon.settle();
    expect(daemon.store.latestFinalizedAgentAuthor('latest-default'))
      .toBe(latest.initialAgents[0]!.id);
    const established = daemon.postHumanMessage('latest-default', 'use established default');
    expect(daemon.store.listDeliveries('latest-default', { recipient: latest.initialAgents[0]!.id }))
      .toContainEqual(expect.objectContaining({ message_id: established.id }));
    expect(daemon.store.listDeliveries('latest-default', { recipient: latest.initialAgents[1]!.id }))
      .not.toContainEqual(expect.objectContaining({ message_id: established.id }));
  });
  // harn:end default-recipient-fallback-chain
  // harn:end default-roster-channel-members-are-detached-ordered-snapshots

  it('rejects persisted duplicate, reserved, stale, and catalog-drifted rosters before mutation', async () => {
    type Scenario = {
      name: string;
      install: (store: Store) => { fallback: string; roster: string[] };
      corrupt: (db: Database.Database, roster: string[]) => void;
      available?: (executable: string) => boolean;
      recover: (available: ReturnType<typeof vi.fn>) => void;
    };
    const scenarios: Scenario[] = [
      {
        name: 'duplicate-handle',
        install: (store) => {
          const fallback = store.createAgentPreset({
            label: 'Fallback', handle: 'duplicate-fallback', harness: 'fake',
          });
          const first = store.createAgentPreset({
            label: 'First', handle: 'duplicate-first', harness: 'fake',
          });
          const second = store.createAgentPreset({
            label: 'Second', handle: 'duplicate-second', harness: 'fake',
          });
          return { fallback: fallback.id, roster: [first.id, second.id] };
        },
        corrupt: (db, roster) => {
          const firstHandle = db.prepare('SELECT handle FROM agent_presets WHERE id = ?')
            .get(roster[0]) as { handle: string };
          db.prepare('UPDATE agent_presets SET handle = ? WHERE id = ?')
            .run(firstHandle.handle, roster[1]);
        },
        recover: () => {},
      },
      {
        name: 'reserved-preset',
        install: (store) => {
          const fallback = store.createAgentPreset({
            label: 'Fallback', handle: 'reserved-fallback', harness: 'fake',
          });
          const reserved = store.createAgentPreset({
            label: 'Reserved', handle: 'reserved-target', harness: 'fake',
          });
          return { fallback: fallback.id, roster: [reserved.id] };
        },
        corrupt: (db, roster) => {
          db.prepare('UPDATE agent_presets SET handle = ? WHERE id = ?')
            .run('switchboard', roster[0]);
        },
        recover: () => {},
      },
      {
        name: 'missing-reference',
        install: (store) => {
          const fallback = store.createAgentPreset({
            label: 'Fallback', handle: 'missing-fallback', harness: 'fake',
          });
          const stale = store.createAgentPreset({
            label: 'Stale', handle: 'missing-target', harness: 'fake',
          });
          return { fallback: fallback.id, roster: [stale.id] };
        },
        corrupt: (db, roster) => {
          db.pragma('foreign_keys = OFF');
          db.prepare('UPDATE default_roster_items SET preset_id = ? WHERE preset_id = ?')
            .run('01ARZ3NDEKTSV4RRFFQ69G5FAV', roster[0]);
          db.pragma('foreign_keys = ON');
        },
        recover: () => {},
      },
      {
        name: 'catalog-drift',
        install: (store) => {
          const fallback = store.createAgentPreset({
            label: 'Fallback', handle: 'catalog-fallback', harness: 'fake',
          });
          const named = store.createAgentPreset({
            label: 'Named ACP', handle: 'catalog-target', harness: 'acp', acp_provider: 'kimi',
          });
          return { fallback: fallback.id, roster: [named.id] };
        },
        corrupt: () => {},
        available: (executable) => executable !== 'kimi',
        recover: (available) => available.mockReturnValue(true),
      },
    ];

    for (const scenario of scenarios) {
      const dbPath = join(dir, `${scenario.name}.sqlite`);
      const setup = new Store(dbPath);
      const seeded = scenario.install(setup);
      setup.replaceDefaultRoster({ preset_ids: seeded.roster });
      setup.close();

      const corrupted = new Database(dbPath);
      scenario.corrupt(corrupted, seeded.roster);
      corrupted.pragma('foreign_keys = ON');
      expect(corrupted.pragma('foreign_keys', { simple: true })).toBe(1);
      corrupted.close();

      const available = vi.fn(scenario.available ?? (() => true));
      const caseFake = new FakeAdapter('fake');
      Object.assign(caseFake, { executable: 'fake' });
      const caseAcp = Object.assign(new FakeAdapter('acp'), { configurable: true });
      const caseDaemon = new Daemon({
        dbPath,
        blobRoot: join(dir, `${scenario.name}-blobs`),
        adapters: [caseFake, caseAcp],
        homeDir: dir,
        executableOnPath: available,
        discoverModels: false,
      });
      const fakeSpawn = vi.spyOn(caseFake, 'spawn');
      const acpSpawn = vi.spyOn(caseAcp, 'spawn');
      const roomId = `${scenario.name}-invalid`;
      try {
        expect(() => caseDaemon.createRoom({
          id: roomId,
          name: `${scenario.name} invalid`,
          owner: { handle: `${scenario.name}-owner`, display_name: 'Owner' },
          default_roster: true,
        })).toThrow();
        expect(fakeSpawn).not.toHaveBeenCalled();
        expect(acpSpawn).not.toHaveBeenCalled();
        expect(caseDaemon.store.getRoom(roomId)).toBeUndefined();
        expect(caseDaemon.store.listMembers(roomId)).toEqual([]);
        expect(caseDaemon.store.listMessages(roomId)).toEqual([]);

        scenario.recover(available);
        caseDaemon.replaceDefaultRoster({ preset_ids: [seeded.fallback] });
        const valid = caseDaemon.createRoom({
          id: `${scenario.name}-valid`,
          name: `${scenario.name} valid`,
          owner: { handle: `${scenario.name}-valid-owner`, display_name: 'Valid Owner' },
          default_roster: true,
        });
        expect(valid.initialAgents).toHaveLength(1);
      } finally {
        await caseDaemon.close();
      }
    }
  });

  it('accepts an empty selected roster without inventing a starting agent', () => {
    daemon.replaceDefaultRoster({ preset_ids: [] });
    const created = daemon.createRoom({
      id: 'empty-roster', name: 'Empty Roster', owner: { handle: 'owner', display_name: 'Owner' },
      default_roster: true,
    });
    expect(created.room.config.starting_agent_handle).toBeUndefined();
    expect(created.initialAgents).toEqual([]);
    expect(daemon.store.listMembers('empty-roster').map((member) => member.kind).sort())
      .toEqual(['human', 'system']);
  });
});
// harn:end initial-roster-runtime-failures-are-member-local-and-actionable
// harn:end default-roster-channel-members-are-detached-ordered-snapshots
// harn:end default-roster-channel-selection-is-exclusive-and-preflighted

// harn:assume agent-preset-management-is-authorized-and-transport-neutral ref=agent-preset-rest-regression
describe('agent preset REST authorization and behavior', () => {
  let daemon: Daemon;
  let server: RunningServer;
  let fake: FakeAdapter;
  let crypto: CryptoVault;
  let browser: CryptoVault;
  let browserToken: string;
  let agentToken: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'codor-agent-presets-server-'));
    fake = new FakeAdapter('fake');
    const acp = Object.assign(new FakeAdapter('acp'), { configurable: true });
    Object.assign(fake, { executable: 'fake' });
    daemon = new Daemon({
      dbPath: join(dir, 'switchboard.sqlite'),
      blobRoot: join(dir, 'blobs'),
      adapters: [fake, acp],
      homeDir: dir,
      executableOnPath: () => true,
      discoverModels: false,
    });
    daemon.createRoom({
      id: 'eng', name: 'Eng', owner: { handle: 'richard', display_name: 'Richard' },
    });
    const admin = daemon.store.addMember('eng', {
      kind: 'human', handle: 'admin-user', display_name: 'Admin', role: 'admin',
    });
    const member = daemon.store.addMember('eng', {
      kind: 'human', handle: 'member-user', display_name: 'Member', role: 'member',
    });
    const observer = daemon.store.addMember('eng', {
      kind: 'human', handle: 'observer-user', display_name: 'Observer', role: 'observer',
    });
    crypto = new CryptoVault(join(dir, 'crypto'));
    browser = new CryptoVault(join(dir, 'browser'));
    const browserPeer = crypto.keys.enrollPeer({
      ...browser.keys.publicIdentity(), kind: 'device', label: 'paired browser',
    });
    crypto.roomKeys.enrollPeer(browserPeer);
    browserToken = crypto.browserSessions.issue(browserPeer.device_id).access_token;

    let capturedSession: ReturnType<FakeAdapter['spawn']> | undefined;
    const originalSpawn = fake.spawn.bind(fake);
    const spawn = vi.spyOn(fake, 'spawn').mockImplementationOnce((opts) => {
      const session = originalSpawn(opts);
      capturedSession = session;
      return session;
    });
    daemon.spawnMember('eng', {
      harness: 'fake', handle: 'preset-agent', cwd: dir,
    });
    spawn.mockRestore();
    const capturedAgentToken = capturedSession?.env?.CODOR_MEMBER_TOKEN;
    if (capturedAgentToken === undefined) throw new Error('agent credential was not issued');
    agentToken = capturedAgentToken;
    server = await startServer({
      daemon,
      token: 'owner-token',
      principals: [
        { token: 'admin-token', member_id: admin.id },
        { token: 'member-token', member_id: member.id },
        { token: 'observer-token', member_id: observer.id },
      ],
      crypto,
    });
  });

  afterEach(async () => {
    if (server !== undefined) await server.close();
    if (browser !== undefined) browser.close();
    if (crypto !== undefined) crypto.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const inject = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token?: string, payload?: unknown) =>
    server.app.inject({
      method,
      url,
      headers: {
        ...(token !== undefined && { authorization: `Bearer ${token}` }),
        ...(payload !== undefined && { 'content-type': 'application/json' }),
      },
      ...(payload !== undefined && { payload }),
    });

  it('requires manage_agents for the complete principal matrix and protects custom launches', async () => {
    const custom = await inject('POST', '/api/agent-presets', 'admin-token', customAcpInput);
    expect(custom.statusCode).toBe(201);
    const customId = (custom.json().preset as { id: string }).id;

    for (const [principal, token] of [
      ['owner', 'owner-token'], ['browser', browserToken], ['admin', 'admin-token'],
    ] as const) {
      const list = await inject('GET', '/api/agent-presets', token);
      expect(list.statusCode).toBe(200);
      expect(list.json().presets).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: customId, acp_launch: customAcpInput.acp_launch }),
      ]));
      expect((await inject('GET', `/api/agent-presets/${customId}`, token)).statusCode).toBe(200);
      expect((await inject('GET', '/api/default-roster', token)).statusCode).toBe(200);
      const matrixCreate = await inject('POST', '/api/agent-presets', token, {
        ...nativeInput, model: undefined, thinking: undefined,
        handle: `${principal}-matrix`,
      });
      expect(matrixCreate.statusCode).toBe(201);
      const matrixId = (matrixCreate.json().preset as { id: string }).id;
      const matrixUpdate = await inject('PUT', `/api/agent-presets/${matrixId}`, token, {
        ...nativeInput, model: undefined, thinking: undefined,
        handle: `${principal}-updated`, label: 'Updated matrix preset',
      });
      expect(matrixUpdate.statusCode).toBe(200);
      expect((await inject('PUT', '/api/default-roster', token, {
        preset_ids: [matrixId],
      })).statusCode).toBe(200);
      expect((await inject('DELETE', `/api/agent-presets/${matrixId}`, token)).statusCode)
        .toBe(409);
      expect((await inject('PUT', '/api/default-roster', token, {
        preset_ids: [],
      })).statusCode).toBe(200);
      expect((await inject('DELETE', `/api/agent-presets/${matrixId}`, token)).statusCode)
        .toBe(204);
    }

    const deniedTokens: (string | undefined)[] = [
      undefined, 'member-token', 'observer-token', agentToken,
    ];
    for (const token of deniedTokens) {
      const expected = token === undefined ? 401 : 403;
      for (const [method, url, payload] of [
        ['GET', '/api/agent-presets', undefined],
        ['GET', `/api/agent-presets/${customId}`, undefined],
        ['GET', '/api/default-roster', undefined],
        ['POST', '/api/agent-presets', nativeInput],
        ['PUT', `/api/agent-presets/${customId}`, nativeInput],
        ['DELETE', `/api/agent-presets/${customId}`, undefined],
        ['PUT', '/api/default-roster', { preset_ids: [] }],
      ] as const) {
        const response = await inject(method, url, token, payload);
        expect(response.statusCode).toBe(expected);
        expect(response.body).not.toContain(customAcpInput.acp_launch!.executable);
      }
    }
  });

  it('supports CRUD, ordered references, explicit conflicts, and strict request errors', async () => {
    const create = await inject('POST', '/api/agent-presets', 'admin-token', {
      ...nativeInput, model: undefined, thinking: undefined,
    });
    expect(create.statusCode).toBe(201);
    const preset = create.json().preset as { id: string; created_ts: string };
    expect((await inject('GET', '/api/agent-presets', 'admin-token')).json().presets)
      .toHaveLength(1);
    expect((await inject('POST', '/api/agent-presets', 'admin-token', {
      ...nativeInput, unknown: true,
    })).statusCode).toBe(400);

    const update = await inject('PUT', `/api/agent-presets/${preset.id}`, 'admin-token', {
      ...nativeInput, label: 'Renamed helper', handle: 'renamed-helper', model: undefined,
      thinking: undefined,
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().preset.id).toBe(preset.id);
    expect(update.json().preset.created_ts).toBe(preset.created_ts);
    expect((await inject('PUT', '/api/agent-presets/01ARZ3NDEKTSV4RRFFQ69G5FAV', 'admin-token', {
      ...nativeInput, model: undefined, thinking: undefined,
    })).statusCode).toBe(404);

    const roster = await inject('PUT', '/api/default-roster', 'admin-token', {
      preset_ids: [preset.id],
    });
    expect(roster.statusCode).toBe(200);
    expect(roster.json().roster.preset_ids).toEqual([preset.id]);
    expect((await inject('DELETE', `/api/agent-presets/${preset.id}`, 'admin-token')).statusCode)
      .toBe(409);
    expect((await inject('PUT', '/api/default-roster', 'admin-token', { preset_ids: [] })).statusCode)
      .toBe(200);
    expect((await inject('DELETE', `/api/agent-presets/${preset.id}`, 'admin-token')).statusCode)
      .toBe(204);
    expect((await inject('GET', `/api/agent-presets/${preset.id}`, 'admin-token')).statusCode)
      .toBe(404);
    expect((await inject('PUT', '/api/default-roster', 'admin-token', {
      preset_ids: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    })).statusCode).toBe(404);
  });

  it('does not spawn while creating a valid preset', async () => {
    const spawn = vi.spyOn(fake, 'spawn');
    const response = await inject('POST', '/api/agent-presets', 'admin-token', {
      ...nativeInput, model: undefined, thinking: undefined,
    });
    expect(response.statusCode).toBe(201);
    expect(spawn).not.toHaveBeenCalled();
  });
});
// harn:end agent-preset-management-is-authorized-and-transport-neutral

// harn:assume default-roster-channel-selection-is-exclusive-and-preflighted ref=default-roster-create-rest-regression
// harn:assume channel-creation-derived-and-seeded ref=default-roster-create-rest-regression
// harn:assume roles-gate-human-acts-not-agents ref=default-roster-create-role-regression
// harn:assume agent-network-authority-is-narrow ref=default-roster-create-agent-denial-regression
describe('default roster create REST boundary', () => {
  let daemon: Daemon;
  let server: RunningServer;
  let fake: FakeAdapter;
  let crypto: CryptoVault;
  let browser: CryptoVault;
  let browserToken: string;
  let browserDeviceId: string;
  let agentToken: string;
  let available: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'codor-default-roster-rest-'));
    available = vi.fn((executable: string) => executable !== 'missing');
    fake = new FakeAdapter('fake');
    Object.assign(fake, { executable: 'fake' });
    const acp = Object.assign(new FakeAdapter('acp'), { configurable: true });
    daemon = new Daemon({
      dbPath: join(dir, 'switchboard.sqlite'),
      blobRoot: join(dir, 'blobs'),
      adapters: [fake, acp],
      homeDir: dir,
      executableOnPath: available,
      discoverModels: false,
    });
    daemon.createRoom({
      id: 'rest-base', name: 'REST Base', owner: { handle: 'rest-owner', display_name: 'REST Owner' },
    });
    const admin = daemon.store.addMember('rest-base', {
      kind: 'human', handle: 'rest-admin', display_name: 'REST Admin', role: 'admin',
    });
    const member = daemon.store.addMember('rest-base', {
      kind: 'human', handle: 'rest-member', display_name: 'REST Member', role: 'member',
    });
    const observer = daemon.store.addMember('rest-base', {
      kind: 'human', handle: 'rest-observer', display_name: 'REST Observer', role: 'observer',
    });

    crypto = new CryptoVault(join(dir, 'crypto'));
    browser = new CryptoVault(join(dir, 'browser'));
    const browserPeer = crypto.keys.enrollPeer({
      ...browser.keys.publicIdentity(), kind: 'device', label: 'roster browser',
    });
    crypto.roomKeys.enrollPeer(browserPeer);
    browserDeviceId = browserPeer.device_id;
    browserToken = crypto.browserSessions.issue(browserDeviceId).access_token;

    let session: ReturnType<FakeAdapter['spawn']> | undefined;
    const originalSpawn = fake.spawn.bind(fake);
    const spawn = vi.spyOn(fake, 'spawn').mockImplementationOnce((opts) => {
      session = originalSpawn(opts);
      return session;
    });
    daemon.spawnMember('rest-base', { harness: 'fake', handle: 'rest-agent', cwd: dir });
    spawn.mockRestore();
    const capturedToken = session?.env?.CODOR_MEMBER_TOKEN;
    if (capturedToken === undefined) throw new Error('roster REST agent credential was not issued');
    agentToken = capturedToken;

    server = await startServer({
      daemon,
      token: 'owner-token',
      principals: [
        { token: 'admin-token', member_id: admin.id },
        { token: 'member-token', member_id: member.id },
        { token: 'observer-token', member_id: observer.id },
      ],
      crypto,
    });
  });

  afterEach(async () => {
    if (server !== undefined) await server.close();
    if (browser !== undefined) browser.close();
    if (crypto !== undefined) crypto.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const inject = (token: string | undefined, payload: unknown) => server.app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: {
      ...(token !== undefined && { authorization: `Bearer ${token}` }),
      'content-type': 'application/json',
    },
    payload,
  });

  it('admits owner and browser roster creates, denies every lower principal, and preserves legacy requests', async () => {
    const custom = daemon.createAgentPreset({
      ...customAcpInput, handle: 'rest-custom-roster',
    });
    const named = daemon.createAgentPreset({
      label: 'REST named', handle: 'rest-named-roster', harness: 'acp', acp_provider: 'kimi',
    });
    daemon.replaceDefaultRoster({ preset_ids: [custom.id] });

    const ownerResponse = await inject('owner-token', {
      id: 'rest-owner-roster', name: 'REST Owner Roster',
      owner: { handle: 'rest-owner-roster-human', display_name: 'Owner' },
      default_roster: true,
    });
    expect(ownerResponse.statusCode).toBe(200);
    const ownerText = ownerResponse.body;
    expect(ownerText).not.toContain(process.execPath);
    expect(ownerText).not.toContain('--acp');
    expect(ownerText).not.toContain('CODOR_MEMBER_TOKEN');
    expect(ownerText).not.toContain('acp_launch');
    expect(ownerText).not.toContain('session_lifecycle');

    const browserResponse = await inject(browserToken, {
      id: 'rest-browser-roster', name: 'REST Browser Roster',
      owner: { handle: 'rest-browser-roster-human', display_name: 'Browser Owner' },
      default_roster: true,
    });
    expect(browserResponse.statusCode).toBe(200);
    const browserBody = browserResponse.json() as {
      room: { id: string };
      room_key?: { room: string; generation: number; sealed_key: string };
    };
    expect(browserBody.room_key).toMatchObject({
      room: browserBody.room.id, generation: 1, sealed_key: expect.any(String),
    });
    expect(browserResponse.body).not.toContain(process.execPath);
    expect(browserResponse.body).not.toContain('--acp');
    expect(browserResponse.body).not.toContain('CODOR_MEMBER_TOKEN');
    expect(browserResponse.body).not.toContain('acp_launch');
    expect(browserResponse.body).not.toContain('session_lifecycle');

    const denied = [
      ['admin-token', 403, 'admin'],
      ['member-token', 403, 'member'],
      ['observer-token', 403, 'observer'],
      [agentToken, 403, 'agent'],
      [undefined, 401, 'anonymous'],
    ] as const;
    for (const [token, status, principal] of denied) {
      const id = `rest-denied-${principal}`;
      const response = await inject(token, {
        id, name: `Denied ${principal}`,
        owner: { handle: `${principal}-owner`, display_name: 'Denied Owner' },
        default_roster: true,
      });
      expect(response.statusCode).toBe(status);
      expect(daemon.store.getRoom(id)).toBeUndefined();
      expect(response.body).not.toContain(process.execPath);
      expect(response.body).not.toContain('CODOR_MEMBER_TOKEN');
    }

    available.mockImplementation((executable: string) => executable !== 'kimi');
    daemon.replaceDefaultRoster({ preset_ids: [named.id] });
    const invalidId = 'rest-invalid-roster';
    const invalid = await inject('owner-token', {
      id: invalidId, name: 'Invalid REST Roster',
      owner: { handle: 'invalid-rest-owner', display_name: 'Invalid Owner' },
      default_roster: true,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain(process.execPath);
    expect(invalid.body).not.toContain('--acp');
    expect(invalid.body).not.toContain('CODOR_MEMBER_TOKEN');
    expect(invalid.body).not.toContain('session_lifecycle');
    expect(daemon.store.getRoom(invalidId)).toBeUndefined();
    expect(crypto.roomKeys.sealedFor(browserDeviceId))
      .not.toContainEqual(expect.objectContaining({ room: invalidId }));

    available.mockReturnValue(true);
    const legacy = await inject('owner-token', {
      id: 'rest-legacy-omitted', name: 'REST Legacy Omitted',
      owner: { handle: 'legacy-omitted-owner', display_name: 'Legacy Owner' },
    });
    expect(legacy.statusCode).toBe(200);
    const starting = await inject('owner-token', {
      id: 'rest-legacy-starting', name: 'REST Legacy Starting',
      owner: { handle: 'legacy-starting-owner', display_name: 'Legacy Owner' },
      starting_agent: { harness: 'fake', handle: 'legacy-starting-agent' },
    });
    expect(starting.statusCode).toBe(200);
    expect(daemon.store.getRoom('rest-legacy-starting')?.config.starting_agent_handle)
      .toBe('legacy-starting-agent');
  });
  // harn:assume browser-created-channel-delivers-its-room-key ref=default-roster-browser-key-regression
  it('does not create a room key when roster preflight rejects a request', async () => {
    const named = daemon.createAgentPreset({
      label: 'Unavailable REST named', handle: 'rest-unavailable-named',
      harness: 'acp', acp_provider: 'kimi',
    });
    daemon.replaceDefaultRoster({ preset_ids: [named.id] });
    available.mockImplementation((executable: string) => executable !== 'kimi');
    const id = 'rest-browser-invalid';
    const response = await inject(browserToken, {
      id, name: 'Browser Invalid Roster',
      owner: { handle: 'browser-invalid-owner', display_name: 'Browser Owner' },
      default_roster: true,
    });
    expect(response.statusCode).toBe(400);
    expect(daemon.store.getRoom(id)).toBeUndefined();
    expect(crypto.roomKeys.sealedFor(browserDeviceId))
      .not.toContainEqual(expect.objectContaining({ room: id }));
  });
  // harn:end browser-created-channel-delivers-its-room-key
});
// harn:end agent-network-authority-is-narrow
// harn:end roles-gate-human-acts-not-agents
// harn:end channel-creation-derived-and-seeded
// harn:end default-roster-channel-selection-is-exclusive-and-preflighted

// harn:assume preset-derived-members-are-isolated-durable-snapshots ref=preset-derived-runtime-isolation-regression
describe('preset-derived member restart isolation', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codor-agent-presets-restart-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps Add-agent and repeated roster snapshots isolated through restart', async () => {
    const firstInput: AgentPresetInput = {
      ...nativeInput,
      label: 'Phase 5 North',
      handle: 'phase5-north',
      display_name: 'Phase 5 North Display',
      model: 'phase5-north-model',
      thinking: 'high',
    };
    const secondInput: AgentPresetInput = {
      ...nativeInput,
      label: 'Phase 5 South',
      handle: 'phase5-south',
      display_name: 'Phase 5 South Display',
      model: 'phase5-south-model',
      thinking: 'low',
    };
    const dbPath = join(dir, 'switchboard.sqlite');
    const blobRoot = join(dir, 'blobs');
    const fake = new FakeAdapter('fake', {
      thinking: true,
      thinking_levels: ['low', 'medium', 'high'],
    });
    const spawned: ReturnType<FakeAdapter['spawn']>[] = [];
    const originalSpawn = fake.spawn.bind(fake);
    vi.spyOn(fake, 'spawn').mockImplementation((opts) => {
      const session = originalSpawn(opts);
      spawned.push(session);
      return session;
    });
    let daemon: Daemon | undefined;
    let reopened: Daemon | undefined;

    const memberState = (member: NonNullable<ReturnType<Store['getMember']>>) => ({
      id: member.id,
      kind: member.kind,
      handle: member.handle,
      display_name: member.display_name,
      harness: member.harness,
      cwd: member.cwd,
      model: member.model,
      thinking: member.thinking,
      policy: member.policy,
      state: member.state,
      session_ref: member.session_ref,
      tasks: member.tasks,
    });

    try {
      daemon = new Daemon({
        dbPath,
        blobRoot,
        adapters: [fake],
        homeDir: dir,
        discoverModels: false,
        executableOnPath: () => true,
      });
      const first = daemon.createAgentPreset(firstInput);
      const second = daemon.createAgentPreset(secondInput);
      daemon.replaceDefaultRoster({ preset_ids: [first.id, second.id] });

      const spawnFromPreset = (room: string, input: AgentPresetInput): ReturnType<Daemon['spawnMember']> =>
        daemon!.spawnMember(room, {
          harness: input.harness,
          handle: input.handle,
          display_name: input.display_name,
          cwd: dir,
          policy: input.policy,
          model: input.model,
          thinking: input.thinking,
        });

      daemon.createRoom({
        id: 'phase5-add', name: 'Phase 5 Add agent',
        owner: { handle: 'phase5-add-owner', display_name: 'Add Owner' }, cwd: dir,
      });
      const addFirst = spawnFromPreset('phase5-add', firstInput);
      const addSecond = spawnFromPreset('phase5-add', secondInput);
      const rosterOne = daemon.createRoom({
        id: 'phase5-roster-one', name: 'Phase 5 Roster One',
        owner: { handle: 'phase5-roster-one-owner', display_name: 'Roster One Owner' },
        cwd: dir, default_roster: true,
      });
      const rosterTwo = daemon.createRoom({
        id: 'phase5-roster-two', name: 'Phase 5 Roster Two',
        owner: { handle: 'phase5-roster-two-owner', display_name: 'Roster Two Owner' },
        cwd: dir, default_roster: true,
      });
      const entries = [
        { key: 'add-north', room: 'phase5-add', member: addFirst, session: spawned[0]! },
        { key: 'add-south', room: 'phase5-add', member: addSecond, session: spawned[1]! },
        { key: 'roster-one-north', room: 'phase5-roster-one', member: rosterOne.initialAgents[0]!, session: spawned[2]! },
        { key: 'roster-one-south', room: 'phase5-roster-one', member: rosterOne.initialAgents[1]!, session: spawned[3]! },
        { key: 'roster-two-north', room: 'phase5-roster-two', member: rosterTwo.initialAgents[0]!, session: spawned[4]! },
        { key: 'roster-two-south', room: 'phase5-roster-two', member: rosterTwo.initialAgents[1]!, session: spawned[5]! },
      ] as const;
      expect(entries.every((entry) => entry.session !== undefined)).toBe(true);
      expect(new Set(entries.map((entry) => entry.member.id)).size).toBe(entries.length);
      expect(new Set(entries.map((entry) => entry.session)).size).toBe(entries.length);

      const driveTurn = async (
        target: Daemon,
        adapter: FakeAdapter,
        entry: (typeof entries)[number],
        suffix: string,
      ): Promise<void> => {
        const taskId = `task-${entry.key}-${suffix}`;
        adapter.enqueue({
          kind: 'complete',
          final_text: `final ${entry.key} ${suffix}`,
          usage: { input_tokens: 11, output_tokens: 7, cost_usd: 0.01 },
          agent_usage: {
            inputTokens: 11,
            outputTokens: 7,
            totalCostUsd: 0.01,
            contextWindowMaxTokens: 200_000,
            contextWindowUsedTokens: 11,
          },
          items: [{
            type: 'run.tasks',
            update: {
              op: 'replace',
              items: [{ id: taskId, content: `Task ${entry.key} ${suffix}`, status: 'completed' }],
            },
          }],
        });
        target.postHumanMessage(entry.room, `@${entry.member.handle} prove ${entry.key} ${suffix}`);
        await target.settle();
      };

      for (const entry of entries) await driveTurn(daemon, fake, entry, 'before-restart');
      expect(new Set(entries.map((entry) => entry.session.session_ref)).size).toBe(entries.length);

      const before = new Map(entries.map((entry) => {
        const member = daemon!.store.getMember(entry.room, entry.member.id)!;
        const token = entry.session.env?.CODOR_MEMBER_TOKEN;
        expect(token).toEqual(expect.any(String));
        expect(entry.session.env).toMatchObject({
          CODOR_CHANNEL: entry.room,
          CODOR_MEMBER_ID: entry.member.id,
          CODOR_MEMBER_TOKEN: token,
        });
        expect(daemon!.authenticateAgentToken(token!)).toMatchObject({
          room: entry.room, member: { id: entry.member.id },
        });
        expect(daemon!.store.getAgentRuntimeConfig(entry.room, entry.member.id)).toEqual({});
        const publicText = JSON.stringify([
          daemon!.store.listMembers(entry.room),
          daemon!.memberDetails(entry.room),
          daemon!.store.listMessages(entry.room, { limit: Number.MAX_SAFE_INTEGER }),
        ]);
        expect(publicText).not.toContain(token!);
        return [entry.key, {
          member: memberState(member),
          token: token!,
          session: entry.session,
          sessionRef: entry.session.session_ref!,
          finalText: `final ${entry.key} before-restart`,
          taskId: `task-${entry.key}-before-restart`,
          roomMessages: daemon!.store.listMessages(entry.room, { limit: Number.MAX_SAFE_INTEGER }),
          meter: daemon!.store.getMeter(entry.room, new Date().toISOString().slice(0, 10)),
        }] as const;
      }));
      const oldTokens = [...before.values()].map((snapshot) => snapshot.token);
      expect(new Set(oldTokens).size).toBe(entries.length);

      for (const entry of entries) {
        const roomMessages = daemon.store.listMessages(entry.room, { limit: Number.MAX_SAFE_INTEGER });
        expect(roomMessages.some((message) => message.body === `final ${entry.key} before-restart`)).toBe(true);
        for (const other of entries) {
          if (other.room === entry.room || other.key === entry.key) continue;
          expect(roomMessages.some((message) => message.body === `final ${other.key} before-restart`)).toBe(false);
        }
        expect(daemon.store.getMember(entry.room, entry.member.id)?.tasks?.items[0]?.id)
          .toBe(`task-${entry.key}-before-restart`);
      }

      daemon.updateAgentPreset(first.id, {
        ...firstInput,
        label: 'Phase 5 North edited', handle: 'phase5-north-edited',
        display_name: 'Phase 5 North Edited', policy: 'full-access',
        model: 'phase5-north-edited-model', thinking: 'low',
      });
      daemon.updateAgentPreset(second.id, {
        ...secondInput,
        label: 'Phase 5 South edited', handle: 'phase5-south-edited',
        display_name: 'Phase 5 South Edited', policy: 'read-only',
        model: 'phase5-south-edited-model', thinking: 'high',
      });
      daemon.replaceDefaultRoster({ preset_ids: [second.id, first.id] });
      expect(daemon.getDefaultRoster().preset_ids).toEqual([second.id, first.id]);

      for (const entry of entries) {
        expect(memberState(daemon.store.getMember(entry.room, entry.member.id)!))
          .toEqual(before.get(entry.key)!.member);
      }
      await daemon.close();
      daemon = undefined;

      const restartedFake = new FakeAdapter('fake', {
        thinking: true,
        thinking_levels: ['low', 'medium', 'high'],
      });
      const attached: ReturnType<FakeAdapter['attach']>[] = [];
      const originalAttach = restartedFake.attach.bind(restartedFake);
      vi.spyOn(restartedFake, 'attach').mockImplementation((sessionRef) => {
        const session = originalAttach(sessionRef);
        attached.push(session);
        return session;
      });
      reopened = new Daemon({
        dbPath,
        blobRoot,
        adapters: [restartedFake],
        homeDir: dir,
        discoverModels: false,
        executableOnPath: () => true,
      });
      expect(reopened.listAgentPresets().map((preset) => preset.label).sort()).toEqual([
        'Phase 5 North edited', 'Phase 5 South edited',
      ].sort());
      expect(reopened.getDefaultRoster().preset_ids).toEqual([second.id, first.id]);
      for (const entry of entries) {
        expect(memberState(reopened.store.getMember(entry.room, entry.member.id)!))
          .toEqual(before.get(entry.key)!.member);
      }

      const freshTokens = new Map<string, string>();
      for (const entry of entries) {
        const beforePeerMembers = new Map(entries.map((peer) => [
          peer.key,
          memberState(reopened!.store.getMember(peer.room, peer.member.id)!),
        ]));
        const beforePeerRooms = new Map([...new Set(entries.map((peer) => peer.room))].map((room) => [room, {
          members: reopened!.store.listMembers(room).map(memberState),
          messages: reopened!.store.listMessages(room, { limit: Number.MAX_SAFE_INTEGER }),
          meter: reopened!.store.getMeter(room, new Date().toISOString().slice(0, 10)),
        }]));
        await driveTurn(reopened, restartedFake, entry, 'after-restart');
        const session = attached.find((candidate) => candidate.env?.CODOR_MEMBER_ID === entry.member.id);
        expect(session).toBeDefined();
        expect(session).not.toBe(before.get(entry.key)!.session);
        expect(session!.session_ref).toBe(before.get(entry.key)!.sessionRef);
        expect(restartedFake.wasAttached(before.get(entry.key)!.sessionRef)).toBe(true);
        expect(new Set(attached).size).toBe(attached.length);
        const token = session!.env?.CODOR_MEMBER_TOKEN;
        expect(token).toEqual(expect.any(String));
        expect(token).not.toBe(before.get(entry.key)!.token);
        expect(session!.env).toMatchObject({
          CODOR_CHANNEL: entry.room,
          CODOR_MEMBER_ID: entry.member.id,
          CODOR_MEMBER_TOKEN: token,
        });
        freshTokens.set(entry.key, token!);
        expect(reopened.authenticateAgentToken(token!)).toMatchObject({
          room: entry.room, member: { id: entry.member.id },
        });
        expect(reopened.authenticateAgentToken(before.get(entry.key)!.token)).toBeUndefined();
        const current = reopened.store.getMember(entry.room, entry.member.id)!;
        expect(current.handle).toBe(before.get(entry.key)!.member.handle);
        expect(current.display_name).toBe(before.get(entry.key)!.member.display_name);
        expect(current.model).toBe(before.get(entry.key)!.member.model);
        expect(current.thinking).toBe(before.get(entry.key)!.member.thinking);
        expect(current.policy).toBe(before.get(entry.key)!.member.policy);
        expect(current.tasks?.items[0]?.id).toBe(`task-${entry.key}-after-restart`);
        const publicText = JSON.stringify([
          reopened.store.listMembers(entry.room),
          reopened.memberDetails(entry.room),
          reopened.store.listMessages(entry.room, { limit: Number.MAX_SAFE_INTEGER }),
        ]);
        expect(publicText).not.toContain(token!);

        for (const peer of entries) {
          if (peer.key === entry.key) continue;
          expect(memberState(reopened.store.getMember(peer.room, peer.member.id)!))
            .toEqual(beforePeerMembers.get(peer.key));
          if (peer.room !== entry.room) {
            expect(reopened.store.listMessages(peer.room, { limit: Number.MAX_SAFE_INTEGER }))
              .toEqual(beforePeerRooms.get(peer.room)!.messages);
            expect(reopened.store.getMeter(peer.room, new Date().toISOString().slice(0, 10)))
              .toEqual(beforePeerRooms.get(peer.room)!.meter);
          }
        }
      }
      expect(new Set([...freshTokens.values()]).size).toBe(entries.length);
      for (const token of oldTokens) expect(reopened.authenticateAgentToken(token)).toBeUndefined();

      reopened.replaceDefaultRoster({ preset_ids: [] });
      reopened.deleteAgentPreset(first.id);
      reopened.deleteAgentPreset(second.id);
      expect(reopened.listAgentPresets()).toEqual([]);
      for (const entry of entries) {
        expect(reopened.store.getMemberByHandle(entry.room, entry.member.handle)?.id)
          .toBe(entry.member.id);
      }
    } finally {
      if (reopened !== undefined) await reopened.close();
      if (daemon !== undefined) await daemon.close();
    }
  });
});
// harn:end preset-derived-members-are-isolated-durable-snapshots
