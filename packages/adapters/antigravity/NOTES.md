# Antigravity (`agy`) adapter — behavioral evidence

These notes record the contributor's `agy` CLI probe supplied with PR #3. The
maintainer reconstruction did not have an authenticated `agy` installation, so
the adapter is fixture-verified against this captured surface rather than
claimed as live-provider verified.

## CLI surface

- `--print <prompt>` runs one prompt non-interactively and emits plain assistant
  text; there is no structured output format.
- `--model <display name>` accepts names reported by `agy models`.
- `--mode <accept-edits|plan>` selects execution behavior;
  `--dangerously-skip-permissions` auto-approves tool permissions.
- `--conversation <id>` resumes a prior conversation.
- `--add-dir`, `--log-file`, and `--print-timeout` configure the workspace,
  verbose log, and print-mode ceiling.

The adapter sets a 30-minute print ceiling and leaves real interruption to the
switchboard's supervised child lifecycle.

<!-- harn:assume adapters-own-their-model-catalog ref=antigravity-model-catalog-notes -->
## Model catalog

The probe reported human-facing names such as `Gemini 3.5 Flash (High)`.
`listModels()` runs `agy models` locally with a fixed argv and timeout, reports
slug-safe ids to Codor, and owns the reverse mapping back to display names at
spawn time. The catalog is never hard-coded here. If two names collapse to the
same slug, discovery fails rather than routing an operator selection to the
wrong model.
<!-- harn:end adapters-own-their-model-catalog -->

## Resume boundary

Print stdout does not expose a conversation id. The probe's verbose log did:

```text
I0719 ... Stream goroutine exited for 1f935c68-016d-4cbb-a740-56e90ab75630, sending completion signal
```

The adapter reads only the current turn's temporary log after the child closes,
uses the last matching UUID, and removes the file on all paths. Recovery is
best-effort: if the log shape changes or is absent, the next turn starts fresh.

## Capabilities

- resume: best-effort from the log; discovery and interactive attach: absent
- thinking: absent (effort is encoded in agy's model display name)
- read-only: `--mode plan`
- workspace-write: `--mode accept-edits`
- full-access: `--mode accept-edits --dangerously-skip-permissions`
- token usage: not reported by the observed print or log surface
