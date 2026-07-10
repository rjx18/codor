# SYNTHETIC fixtures

These files were synthesized from Google's documented Gemini CLI `stream-json`
event types and the Apache-2.0 first-party event interfaces. They are not live
captures and contain no model output obtained from an authenticated account.

- `synthetic-success.jsonl` covers init, user/assistant messages, a tool call,
  its result, and successful token statistics.
- `synthetic-failure.jsonl` covers a non-fatal error event followed by a failed
  result.

See `../NOTES.md` and the repository-root `MANUAL-VERIFY.md` for sources and the
deferred authenticated probe.
