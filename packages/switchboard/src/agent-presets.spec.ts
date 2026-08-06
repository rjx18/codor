import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentPresetInput } from '@codor/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Daemon } from './daemon.js';
import { FakeAdapter } from './fake-adapter.js';
import {
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
  acp_launch: { executable: 'custom-agent', argv: ['--acp'] },
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

  it('migrates legacy room state, persists CRUD, and keeps server identity stable', () => {
    const path = join(dir, 'switchboard.sqlite');
    let store = new Store(path);
    const room = store.createRoom({
      id: 'eng', name: 'Eng', owner: { handle: 'richard', display_name: 'Richard' },
    });
    const originalMembers = store.listMembers('eng');
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

    expect(() => store.replaceDefaultRoster({
      preset_ids: [preset.id, '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    })).toThrow('no such agent preset');
    expect(store.getDefaultRoster().preset_ids).toEqual([preset.id, custom.id]);

    store.close();
    store = new Store(path);
    expect(store.getAgentPreset(custom.id)?.acp_launch).toEqual(customAcpInput.acp_launch);
    expect(store.getDefaultRoster().preset_ids).toEqual([preset.id, custom.id]);
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
    const store = new Store(join(dir, 'switchboard.sqlite'));
    const first = store.createAgentPreset({ ...nativeInput, handle: 'first-preset', label: 'First' });
    const second = store.createAgentPreset({ ...nativeInput, handle: 'second-preset', label: 'Second' });

    expect(store.replaceDefaultRoster([second.id, first.id]).preset_ids)
      .toEqual([second.id, first.id]);
    expect(() => store.replaceDefaultRoster({ preset_ids: [first.id, first.id] }))
      .toThrow();
    expect(store.getDefaultRoster().preset_ids).toEqual([second.id, first.id]);
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
    const acp = new FakeAdapter('acp');
    const spawn = vi.spyOn(fake, 'spawn');
    const daemon = new Daemon({
      dbPath: join(dir, 'switchboard.sqlite'),
      blobRoot: join(dir, 'blobs'),
      adapters: [fake, acp],
      homeDir: dir,
      discoverModels: true,
      executableOnPath: () => true,
    });
    try {
      await waitFor(() => daemon.registeredAdapters().some((adapter) => adapter.models?.includes('fake-model')));
      const native = daemon.createAgentPreset(nativeInput);
      expect(native.model).toBe('fake-model');
      expect(spawn).not.toHaveBeenCalled();
      expect(() => daemon.createAgentPreset({ ...nativeInput, model: 'not-in-catalog' }))
        .toThrow('not currently offered');
      expect(() => daemon.createAgentPreset({ ...nativeInput, policy: 'danger' as never }))
        .toThrow();
      expect(() => daemon.createAgentPreset({ ...nativeInput, handle: 'switchboard' }))
        .toThrow();

      const named = daemon.createAgentPreset({
        label: 'Named ACP', handle: 'named-provider', harness: 'acp', acp_provider: 'kimi',
      });
      expect(named.acp_provider).toBe('kimi');
      const custom = daemon.createAgentPreset({ ...customAcpInput, handle: 'custom-provider' });
      expect(custom.acp_launch).toEqual(customAcpInput.acp_launch);
      expect(() => daemon.createAgentPreset({
        label: 'Missing provider', handle: 'missing-provider', harness: 'acp', acp_provider: 'unknown',
      })).toThrow('unknown ACP provider');
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

// harn:assume agent-preset-management-is-authorized-and-transport-neutral ref=agent-preset-rest-regression
describe('agent preset REST authorization and behavior', () => {
  let daemon: Daemon;
  let server: RunningServer;
  let fake: FakeAdapter;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'codor-agent-presets-server-'));
    fake = new FakeAdapter('fake');
    Object.assign(fake, { executable: 'fake' });
    daemon = new Daemon({
      dbPath: join(dir, 'switchboard.sqlite'),
      blobRoot: join(dir, 'blobs'),
      adapters: [fake],
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
    server = await startServer({
      daemon,
      token: 'owner-token',
      principals: [
        { token: 'admin-token', member_id: admin.id },
        { token: 'member-token', member_id: member.id },
        { token: 'observer-token', member_id: observer.id },
      ],
    });
  });

  afterEach(async () => {
    await server.close();
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

  it('requires manage_agents for reads and writes, including custom launch material', async () => {
    expect((await inject('GET', '/api/agent-presets')).statusCode).toBe(401);
    for (const token of ['member-token', 'observer-token']) {
      expect((await inject('GET', '/api/agent-presets', token)).statusCode).toBe(403);
      expect((await inject('POST', '/api/agent-presets', token, customAcpInput)).statusCode).toBe(403);
    }
    expect((await inject('GET', '/api/agent-presets', 'owner-token')).statusCode).toBe(200);
    expect((await inject('GET', '/api/agent-presets', 'admin-token')).statusCode).toBe(200);
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
