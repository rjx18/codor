# SYNTHETIC fixtures

These files were synthesized from the `cursor-agent --output-format stream-json`
event vocabulary documented in `../NOTES.md`. They mirror the shape of real CLI
output but are not live captures and contain no model output obtained from an
authenticated account.

- `synthetic-success.jsonl` covers `system/init`, a user echo, a thinking delta,
  a tool call and its result, streaming assistant deltas (with the trailing
  cumulative echo that must be skipped), and a successful token-only result.
- `synthetic-failure.jsonl` covers an errored terminal result.

See `../NOTES.md` and the repository-root `MANUAL-VERIFY.md` for sources and the
deferred authenticated probe.
