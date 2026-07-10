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

## Cross-machine Hyperswarm DHT

Status on 2026-07-10: **not run**, by M2 operator directive. Automated acceptance proves two
localhost switchboards on the real public DHT; this step checks actual NAT and routing between
two physical machines over the internet.

1. Build the same commit on a home machine and an outpost machine, each with a fresh private
   data directory. Enroll their switchboard identities in both directions through
   `CryptoVault.pairing.complete/accept`; confirm each `device_id` appears in the other peer
   store.
2. Choose one high-entropy `name:secret` line out of band. On the home, launch the exported
   `HyperswarmTransport`, `ResidencyCoordinator`, `LedgerManager`, and `Daemon` with that line,
   a home room, and a remote FakeAdapter member whose `host` is the outpost `device_id`. On the
   outpost, launch `HyperswarmTransport` plus a resident `ResidencyCoordinator` configured with
   `FakeAdapter`; use the construction in `m2-acceptance.spec.ts` as the operator wrapper. Do
   not set a bootstrap override; both sides must use the real DHT.
3. Post one unique plaintext marker from the home to the remote member and verify the outpost
   FakeAdapter returns its deterministic body, the home finalizes exactly one run with dense
   room ids, and no room database or ledger vault appears on the outpost.
4. Capture the connection on either host with the operator's packet tool and search raw packet
   bytes for the marker and ledger body. Both searches must return zero matches; record only
   the result, never the line secret or private keys.
5. Run `wireroom revoke <outpost-device-id>` against the home data directory. Verify the live
   connection drops, the resident member becomes `unreachable`, reconnect authentication is
   rejected, and a newly posted delivery remains queued at the home.

The production home-side line launcher and friendlier peer-enrollment UX are documentation and
packaging work for M5; this M2 verification uses the already exported switchboard APIs, matching
the automated acceptance topology exactly.
