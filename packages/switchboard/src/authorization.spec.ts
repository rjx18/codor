import type { Act, Member, Role } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import {
  AGENT_CAPABILITIES,
  agentAllows,
  assertAgentCapability,
  assertHumanCapability,
  CAPABILITY_MINIMUM_ROLE,
  roleAllows,
  type HumanCapability,
  type RoomCapability,
} from './authorization.js';

const roles: Role[] = ['observer', 'member', 'admin', 'owner'];
const rank: Record<Role, number> = { observer: 0, member: 1, admin: 2, owner: 3 };
const actSamples = {
  answer_interaction: { act: 'answer_interaction', interaction_id: 'i', answer: 'yes' },
  redeliver: { act: 'redeliver', delivery_id: 'd' },
  release_hold: { act: 'release_hold', delivery_id: 'd' },
  mark_read: { act: 'mark_read', delivery_id: 'd' },
  join: { act: 'join', harness: 'fake', handle: 'joined', session_ref: 's', cwd: '/w' },
  adopt: { act: 'adopt', member_id: '01J00000000000000000000000' },
  attach_acquire: { act: 'attach_acquire', member_id: '01J00000000000000000000000', cli_pid: 1 },
  attach_child: { act: 'attach_child', lease_id: 'l', child_pid: 1, process_group_id: 1 },
  attach_heartbeat: { act: 'attach_heartbeat', lease_id: 'l' },
  attach_complete: { act: 'attach_complete', lease_id: 'l' },
  configure_room: { act: 'configure_room', turn_brake: 2 },
  spawn: { act: 'spawn', harness: 'fake', handle: 'runner', cwd: '/w' },
  rename: { act: 'rename', member_id: '01J00000000000000000000000', handle: 'renamed' },
  revive: { act: 'revive', member_id: '01J00000000000000000000000' },
  kill: { act: 'kill', member_id: '01J00000000000000000000000' },
  // harn:assume removed-members-remain-attribution-tombstones ref=member-removal-role-matrix
  remove: { act: 'remove', member_id: '01J00000000000000000000000' },
  // harn:end removed-members-remain-attribution-tombstones
  pause: { act: 'pause', member_id: '01J00000000000000000000000' },
  unpause: { act: 'unpause', member_id: '01J00000000000000000000000' },
  interrupt: { act: 'interrupt', member_id: '01J00000000000000000000000' },
  set_role: { act: 'set_role', member_id: '01J00000000000000000000000', role: 'member' },
} satisfies { [K in Act['act']]: Extract<Act, { act: K }> };

// harn:assume roles-gate-human-acts-not-agents ref=role-matrix-integration
describe('PROTOCOL section 1 role matrix', () => {
  it.each(roles)('enforces every human capability for %s', (role) => {
    for (const [capability, minimum] of Object.entries(CAPABILITY_MINIMUM_ROLE) as
      [HumanCapability, Role][]) {
      expect(roleAllows(role, capability), `${role} -> ${capability}`)
        .toBe(rank[role] >= rank[minimum]);
    }
  });

  it('accounts for every wire act exactly once', () => {
    const acts = Object.values(actSamples) as Act[];
    expect(new Set(acts.map((act) => act.act))).toEqual(new Set(Object.keys(actSamples)));
    for (const role of roles) {
      for (const act of acts) {
        expect(roleAllows(role, act.act), `${role} -> ${act.act}`)
          .toBe(rank[role] >= rank[CAPABILITY_MINIMUM_ROLE[act.act]]);
      }
    }
  });

  it('rejects non-humans instead of treating harness agents as low-role users', () => {
    const agent = {
      id: '01J00000000000000000000000',
      kind: 'agent',
      handle: 'runner',
      display_name: 'Runner',
      harness: 'fake',
      cwd: '/w',
      state: 'idle',
      conventions_sent: false,
      misaddressed: false,
    } satisfies Member;
    expect(() => assertHumanCapability(agent, 'read')).toThrow('not a human member');
  });
});
// harn:end roles-gate-human-acts-not-agents

// harn:assume agent-network-authority-is-narrow ref=agent-capability-regression
describe('agent member credential capability matrix', () => {
  const agent = {
    id: '01J00000000000000000000001',
    kind: 'agent',
    handle: 'runner',
    display_name: 'Runner',
    harness: 'fake',
    cwd: '/w',
    state: 'running',
    conventions_sent: false,
    misaddressed: false,
  } satisfies Member;

  it('contains exactly the live collaboration capabilities', () => {
    expect(new Set(AGENT_CAPABILITIES)).toEqual(new Set([
      'read',
      'post',
      'search',
      'consume_delivery',
      'wait_begin',
      'wait_end',
      'member_status',
    ]));
  });

  it('excludes configure and every existing management act', () => {
    const existingWireActs = [...Object.keys(actSamples), 'configure'];
    for (const act of existingWireActs) {
      expect(agentAllows(act as RoomCapability), act).toBe(false);
      expect(() => assertAgentCapability(agent, act as RoomCapability), act)
        .toThrow('forbidden: agent cannot');
    }
  });

  it('accepts every declared agent capability and rejects a human principal', () => {
    for (const capability of AGENT_CAPABILITIES) {
      expect(() => assertAgentCapability(agent, capability)).not.toThrow();
    }
    const human = { ...agent, kind: 'human', role: 'member' } satisfies Member;
    expect(() => assertAgentCapability(human, 'read')).toThrow('not an agent member');
  });
});
// harn:end agent-network-authority-is-narrow
