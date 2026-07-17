import { z } from 'zod';

import type { WireEvent } from './events.js';
import type { AgentLimit } from './member.js';

// harn:assume canonical-spawn-controls-enforced ref=canonical-policy-thinking-enforcement
export const PolicySchema = z.enum(['read-only', 'workspace-write', 'full-access']);
export type Policy = z.infer<typeof PolicySchema>;

// harn:assume harness-declares-supported-thinking-levels ref=adapter-thinking-level-contract
/** Legacy choices for thinking-capable third-party adapters without an exact declaration. */
export const DEFAULT_THINKING_LEVELS = ['low', 'medium', 'high'] as const;
export const ThinkingLevelSchema = z.enum([
  ...DEFAULT_THINKING_LEVELS,
  'xhigh',
  'max',
  'ultra',
  'ultracode',
]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

/** Harness-native session/rollout id — the resume token and identity anchor. */
export type SessionRef = string;

/**
 * A live handle on a harness session. Adapters may carry more state
 * internally; this is the shape the switchboard sees. `session_ref` is
 * undefined only between `spawn()` and the harness first reporting its id
 * (claude: `system/init.session_id`; codex: `thread.started.thread_id`).
 */
export interface Session {
  harness: string;
  session_ref?: SessionRef;
  cwd: string;
  model?: string;
  policy?: string;
  thinking?: ThinkingLevel;
  // harn:assume a-session-carries-the-environment-its-children-need ref=session-env-contract
  // Environment for the children spawned under this session. Adapters MUST merge it OVER
  // the inherited process env for every child they spawn for the session.
  //
  // A harness's subprocess cannot reach the switchboard it belongs to unless it is told
  // where the socket is, which channel it is in, and who it speaks as. Today no adapter
  // passes an env at all — all five inherit the daemon's verbatim — so an agent has no way
  // to address the switchboard from inside its own turn. Everything live-collab does rests
  // on this.
  env?: Record<string, string>;
  // harn:end a-session-carries-the-environment-its-children-need
}

export interface SpawnOpts {
  cwd: string;
  model?: string;
  policy?: string;
  thinking?: ThinkingLevel;
}

export interface AdapterCapabilities {
  resume: boolean; // false ⇒ one-shot ephemeral members only
  discover: boolean; // can enumerate the harness session store
  interactiveAttach: boolean; // native TUI resume exists (jump-in)
  ask: boolean; // raises ask.raised cards
  approvals: 'runtime' | 'spawn-time';
  extensions: boolean; // reports subagents (extension.*)
  thinking: boolean;
  /** Exact accepted values. Absent preserves low/medium/high for older adapters. */
  thinking_levels?: readonly ThinkingLevel[];
  // harn:end harness-declares-supported-thinking-levels
  // harn:assume harness-declares-what-a-policy-becomes ref=adapter-policy-capability
  // What each canonical policy ACTUALLY becomes for this harness — the native mode it
  // maps to, or null where the harness does not distinguish it at all.
  //
  // Null is the safety-critical value. copilot and opencode emit a flag only for
  // full-access, so read-only and workspace-write build identical arguments there:
  // BOTH defer to whatever rules that harness is configured with. Telling an operator
  // their agent is read-only when the harness was never told so is a lie about what it
  // may do to their machine — so the harness declares this, and every surface reads it
  // rather than hardcoding what it thinks it knows.
  policies: Record<Policy, string | null>;
  // harn:end harness-declares-what-a-policy-becomes
  // harn:assume a-session-carries-the-environment-its-children-need ref=live-inbox-capability
  // Whether this harness can deliver a message INTO a turn that is already running —
  // rather than only between turns. OPTIONAL, and absent means no: the adapters that
  // implement it declare it in the phase that builds it, so no adapter — first-party or
  // third-party — stops registering today.
  live_inbox?: boolean;
  // harn:end a-session-carries-the-environment-its-children-need
}
// harn:end canonical-spawn-controls-enforced

/** Durable lifecycle facts reported while a turn is still in progress. */
// harn:assume adapters-own-their-model-catalog ref=adapter-model-catalog-contract
/**
 * The models a harness will accept. `discovered` means the adapter asked the
 * harness itself (its own listing command, run locally, zero spend); `curated`
 * means the CLI offers no listing command, so the ids are cited in that
 * adapter's NOTES.md. Model ids churn — the web must never hardcode one.
 */
export interface ModelCatalog {
  models: string[];
  source: 'discovered' | 'curated';
}
// harn:end adapters-own-their-model-catalog

export interface AdapterTurnHooks {
  /** Called after the adapter runtime accepts the turn; a retained provider process may repeat its pid. */
  onStarted?(process: { pid?: number; process_group_id?: number }): void;
  /** Called as soon as provider output or an RPC response reveals the native resume token. */
  onSessionRef?(session_ref: SessionRef): void;
}

// harn:assume claude-agent-sdk-query-is-the-session-runtime ref=adapter-runtime-contract
/**
 * Adapters normalize one harness turn at a time. A driver may supervise a
 * per-turn CLI subprocess or retain a provider-owned streaming runtime across
 * deliver() calls; either way one deliver() call still yields exactly one turn.
 */
export interface HarnessAdapter {
  id: string; // 'claude-code' | 'codex' | …
  capabilities: AdapterCapabilities;
  spawn(opts: SpawnOpts): Session;
  attach(session_ref: SessionRef): Session;
  /**
   * The models this harness accepts. Omitted when the harness cannot say.
   * Never called on a request path — the daemon discovers in the background.
   */
  listModels?(): Promise<ModelCatalog>;
  /** Account-level rate-limit windows reported by the harness provider. */
  probeLimits?(): Promise<AgentLimit[] | undefined>;
  // harn:assume attempt-start-evidence-persisted ref=adapter-turn-hooks
  deliver(session: Session, payload: string, hooks?: AdapterTurnHooks): AsyncIterable<WireEvent>;
  // harn:end attempt-start-evidence-persisted
  /** Resolves on adapter acknowledgement (the interaction is truly answered). */
  respondInteraction(session: Session, interaction_id: string, answer: unknown): Promise<void>;
  interrupt(session: Session): void;
  discoverSessions(): SessionRef[];
}
// harn:end claude-agent-sdk-query-is-the-session-runtime
