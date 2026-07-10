# Harness adapters

Wireroom adapters translate one harness's ordinary CLI stream into the open protocol. They do
not call a model SDK, provider HTTP API, or private switchboard API. A registered adapter gets
the same routing, persistence, run journal, interaction, and crash handling as every built-in.

> Configured adapter modules are trusted local code. Loading one gives it the privileges of the
> switchboard process, including access to its environment and filesystem. Review the module and
> pin its package version or file contents before registering it.

## Runtime contract

<!-- harn:assume adapter-registry-sole-harness-source ref=adapter-registration-contract -->

Implement the `HarnessAdapter` exported by `@wireroom/protocol`:

```ts
interface HarnessAdapter {
  id: string;
  capabilities: {
    resume: boolean;
    discover: boolean;
    interactiveAttach: boolean;
    ask: boolean;
    approvals: 'runtime' | 'spawn-time';
    extensions: boolean;
  };
  spawn(options: { cwd: string; model?: string; policy?: string }): Session;
  attach(sessionRef: string): Session;
  deliver(session: Session, payload: string, hooks?: AdapterTurnHooks): AsyncIterable<WireEvent>;
  respondInteraction(session: Session, interactionId: string, answer: unknown): Promise<void>;
  interrupt(session: Session): void;
  discoverSessions(): string[];
}
```

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
import type { HarnessAdapter } from '@wireroom/protocol';

export function createAdapter({ id }: { id: string }): HarnessAdapter {
  return new MyHarnessAdapter(id);
}
```

Register a local file or installed package when starting programmatically:

```ts
await startWireroom({
  token: process.env.WIREROOM_TOKEN!,
  adapters: {
    'my-harness': './adapters/my-harness.mjs',
    acp: '@example/wireroom-acp-adapter',
  },
});
```

Or repeat the CLI option:

```sh
wireroom up \
  --adapter my-harness=./adapters/my-harness.mjs \
  --adapter acp=@example/wireroom-acp-adapter
```

Relative paths resolve from the process working directory; absolute paths, `file:` URLs, and
Node package specifiers are accepted. The registry imports and validates every configured
factory before opening switchboard databases, crypto stores, transports, or listeners. A
configured id equal to a built-in id deliberately replaces that built-in for this process.
Every start builds fresh adapter instances. Registration and replacement take effect on restart;
Wireroom never swaps a live session between adapter objects.

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
enter Wireroom. Prefer first-party CLI documentation and direct probes.

## Fixture recording

Capture the smallest real CLI turns that establish each wire shape. Keep raw scrubbed JSONL and,
where the harness has an interactive control channel, the paired stdin frames. Replace secrets,
usernames, and machine paths without changing structure or ordering. Never hand-edit a fixture to
make an adapter test pass after contract drift: re-probe the current CLI, update `NOTES.md`, and
record the new capture. Mark synthetic crash or malformed-input fixtures explicitly.

Live probes stay opt-in behind the repository's credential guards. Deterministic tests replay
fixtures and must cover success, resume, missing executable, malformed lines, nonzero exit,
truncated EOF, interruption, and every advertised interaction capability. The hot-swap acceptance
also loads an external test module and completes a normal routed room turn, while a source guard
keeps all built-in package imports in the sole registry.

<!-- harn:end adapter-registry-sole-harness-source -->
