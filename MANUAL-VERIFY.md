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
