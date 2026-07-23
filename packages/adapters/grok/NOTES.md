# Grok CLI adapter

This adapter drives xAI's official `grok` CLI in headless mode. The behavioral
specification is based on the xAI CLI documentation checked on 2026-07-23:

- <https://docs.x.ai/build/cli/headless-scripting>
- <https://docs.x.ai/build/cli/reference>
- <https://docs.x.ai/developers/models>
- <https://docs.x.ai/developers/model-capabilities/text/reasoning>

## Invocation

```text
grok -p PAYLOAD --output-format streaming-json --no-auto-update
grok -p PAYLOAD --output-format streaming-json --no-auto-update --resume SESSION_ID
```

The adapter adds `--model MODEL`, `--effort low|medium|high`, and
`--always-approve` for the corresponding Codor controls. The child runs with
the member working directory and merged member environment; stdin is unused.

## Lifecycle and capabilities

Grok stores headless sessions under `~/.grok/sessions`. The CLI creates and
reports a session id for new members, resumes by id, and the adapter discovers
UUID-named session entries in that directory. Interactive attach uses the documented native
`grok --resume ID` flow.

The headless stream has no documented response channel for ask cards or runtime
approval answers, so `ask:false` and `approvals:'spawn-time'` are intentional.
Subagent and live-inbox events are not advertised until a first-party stream
capture establishes them.

The CLI documents `--always-approve`, but does not document native mappings for
read-only or workspace-write. Those policy entries are therefore `null`, while
full-access is represented by `--always-approve`; the UI will show the two
non-enforced tiers honestly.

## Privacy note

Grok is a cloud coding agent. Review xAI's current data, privacy, and codebase
upload settings before enabling it for sensitive repositories. Codor does not
intercept or redact provider traffic.

The checked-in translator accepts the documented Responses-style streaming event
names and the common CLI aliases used by current builds. A scrubbed live capture
should be added before advertising additional tool, subagent, or usage behavior.
