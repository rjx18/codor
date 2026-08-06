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
    const spawn = vi.spyOn(fake, 'spawn');
    spawn.mockImplementationOnce(() => { throw new Error('first runtime failed'); });
    spawn.mockImplementation((opts) => originalSpawn(opts));

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

// harn:assume agent-preset-management-is-authorized-across-rest-and-cli ref=agent-preset-rest-regression
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
// harn:end agent-preset-management-is-authorized-across-rest-and-cli
