# Manual adapter verification

Live probes are intentionally single-shot and tiny. Do not retry an auth,
quota, or subscription failure.

## Gemini CLI

Status on 2026-07-10: **not run**. The `gemini` executable is not installed and
this machine has no authenticated Gemini CLI account. Checked-in fixtures are
marked SYNTHETIC and prove parser conformance only.

With an operator-authenticated first-party CLI, run once from a disposable
directory:

```bash
gemini --output-format stream-json --model gemini-2.5-flash --approval-mode plan --prompt 'Reply PONG only.'
gemini --output-format stream-json --model gemini-2.5-flash --approval-mode plan --resume <init.session_id> --prompt 'Repeat your previous word only.'
gemini --list-sessions
```

Verify that both results are `PONG`, the resumed `init.session_id` is unchanged,
the UUID appears in `--list-sessions` and the project chat metadata, and the
event fields still match `packages/adapters/gemini/NOTES.md`. Stop after the
first auth/quota error and record it instead of retrying.

## GitHub Copilot CLI

Status on 2026-07-10: **not run**. The `copilot` executable is not installed and
this machine has no authenticated Copilot CLI subscription. Checked-in fixtures
are marked SYNTHETIC and prove parser conformance only.

With an operator-authenticated first-party CLI, choose a new UUID and run each
tiny turn once from a disposable directory:

```bash
copilot --output-format=json --stream=on --no-ask-user --no-color --model=gpt-5.4-mini --session-id <uuid> --prompt 'Reply PONG only.'
copilot --output-format=json --stream=on --no-ask-user --no-color --model=gpt-5.4-mini --session-id <same-uuid> --prompt 'Repeat your previous word only.'
copilot --resume <same-uuid>
```

Verify that both programmatic results are `PONG`, the JSONL envelopes and fields
still match `packages/adapters/copilot/NOTES.md`, the UUID directory exists under
`$COPILOT_HOME/session-state`, and the final command opens the same interactive
session. Stop after the first auth/quota/subscription error and record it instead
of retrying. A separate future authenticated subagent probe should verify that
`subagent.started` and its matching terminal event are present before relying on
extension visibility outside the documented synthetic fixture.
