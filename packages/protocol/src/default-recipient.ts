import type { Member } from './member.js';

export interface EffectiveDefaultAgentContext {
  members: readonly Member[];
  latestFinalizedAgentId?: string;
  startingAgentHandle?: string;
}

const activeAgent = (member: Member): boolean =>
  member.kind === 'agent' && member.removed_ts === undefined;

const liveAgent = (member: Member): boolean =>
  activeAgent(member) && member.state !== 'dead';

// harn:assume default-recipient-fallback-chain ref=effective-default-agent
export function effectiveDefaultAgent(
  context: EffectiveDefaultAgentContext,
): Member | undefined {
  if (context.latestFinalizedAgentId !== undefined) {
    const latest = context.members.find(
      (member) => member.id === context.latestFinalizedAgentId && activeAgent(member),
    );
    if (latest) return latest;
  }

  const live = context.members.filter(liveAgent);
  if (context.startingAgentHandle !== undefined) {
    const starting = live.find((member) => member.handle === context.startingAgentHandle);
    if (starting) return starting;
  }
  return live.length === 1 ? live[0] : undefined;
}
// harn:end default-recipient-fallback-chain
