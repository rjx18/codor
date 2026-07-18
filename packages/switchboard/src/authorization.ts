import type { Act, Member, Role } from '@codor/protocol';

type AgentOnlyAct = 'wait_begin' | 'wait_end';

export type HumanCapability =
  | 'read'
  | 'post'
  | Exclude<Act['act'], AgentOnlyAct>
  | 'mirror_turn'
  | 'mirror_session_end'
  | 'manage_ledger'
  | 'enable_bridge'
  | 'manage_keys'
  | 'manage_devices'
  | 'manage_agents'
  | 'manage_roles'
  | 'manage_rooms';

const ROLE_RANK: Record<Role, number> = {
  observer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

// harn:assume roles-gate-human-acts-not-agents ref=role-matrix-source
export const CAPABILITY_MINIMUM_ROLE: Record<HumanCapability, Role> = {
  read: 'observer',
  mark_read: 'observer',
  mark_room_read: 'observer',
  consume_delivery: 'member',
  post: 'member',
  answer_interaction: 'member',
  release_hold: 'member',
  redeliver: 'admin',
  join: 'admin',
  adopt: 'admin',
  attach_acquire: 'admin',
  attach_child: 'admin',
  attach_heartbeat: 'admin',
  attach_complete: 'admin',
  configure_room: 'admin',
  spawn: 'admin',
  // Pinning a message is an owner/admin marker (P9). Agents never gain it —
  // AGENT_CAPABILITIES omits pin_message, so the roles gate refuses them.
  pin_message: 'admin',
  // Deleting a message purges its body (P9); owner/admin only, agents refused.
  delete_message: 'admin',
  // Retrying a failed/interrupted run re-delivers its instructions (P9);
  // owner/admin only, agents refused (AGENT_CAPABILITIES omits it).
  retry_run: 'admin',
  // Compacting an agent's engine session spends the operator's context on their
  // behalf; owner/admin only, and AGENT_CAPABILITIES omits it so an agent can
  // never compact itself or a peer.
  compact_member: 'admin',
  // Changing what an agent may do to the machine is an admin act, like creating one.
  // NOTE for codor-live-collab: when members gain credentials, `configure` must be
  // EXCLUDED from what an agent may do — an agent must never raise its own permission.
  configure: 'admin',
  rename: 'admin',
  revive: 'admin',
  kill: 'admin',
  // harn:assume removed-members-remain-attribution-tombstones ref=member-removal-role-matrix
  remove: 'admin',
  pause: 'admin',
  unpause: 'admin',
  interrupt: 'admin',
  mirror_turn: 'admin',
  mirror_session_end: 'admin',
  manage_ledger: 'admin',
  manage_agents: 'admin',
  // harn:end removed-members-remain-attribution-tombstones
  enable_bridge: 'admin',
  set_role: 'owner',
  manage_keys: 'owner',
  manage_devices: 'owner',
  manage_roles: 'owner',
  manage_rooms: 'owner',
};

export function roleAllows(role: Role, capability: HumanCapability): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[CAPABILITY_MINIMUM_ROLE[capability]];
}

export function assertHumanCapability(member: Member, capability: HumanCapability): void {
  if (member.kind !== 'human' || member.role === undefined) {
    throw new Error(`authorization principal ${member.id} is not a human member`);
  }
  if (!roleAllows(member.role, capability)) {
    throw new Error(
      `forbidden: ${member.role} cannot ${capability.replaceAll('_', ' ')}`,
    );
  }
}
// harn:end roles-gate-human-acts-not-agents

// harn:assume agent-network-authority-is-narrow ref=agent-capability-matrix
export const AGENT_CAPABILITIES = [
  'read',
  'post',
  'search',
  'consume_delivery',
  'wait_begin',
  'wait_end',
  'member_status',
] as const;

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];
export type RoomCapability = HumanCapability | AgentCapability;

const AGENT_CAPABILITY_SET = new Set<string>(AGENT_CAPABILITIES);

export function agentAllows(capability: RoomCapability): capability is AgentCapability {
  return AGENT_CAPABILITY_SET.has(capability);
}

export function assertAgentCapability(member: Member, capability: RoomCapability): void {
  if (member.kind !== 'agent') {
    throw new Error(`authorization principal ${member.id} is not an agent member`);
  }
  if (!agentAllows(capability)) {
    throw new Error(`forbidden: agent cannot ${capability.replaceAll('_', ' ')}`);
  }
}
// harn:end agent-network-authority-is-narrow
