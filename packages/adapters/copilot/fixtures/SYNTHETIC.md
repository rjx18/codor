# SYNTHETIC fixtures

These JSONL files were synthesized from GitHub's documented Copilot session
event envelope and field-level streaming event reference. They are not live
captures and contain no output obtained from an authenticated Copilot account.

- `synthetic-success.jsonl` covers assistant deltas plus their complete-message
  echo, tool lifecycle, token usage with a non-USD billing multiplier, subagent
  lifecycle, and idle completion.
- `synthetic-failure.jsonl` covers a documented session error.

See `../NOTES.md` and the repository-root `MANUAL-VERIFY.md` for sources and the
deferred authenticated checks.
