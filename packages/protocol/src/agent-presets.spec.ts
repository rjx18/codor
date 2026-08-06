import { describe, expect, it } from 'vitest';

import {
  AgentPresetInputSchema,
  AgentPresetPublicSchema,
  AgentPresetSchema,
  DefaultRosterInputSchema,
  DefaultRosterSchema,
} from './agent-presets.js';

const PRESET_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER_PRESET_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const TIMESTAMP = '2026-08-06T00:00:00.000Z';

const nativeInput = {
  label: ' Review helper ',
  handle: 'review-helper',
  display_name: 'Review Helper',
  harness: 'codex',
  model: 'gpt-5.1-codex',
  thinking: 'high' as const,
  policy: 'workspace-write' as const,
};

// harn:assume individual-agent-presets-are-bounded-catalog-validated-configurations ref=individual-agent-preset-schema-regression
describe('individual agent preset schemas', () => {
  it('accepts reusable native configuration and server-owned record metadata', () => {
    expect(AgentPresetInputSchema.parse(nativeInput)).toMatchObject({
      label: 'Review helper',
      handle: 'review-helper',
    });
    expect(AgentPresetSchema.parse({
      id: PRESET_ID,
      schema_version: 1,
      created_ts: TIMESTAMP,
      updated_ts: TIMESTAMP,
      ...nativeInput,
    })).toMatchObject({ id: PRESET_ID, schema_version: 1 });
  });

  it('rejects server-owned fields, runtime state, and unknown configuration', () => {
    for (const field of [
      'id', 'schema_version', 'created_ts', 'updated_ts', 'cwd', 'purpose',
      'credential', 'session_ref', 'state', 'usage', 'tasks', 'spend', 'host',
      'custody', 'membership', 'room', 'native_session', 'unknown',
    ]) {
      expect(AgentPresetInputSchema.safeParse({ ...nativeInput, [field]: 'forbidden' }).success)
        .toBe(false);
    }
  });

  it('enforces ACP one-of and excludes a client-selected ACP model', () => {
    const launch = { executable: 'custom-agent', argv: ['--acp'] };
    expect(AgentPresetInputSchema.safeParse({
      label: 'Named ACP', handle: 'named-acp', harness: 'acp', acp_provider: 'kimi',
    }).success).toBe(true);
    expect(AgentPresetInputSchema.safeParse({
      label: 'Custom ACP', handle: 'custom-acp', harness: 'acp', acp_launch: launch,
    }).success).toBe(true);
    expect(AgentPresetInputSchema.safeParse({
      label: 'Both ACP', handle: 'both-acp', harness: 'acp',
      acp_provider: 'kimi', acp_launch: launch,
    }).success).toBe(false);
    expect(AgentPresetInputSchema.safeParse({
      label: 'No ACP', handle: 'no-acp', harness: 'acp',
    }).success).toBe(false);
    expect(AgentPresetInputSchema.safeParse({
      label: 'ACP model', handle: 'acp-model', harness: 'acp',
      acp_provider: 'kimi', model: 'gpt-5.1-codex',
    }).success).toBe(false);
    expect(AgentPresetInputSchema.safeParse({
      ...nativeInput, acp_provider: 'kimi',
    }).success).toBe(false);
  });

  it('rejects invalid identity and bounded model values', () => {
    expect(AgentPresetInputSchema.safeParse({ ...nativeInput, handle: 'switchboard' }).success)
      .toBe(false);
    expect(AgentPresetInputSchema.safeParse({ ...nativeInput, model: '--danger' }).success)
      .toBe(false);
    expect(AgentPresetInputSchema.safeParse({ ...nativeInput, label: '' }).success).toBe(false);
    expect(AgentPresetInputSchema.safeParse({ ...nativeInput, thinking: 'extreme' }).success)
      .toBe(false);
  });

  it('accepts the maximum named ACP public selector without exposing launch material', () => {
    const maximumProvider = `a${'p'.repeat(63)}`;
    const publicPreset = {
      id: PRESET_ID,
      schema_version: 1,
      created_ts: TIMESTAMP,
      updated_ts: TIMESTAMP,
      label: 'Maximum provider',
      handle: 'maximum-provider',
      adapter: `acp:${maximumProvider}`,
    };
    expect(AgentPresetPublicSchema.parse(publicPreset)).toEqual(publicPreset);
    expect(AgentPresetPublicSchema.safeParse({
      ...publicPreset,
      adapter: `acp:${'a'.repeat(65)}`,
    }).success).toBe(false);
    expect(AgentPresetPublicSchema.safeParse({
      ...publicPreset,
      adapter: 'acp',
      custom_acp: true,
      acp_launch: { executable: '/private/agent', argv: ['--secret'] },
    }).success).toBe(false);
  });
});
// harn:end individual-agent-presets-are-bounded-catalog-validated-configurations

// harn:assume default-roster-is-one-versioned-ordered-preset-reference-group ref=default-roster-schema
describe('default roster schemas', () => {
  it('accepts the empty and ordered reference forms, but not duplicates', () => {
    expect(DefaultRosterInputSchema.safeParse({ preset_ids: [] }).success).toBe(true);
    expect(DefaultRosterInputSchema.safeParse({
      preset_ids: [PRESET_ID, OTHER_PRESET_ID],
    }).success).toBe(true);
    expect(DefaultRosterInputSchema.safeParse({
      preset_ids: [PRESET_ID, PRESET_ID],
    }).success).toBe(false);
    expect(DefaultRosterInputSchema.safeParse({ preset_ids: [PRESET_ID], extra: true }).success)
      .toBe(false);
  });

  it('requires the server-owned singleton record shape on reads', () => {
    expect(DefaultRosterSchema.safeParse({
      id: 'default', schema_version: 1, updated_ts: TIMESTAMP, preset_ids: [PRESET_ID],
    }).success).toBe(true);
    expect(DefaultRosterSchema.safeParse({
      id: 'other', schema_version: 1, updated_ts: TIMESTAMP, preset_ids: [],
    }).success).toBe(false);
  });
});
// harn:end default-roster-is-one-versioned-ordered-preset-reference-group
