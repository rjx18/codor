/**
 * Pure rules for configuring and spawning an agent.
 *
 * These live here, owned by web-next, rather than being imported from the legacy
 * UI: legacy is deleted in Phase 3, and the behaviour is worth keeping while the
 * markup is not. Everything below is a pure function so the dialogs can be thin
 * and the rules can be tested without rendering anything.
 *
 * Each rule exists because its absence produced a real defect — see the notes.
 */
import {
  DEFAULT_THINKING_LEVELS,
  PolicySchema,
  type Member,
  type Policy,
  type Room,
  type ThinkingLevel,
} from '@codor/protocol';

/** The subset of an adapter registration these rules need. */
export interface AdapterLike {
  id: string;
  capabilities: {
    thinking?: boolean;
    thinking_levels?: readonly ThinkingLevel[];
    resume?: boolean;
    /** What each policy ACTUALLY becomes on this harness. `null` means the harness
     *  does not distinguish it at all — the safety-critical case. */
    policies?: Partial<Record<Policy, string | null>>;
    approvals?: string;
  };
  models?: string[];
}

/** Handle length cap enforced by the protocol's member schema. */
export const HANDLE_MAX = 31;

/**
 * Native validation pattern for a handle.
 *
 * The hyphen is escaped deliberately. HTML compiles `pattern` with the `v` flag,
 * where a bare `-` in this position is a syntax error — and the spec says an
 * invalid pattern is *ignored*, so the field silently accepts anything. That is
 * how `NOPE!!` passed validation while looking guarded.
 */
export const HANDLE_PATTERN = '[a-z0-9][a-z0-9\\-]{1,30}';

/**
 * Policies come from the protocol, never from a literal in the UI.
 * An inlined list goes stale silently and starts offering values the server rejects.
 */
export const POLICIES: readonly Policy[] = PolicySchema.options;

/**
 * The safe default. A spawn must always carry a policy: omitting it lets the
 * harness fall back to whatever it likes, which is how an agent ends up with more
 * authority than the operator chose. Legacy carries a comment marking this exact
 * bug as a past regression ("F11: a channel-seeded agent used to spawn with NO
 * policy at all"); web-next reintroduced it.
 */
export const DEFAULT_POLICY: Policy = 'read-only';

/**
 * Thinking levels an adapter actually accepts.
 *
 * A harness that does not support thinking offers none — the control is then
 * disabled rather than hidden, so the absence is legible. A harness that supports
 * it but declares no explicit list falls back to the protocol's default trio.
 * The UI must never hardcode this: it had seven levels inlined while the protocol
 * default is three, so it was offering four the harness would reject.
 */
export function thinkingLevelsFor(adapter: AdapterLike | undefined): readonly ThinkingLevel[] {
  if (adapter === undefined || adapter.capabilities.thinking !== true) return [];
  const declared = adapter.capabilities.thinking_levels;
  return declared !== undefined && declared.length > 0 ? declared : DEFAULT_THINKING_LEVELS;
}

/**
 * The thinking level to actually send, or undefined.
 *
 * One place decides this, so spawn, channel-create and configure cannot disagree
 * about whether a level is acceptable — which is how a level the harness rejects
 * gets submitted from one dialog but not another.
 */
export function supportedThinking(
  adapter: AdapterLike | undefined,
  value: string,
): ThinkingLevel | undefined {
  const levels = thinkingLevelsFor(adapter);
  return levels.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : undefined;
}

const isAbsolute = (cwd: string | undefined): cwd is string =>
  cwd !== undefined && (cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\'));

/** A member whose cwd is worth inheriting: local, live, and actually present. */
function inheritable(member: Member): boolean {
  return member.kind === 'agent'
    && member.removed_ts === undefined
    && member.state !== 'dead'
    && member.state !== 'unreachable'
    && member.custody !== 'mirrored'
    && isAbsolute(member.cwd);
}

/**
 * Where a new agent should start, so the operator does not retype the project
 * path on every spawn: the room's own directory, else the room's starting agent's,
 * else the first live local agent's, else nothing.
 *
 * Dead, unreachable and mirrored agents are excluded deliberately — inheriting a
 * dead agent's directory is how you silently spawn into a stale worktree.
 */
export function defaultSpawnCwd(room: Room | undefined, members: readonly Member[]): string {
  if (isAbsolute(room?.config.cwd)) return room.config.cwd;

  const live = members.filter(inheritable).sort((a, b) => a.id.localeCompare(b.id));

  const startingHandle = room?.config.starting_agent_handle;
  if (startingHandle !== undefined) {
    const starting = live.find((member) => member.handle === startingHandle);
    if (starting?.cwd !== undefined) return starting.cwd;
  }
  return live[0]?.cwd ?? '';
}

/**
 * A handle nobody in the room is using, suffixed `-2`, `-3`… on collision.
 *
 * The base is truncated before the suffix is appended, never after: a 31-char
 * handle colliding twice must still fit, and trimming the suffix instead would
 * reintroduce the collision it exists to resolve.
 */
export function availableAgentHandle(base: string, members: readonly Member[]): string {
  const taken = new Set(
    members.filter((member) => member.removed_ts === undefined).map((member) => member.handle),
  );
  const seed = base.slice(0, HANDLE_MAX);
  if (!taken.has(seed)) return seed;

  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${String(n)}`;
    const candidate = seed.slice(0, HANDLE_MAX - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
  return seed;
}

/**
 * Narrow a stored policy string to the protocol's set.
 *
 * A member's persisted policy is typed loosely and may predate a protocol change,
 * so it is validated rather than cast: an unrecognised value becomes "no choice"
 * and the safe default applies, instead of being forwarded to the server.
 */
export function asPolicy(value: string | undefined): Policy | '' {
  const parsed = PolicySchema.safeParse(value);
  return parsed.success ? parsed.data : '';
}

/**
 * The channel owner.
 *
 * Identified by role, not by "the first human in the list": a channel can hold
 * several humans, and their order is not the ownership order, so the first-human
 * shortcut silently compares a new handle against the wrong person.
 */
export function channelOwner(members: readonly Member[]): Member | undefined {
  return members.find((member) => member.kind === 'human' && member.role === 'owner');
}

/** Does this handle collide with the channel owner's? */
export function collidesWithOwner(handle: string, owner: { handle: string } | undefined): boolean {
  return owner !== undefined && owner.handle === handle;
}

/**
 * One-click roles. Each fills handle, purpose, policy and thinking together,
 * because those four are what people actually vary between agents and setting
 * them one control at a time is the slow path through the common case.
 *
 * Policies stay conservative: only the tester runs anything, and nothing here
 * grants full access — that stays a deliberate, explicit choice.
 */
export interface SpawnPreset {
  id: string;
  label: string;
  blurb: string;
  handle: string;
  purpose: string;
  policy: Policy;
  thinking: string;
}

export const SPAWN_PRESETS: readonly SpawnPreset[] = [
  {
    id: 'coder', label: 'Coder', blurb: 'Writes and edits code',
    handle: 'coder', purpose: 'Implement the change we agree on, in small reviewable steps.',
    policy: 'workspace-write', thinking: 'medium',
  },
  {
    id: 'reviewer', label: 'Reviewer', blurb: 'Reads and critiques',
    handle: 'reviewer', purpose: 'Review the diff for correctness and risk. Do not edit files.',
    policy: 'read-only', thinking: 'high',
  },
  {
    id: 'planner', label: 'Planner', blurb: 'Breaks work down',
    handle: 'planner', purpose: 'Turn the goal into an ordered plan with checkable steps.',
    policy: 'read-only', thinking: 'high',
  },
  {
    id: 'writer', label: 'Writer', blurb: 'Docs and prose',
    handle: 'writer', purpose: 'Write and revise documentation for this project.',
    // low, matching legacy: prose does not need the deliberation budget code does.
    policy: 'workspace-write', thinking: 'low',
  },
  {
    id: 'tester', label: 'Tester', blurb: 'Runs and fixes tests',
    handle: 'tester', purpose: 'Run the suite, diagnose failures, and add missing coverage.',
    policy: 'workspace-write', thinking: 'medium',
  },
];

/**
 * Apply a preset over the current configuration.
 *
 * The thinking level is filtered through the adapter, so a preset asking for a
 * level this harness does not accept lands as "default" rather than silently
 * arming a value that would be rejected. The handle is made unique here too,
 * because two reviewers in one channel is a normal thing to want.
 */
export function applyPreset(input: {
  preset: SpawnPreset;
  config: AgentConfig;
  adapters: readonly AdapterLike[];
  members: readonly Member[];
}): { config: AgentConfig; handle: string; purpose: string } {
  const adapter = input.adapters.find((candidate) => candidate.id === input.config.harness);
  return {
    config: {
      ...input.config,
      policy: input.preset.policy,
      thinking: supportedThinking(adapter, input.preset.thinking) ?? '',
    },
    handle: availableAgentHandle(input.preset.handle, input.members),
    purpose: input.preset.purpose,
  };
}

export interface AgentConfig {
  harness: string;
  model: string;
  thinking: string;
  policy: Policy | '';
}

/**
 * Reconcile a configuration against the selected adapter.
 *
 * Changing harness clears the model, because model ids are harness-specific, and
 * clears a thinking level the new harness does not accept — leaving a stale level
 * selected means submitting one the harness rejects. Re-selecting the *same*
 * harness is a no-op, so a deliberately typed custom model survives.
 */
export function reconcileConfig(config: AgentConfig, nextHarness: string, adapters: readonly AdapterLike[]): AgentConfig {
  if (nextHarness === config.harness) return config;
  const adapter = adapters.find((candidate) => candidate.id === nextHarness);
  const levels = thinkingLevelsFor(adapter);
  const thinking = levels.includes(config.thinking as ThinkingLevel) ? config.thinking : '';
  return { ...config, harness: nextHarness, model: '', thinking };
}

/**
 * The harness actually in effect. Adapter discovery is asynchronous, so a
 * selection made before the list arrives — or one naming an adapter that has since
 * gone — heals to the first available rather than sticking at a dead value.
 */
export function effectiveHarness(selected: string, adapters: readonly AdapterLike[]): string {
  return adapters.some((adapter) => adapter.id === selected) ? selected : adapters[0]?.id ?? '';
}

/**
 * Does this room error belong to the spawn we are waiting on?
 *
 * The room error stream is shared, so "an error arrived" is not "my spawn
 * failed" — attributing any of them reports the wrong cause and abandons a
 * request that may still be in flight. But strict handle-matching is not enough
 * either: the protocol's own rejection for a reserved handle is the bare string
 * `handle is reserved`, which never names it. Matching only on the handle would
 * silently drop the most common failure the operator can actually cause.
 *
 * So: an error naming a DIFFERENT member is never ours; one naming ours always
 * is; and otherwise a spawn-shaped error arriving while our spawn is the only
 * one pending is taken as ours. Anything else stays pending until the timeout,
 * which reports uncertainty rather than inventing a cause.
 */
const SPAWN_SHAPED = /\b(handle|spawn|harness|agent|reserved)\b/i;

export function errorMentionsHandle(message: string, handle: string): boolean {
  if (handle === '') return false;
  // Word-ish boundary: `scout` must not match `scout-2`, and quoting varies.
  return new RegExp(
    `(^|[^a-z0-9-])${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9-]|$)`,
    'i',
  ).test(message);
}

export function errorConcernsSpawn(message: string, handle: string): boolean {
  if (errorMentionsHandle(message, handle)) return true;
  // Names someone else explicitly -> theirs, not ours.
  const other = /@([a-z0-9][a-z0-9-]*)/i.exec(message)?.[1];
  if (other !== undefined && other.toLowerCase() !== handle.toLowerCase()) return false;
  return SPAWN_SHAPED.test(message);
}

/**
 * What a pending spawn should do next, given everything currently known.
 *
 * Extracted as a pure function so every branch is testable without racing a live
 * daemon: "an unrelated member arrived", "an unrelated error arrived" and "our
 * error arrived" are three different outcomes, and a browser test cannot inject
 * them deterministically. The dialog just renders this decision.
 */
export type SpawnResolution =
  | { state: 'pending' }
  | { state: 'arrived' }
  | { state: 'failed'; message: string };

export function resolveSpawn(input: {
  handle: string;
  members: readonly Member[];
  freshErrors: readonly string[];
}): SpawnResolution {
  // Success is OUR handle appearing. "Membership changed" would report success
  // when any unrelated agent joined — a false success, worse than the silent
  // failure it replaced.
  const arrived = input.members.some(
    (member) => member.handle === input.handle && member.removed_ts === undefined,
  );
  if (arrived) return { state: 'arrived' };

  const mine = input.freshErrors.filter((message) => errorConcernsSpawn(message, input.handle));
  const last = mine.at(-1);
  return last === undefined ? { state: 'pending' } : { state: 'failed', message: last };
}

/**
 * Does this server failure belong beside the agent-name field?
 *
 * Legacy routes handle/starting-agent errors to the field that caused them and
 * everything else to the form. A single bottom banner makes a field-specific
 * error read as unrelated to the field, which is how people retry the same
 * value twice.
 */
export function isAgentFieldError(message: string): boolean {
  return /starting agent|handle/i.test(message);
}

export interface SpawnSpec {
  harness: string;
  handle: string;
  cwd: string;
  policy: Policy;
  model?: string;
  thinking?: ThinkingLevel;
  purpose?: string;
}

/**
 * Build the wire payload.
 *
 * `policy` is always present, defaulting to read-only. `thinking` is omitted
 * entirely unless the chosen adapter reports support *and* the level is one it
 * accepts — sending a level to a harness that cannot use it is at best ignored and
 * at worst an error the operator never sees.
 */
export function buildSpawnSpec(input: {
  config: AgentConfig;
  handle: string;
  cwd: string;
  purpose?: string;
  adapters: readonly AdapterLike[];
  members: readonly Member[];
}): SpawnSpec {
  const harness = effectiveHarness(input.config.harness, input.adapters);
  const adapter = input.adapters.find((candidate) => candidate.id === harness);
  const thinking = supportedThinking(adapter, input.config.thinking);
  const purpose = input.purpose?.trim();

  return {
    harness,
    handle: availableAgentHandle(input.handle.trim(), input.members),
    cwd: input.cwd.trim(),
    policy: input.config.policy === '' ? DEFAULT_POLICY : input.config.policy,
    ...(input.config.model !== '' && { model: input.config.model }),
    ...(thinking !== undefined && { thinking }),
    ...(purpose !== undefined && purpose !== '' && { purpose }),
  };
}
