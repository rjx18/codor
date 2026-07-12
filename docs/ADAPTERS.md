# Harness adapters

Codor adapters translate one harness's ordinary CLI stream into the open protocol. They do
not call a model SDK, provider HTTP API, or private switchboard API. A registered adapter gets
the same routing, persistence, run journal, interaction, and crash handling as every built-in.

> Configured adapter modules are trusted local code. Loading one gives it the privileges of the
> switchboard process, including access to its environment and filesystem. Review the module and
> pin its package version or file contents before registering it.

## Runtime contract

<!-- harn:assume adapter-registry-sole-harness-source ref=adapter-registration-contract -->

Implement the `HarnessAdapter` exported by `@codor/protocol`:

<!-- harn:assume the-adapter-doc-is-the-contract-it-enforces ref=published-adapter-contract -->

```ts
type Policy = 'read-only' | 'workspace-write' | 'full-access';
type ThinkingLevel = 'low' | 'medium' | 'high';

interface HarnessAdapter {
  id: string;
  capabilities: {
    resume: boolean;
    discover: boolean;
    interactiveAttach: boolean;
    ask: boolean;
    approvals: 'runtime' | 'spawn-time';
    extensions: boolean;
    thinking: boolean;
    policies: Record<Policy, string | null>;
    /** Optional. Can this harness deliver a message INTO a turn already running? */
    live_inbox?: boolean;
  };
  spawn(options: {
    cwd: string;
    model?: string;
    policy?: Policy;
    thinking?: ThinkingLevel;
  }): Session;
  attach(sessionRef: string): Session;
  /** Optional. The models this harness accepts; omit when it cannot say. */
  listModels?(): Promise<{ models: string[]; source: 'discovered' | 'curated' }>;
  deliver(session: Session, payload: string, hooks?: AdapterTurnHooks): AsyncIterable<WireEvent>;
  respondInteraction(session: Session, interactionId: string, answer: unknown): Promise<void>;
  interrupt(session: Session): void;
  discoverSessions(): string[];
}
```

**Every field above is required, and the registry refuses an adapter that omits one.**
`thinking` says whether the harness takes a reasoning-effort setting at all; a spawn that
asks for one from a harness that declares `false` is rejected rather than quietly ignored.

### `policies` — declare what each permission tier actually becomes

Codor has exactly three permission tiers. Your adapter declares what each one BECOMES for
your harness: the native mode it maps to, or `null` when your harness does not distinguish
that tier at all.

```ts
// claude-code: all three tiers are distinct native modes.
policies: {
  'read-only': 'plan',
  'workspace-write': 'acceptEdits',
  'full-access': 'bypassPermissions',
}

// opencode: only the top tier emits a flag. The other two build IDENTICAL arguments,
// so this harness is not being told to restrict anything — its own configured rules
// apply. `null` says exactly that.
policies: {
  'read-only': null,
  'workspace-write': null,
  'full-access': '--auto',
}
```

`null` is not "unknown" and not "unsupported" — it is the harness stating plainly that the
operator's choice of that tier changes nothing about what the agent may do. The web surfaces
read this declaration to tell the operator the truth: a tier declared `null` is shown as *not
enforced*, and choosing it raises a warning rather than implying a guarantee nobody is making.

**The declaration must match the arguments you actually build.** A `policies` entry that
disagrees with your own argv is a lie the UI will faithfully repeat to the operator about what
an agent may do to their machine. Every first-party adapter is held to this by a test that
compares its declaration against the arguments it emits; hold yours to the same.

<!-- harn:end the-adapter-doc-is-the-contract-it-enforces -->

<!-- harn:assume a-session-carries-the-environment-its-children-need ref=adapter-env-contract-doc -->
### `session.env` — you MUST merge it over the inherited environment

A `Session` may carry an environment:

```ts
interface Session {
  harness: string;
  session_ref?: string;
  cwd: string;
  model?: string;
  policy?: Policy;
  thinking?: ThinkingLevel;
  /** Merge OVER the inherited process env for every child spawned for this session. */
  env?: Record<string, string>;
}
```

**Every child you spawn for a session must be spawned with `{ ...process.env, ...session.env }`.**
Not instead of the inherited environment — *over* it.

This is how a harness's subprocess finds the switchboard it belongs to. The switchboard puts
the socket path, the channel, the member identity and that member's credential in here; an
agent that cannot read them cannot address the switchboard from inside its own turn, and so
cannot post an interim update, take a message off its own queue, or say that it is waiting on
someone. An adapter that drops `session.env` does not fail loudly — it produces an agent that
is simply deaf, which is worse.

```ts
const child = spawn(this.command, args, {
  cwd: session.cwd,
  env: { ...process.env, ...session.env },   // ← required
  stdio: ['pipe', 'pipe', 'pipe'],
});
```

`session.env` never contains anything the operator has not already granted this member. Treat
its values as secret: do not log them, and do not echo them into run evidence.
<!-- harn:end a-session-carries-the-environment-its-children-need -->

`spawn()` creates an in-memory session handle; it does not need to launch the harness yet. One
`deliver()` call is one turn. Launch the CLI as a supervised subprocess there, call
`hooks.onStarted` only after spawn succeeds, and call `hooks.onSessionRef` as soon as stdout
reveals the durable harness session id. The iterable must finish with exactly one
`run.completed` event for an ordinary completed, failed, or interrupted turn. EOF without a
terminal event is treated as ambiguous interruption and reconciled by the switchboard.

`respondInteraction()` resolves only after the harness acknowledges the answer. `interrupt()`
must signal the whole process group, not just an npm or shell shim. Bound captured stderr; observe
spawn errors, nonzero exits, close, and stream EOF. Capabilities are promises to the UI and
router: set a capability false when the CLI cannot prove it. In particular, `resume: false`
makes members one-shot, and `interactiveAttach: false` prevents a misleading jump-in action.

## Module registration

A configured ESM module exports one factory. The configuration key is the adapter id and must
match the returned `adapter.id`:

```ts
import type { HarnessAdapter } from '@codor/protocol';

export function createAdapter({ id }: { id: string }): HarnessAdapter {
  return new MyHarnessAdapter(id);
}
```

Register a local file or installed package when starting programmatically:

```ts
await startCodor({
  token: process.env.CODOR_TOKEN!,
  adapters: {
    'my-harness': './adapters/my-harness.mjs',
    acp: '@example/codor-acp-adapter',
  },
});
```

Or repeat the CLI option:

```sh
codor up \
  --adapter my-harness=./adapters/my-harness.mjs \
  --adapter acp=@example/codor-acp-adapter
```

Filesystem paths use Node's explicit forms: start them with `./` or `../` to resolve from the
process working directory, or pass an absolute path or `file:` URL. Values without a dot prefix
are Node package specifiers, including package subpaths. The registry imports and validates
every configured factory before opening switchboard databases, crypto stores, transports, or
listeners. A configured id equal to a built-in id deliberately replaces that built-in for this process.
Every start builds fresh adapter instances. Registration and replacement take effect on restart;
Codor never swaps a live session between adapter objects.

## Behavioral specification

Every adapter keeps `packages/adapters/<harness>/NOTES.md` (or the equivalent in an external
package) beside its implementation. Record:

- harness version, probe date, and first-party documentation sources;
- exact new-turn and resume argv, stdin behavior, cwd, model, and policy mapping;
- native session store and discovery rules;
- stdout/stderr event vocabulary and its `WireEvent` mapping;
- ask, approval, extension, usage, and cost evidence;
- spawn, crash, EOF, signal, interrupt, and process-group behavior;
- any interactive attach or mirrored-session integration; and
- the final capability object, with evidence for each true value.

Paseo and similar projects may inform behavioral research, but their AGPL code and assets do not
enter Codor. Prefer first-party CLI documentation and direct probes.

## Fixture recording

Capture the smallest real CLI turns that establish each wire shape. Keep raw scrubbed JSONL and,
where the harness has an interactive control channel, the paired stdin frames. Replace secrets,
usernames, and machine paths without changing structure or ordering. Never hand-edit a fixture to
make an adapter test pass after contract drift: re-probe the current CLI, update `NOTES.md`, and
record the new capture. Mark synthetic crash or malformed-input fixtures explicitly.

Live probes stay opt-in behind the repository's credential guards. Deterministic tests replay
fixtures and must cover success, resume, missing executable, malformed lines, nonzero exit,
truncated EOF, interruption, and every advertised interaction capability. The hot-swap acceptance
also loads an external test module and completes a normal routed channel turn, while a source guard
keeps all built-in package imports in the sole registry.

<!-- harn:end adapter-registry-sole-harness-source -->
