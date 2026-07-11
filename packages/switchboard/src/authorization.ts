import type { Act, Member, Role } from '@wireroom/protocol';

export type HumanCapability =
  | 'read'
  | 'post'
  | Act['act']
  | 'mirror_turn'
  | 'mirror_session_end'
  | 'manage_ledger'
  | 'enable_bridge'
  | 'manage_keys'
  | 'manage_devices'
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
  rename: 'admin',
  revive: 'admin',
  kill: 'admin',
  pause: 'admin',
  unpause: 'admin',
  interrupt: 'admin',
  mirror_turn: 'admin',
  mirror_session_end: 'admin',
  manage_ledger: 'admin',
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
