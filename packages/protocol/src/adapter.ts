import type { WireEvent } from './events.js';

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
}

export interface SpawnOpts {
  cwd: string;
  model?: string;
  policy?: string;
}

export interface AdapterCapabilities {
  resume: boolean; // false ⇒ one-shot ephemeral members only
  discover: boolean; // can enumerate the harness session store
  interactiveAttach: boolean; // native TUI resume exists (jump-in)
  ask: boolean; // raises ask.raised cards
  approvals: 'runtime' | 'spawn-time';
  extensions: boolean; // reports subagents (extension.*)
}

/** Durable lifecycle facts reported while a turn is still in progress. */
export interface AdapterTurnHooks {
  /** Called only after the CLI child has emitted its spawn event. */
  onStarted?(process: { pid?: number; process_group_id?: number }): void;
  /** Called as soon as stdout reveals the harness-native resume token. */
  onSessionRef?(session_ref: SessionRef): void;
}

/**
 * Adapters drive plain CLIs, never SDKs (ARCHITECTURE §adapters): spawn a
 * subprocess, write JSONL, read JSONL. One deliver() call = one turn.
 */
export interface HarnessAdapter {
  id: string; // 'claude-code' | 'codex' | …
  capabilities: AdapterCapabilities;
  spawn(opts: SpawnOpts): Session;
  attach(session_ref: SessionRef): Session;
  // harn:assume attempt-start-evidence-persisted ref=adapter-turn-hooks
  deliver(session: Session, payload: string, hooks?: AdapterTurnHooks): AsyncIterable<WireEvent>;
  // harn:end attempt-start-evidence-persisted
  /** Resolves on adapter acknowledgement (the interaction is truly answered). */
  respondInteraction(session: Session, interaction_id: string, answer: unknown): Promise<void>;
  interrupt(session: Session): void;
  discoverSessions(): SessionRef[];
}
