# Manual adapter verification

Live probes are intentionally single-shot and tiny. Do not retry an auth,
quota, or subscription failure.

## Final operator release checklist

1. Create the final GitHub repository privately, add it as this checkout's `origin`, and verify the
   complete history contains no credentials, pairing URLs, DHT line secrets, bridge tokens, VAPID
   private keys, browser subscriptions, or local data directories. Do not make it public yet.
2. Confirm the completed full-repository Codex review and its
   `final-repository-review-fixes` Harn fold remain in the candidate history. Run the review again
   if any later code commit lands; no unreviewed code may precede the 0.1.0 tag.
3. Inspect current first-party output, harden the acceptance fixtures without weakening their
   routing contracts, and run the M0 and M1 live acceptances once on the pinned cheap models. Both
   exact chains must pass before tagging 0.1.0; another extra or missing route blocks publication.
4. After all folds, run `pnpm test:all`, `pnpm audit:license`, `pnpm audit:release`, and
   `scripts/fresh-install-test.sh` on the exact candidate commit. Every deterministic gate and the
   clean-clone proof must pass.
5. Push the reviewed `main` commit, enable branch protection and secret scanning, make the repository
   public, then create the signed `v0.1.0` tag and GitHub release from `CHANGELOG.md`. Do not publish
   any workspace to npm; the distribution is the source checkout and every package remains `private`.
6. Build the public documentation with the real remote URL:
   `CODOR_REPOSITORY_URL=https://github.com/<owner>/<repo> pnpm --filter @codor/website build`.
   Deploy only `website/.vitepress/dist/`, then verify Source, GitHub, and edit links point to the
   final repository and every documentation route loads over HTTPS.
7. On a clean Linux or macOS host, follow `docs/SELF-HOST.md` without using this development
   worktree. Confirm the user-systemd unit uses the host's absolute Node path, survives logout or
   reboot when linger is enabled, stops cleanly, and restores from one encrypted stopped backup.
8. Configure Tailscale Serve on a disposable tailnet host and pair one remote browser through its
   HTTPS origin. Use the app connector only if a team already operates the required public domain,
   stable Linux connector, policy tags, route approval, and origin restrictions.
9. Complete the physical cross-machine DHT, public Web Push relay, real iPhone Home Screen PWA,
   and live Slack/Telegram sections below. Revoke every disposable peer, bridge token, and push
   credential after recording versions and pass/fail results without secret values.
10. Run the Gemini and GitHub Copilot one-shot adapter probes only with operator-owned authenticated
   subscriptions. Stop on the first auth, quota, or subscription failure; never retry to manufacture
   a green result.
11. Keep Stripe and paid hosted organization services disabled. They are post-launch work in
   `docs/BUSINESS.md`; 0.1.0 must not collect payment or imply that hosted mailbox, directory,
   presence, or native iPhone/Watch products already exist.

## Launch-sweep live acceptance record

Status on 2026-07-11: **both one-shot live re-runs completed but did not satisfy their exact chain
assertions; neither was retried**. M0 settled with two Claude runs where the fixture requires one.
M1 settled with three runs where the plan-review-fold-re-review fixture requires four, and stopped
before its live extension step. Both temporary channels were removed by the fixture before failed
message bodies could be retained, so no root cause is claimed. The historical M0 transcript was an
ignored run artifact until `27d7944`, with its contemporaneous successful completion recorded in
`1a8ae03`; the prior tracked M1 pass is in `79eac33`. Neither is represented as a fresh pass. The
zero-spend M1 remainder passed against the current Codex session: mirrored
join, attach lease/re-adoption, and exact turn-brake hold/release all completed. Deterministic
recursive and Playwright gates remain separate and must be green before publication.

Operator action: after inspecting the current first-party model outputs, harden the acceptance
prompts or assertions without weakening the routing contract, then run each live fixture once on
the pinned cheap models. Treat another extra/missing route as a failed release check, not a reason
to loop paid prompts.

## Final Codex review record

Status on 2026-07-11: **completed and folded**. At the operator's explicit direction, the primary
Codex session performed the full-repository audit itself without a subagent or another paid model
call, starting from launch candidate `ba71d0a`. The review accepted one BLOCKER and five MAJOR
findings: pairing disclosed the global operator bearer so revocation did not end plaintext API
access; attach follow-up actions could mutate a lease from another channel; an enrolled peer could
spoof a pending remote session reference; normal shutdown could await a remote stream before
closing the component able to fail it; mirrored native turns did not commit dedupe and fanout
atomically; and default-recipient routing silently ignored finalized agents more than 500 messages
back. The implementation self-review also separated unauthenticated browser challenges from the
Noise challenge pool and kept refreshed device access authoritative for later REST actions.

All accepted findings and regressions are in Harn plan `final-repository-review-fixes`; the exact
applied commit is recorded by `harn log`. No finding was rejected as a false positive. Reviewed
non-findings remain intentional and documented: the local operator bearer is an administrative
credential, per-human push targeting is deferred, remote ledger attribution follows the explicit
channel-host policy, and the mode-0600 Unix socket trusts the local OS account boundary. The earlier
quota-exhausted Codex CLI attempt remains historical evidence only and is superseded by this
completed in-session review.

## Claude review fallback record

The mandatory Claude Fable 5 review of `e5c0751..ccb41e6` did not produce
findings: the first full `claude -p` invocation remained silent for ten minutes
and was interrupted, a tiny `Reply exactly OK` probe succeeded, and the single
allowed full-review retry was interrupted by the operator before completion.
No Claude process remains. Per the build fallback rule this review is recorded
as **skipped with reason**, not passed. The implementation still completed its
independent Playwright visual/behavior gates and recursive tests; a later full
repository review must cover this range again if Claude is available.

The corrective Settings/pairing review of `47ae835..c2ef646` is likewise
**skipped with reason**, not passed. The one full read-only invocation produced
no output and reached its hard 300-second timeout with exit code 124. The one
permitted tiny probe then returned `OK` with exit code 0, confirming the CLI and
model route were available, but no second full review was attempted to avoid a
retry loop and unnecessary quota use. No Claude process remains. A later full
repository review must cover this range as well.

The P5.2 local-roles review of `dbfee64..7414d1e` is also **skipped
with reason**, not passed. Its full read-only invocation emitted no findings and
reached the enforced 300-second timeout with exit code 124. The one permitted
tiny probe returned `OK` with exit code 0; no full retry followed. No Claude
process remains. A later repository review must cover the role matrix,
principal binding, peer ledger authorization, completion-ack lifecycle, and
home launcher in that range.

The restrained design-foundation range `f63a00b..d4ec5c8` was later recovered
with the corrected headless read-only invocation. All five findings were folded
in fix commit `208af1b`; no operator review action remains for this range.

The restrained channel range `cc5f4b5..e2f78b5` was later recovered with the
corrected invocation. All seven findings were folded in fix commit `019c859`,
including the reduced-transparency blocker; no operator review action remains
for this range.

The restrained Settings/pairing review of `65f0bbe..7b265b2` remains **skipped
with reason**, not passed. A recovered invocation removed incompatible plan
mode, ran from `/home/richard/git/wireroom`, and allowed only read-only Git and
file/search tools, but still emitted no findings before the increased
900-second timeout exited 124. The single permitted corrected-mode probe
returned `OK` with exit 0; no second full attempt followed. No Claude process
remains. A later repository review should cover role-filtered Settings
controls, brake semantics, pairing authority non-disclosure, revoke/unpair
failure handling, and relay-boundary copy in this range.

The completed final full-repository Codex review above covered every range whose per-phase Claude
review is historically recorded here as skipped. No additional repository-coverage action remains
for those ranges; the Claude dispositions stay skipped rather than being rewritten as passes.

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
   a home channel, and a remote FakeAdapter member whose `host` is the outpost `device_id`. On the
   outpost, launch `HyperswarmTransport` plus a resident `ResidencyCoordinator` configured with
   `FakeAdapter`; use the construction in `m2-acceptance.spec.ts` as the operator wrapper. Do
   not set a bootstrap override; both sides must use the real DHT.
3. Post one unique plaintext marker from the home to the remote member and verify the outpost
   FakeAdapter returns its deterministic body, the home finalizes exactly one run with dense
   channel ids, and no channel database or ledger vault appears on the outpost.
4. Capture the connection on either host with the operator's packet tool and search raw packet
   bytes for the marker and ledger body. Both searches must return zero matches; record only
   the result, never the line secret or private keys.
5. Run `codor revoke <outpost-device-id>` against the home data directory. Verify the live
   connection drops, the resident member becomes `unreachable`, reconnect authentication is
   rejected, and a newly posted delivery remains queued at the home.

The production home-side line launcher and friendlier peer-enrollment UX are documentation and
packaging work for M5; this M2 verification uses the already exported switchboard APIs, matching
the automated acceptance topology exactly.

## Real iPhone Home Screen PWA and Web Push

Status on 2026-07-11: **not run**, by the M3 operator directive. Automated acceptance uses a
Chromium standalone app window and CDP push delivery; this step verifies the physical iOS Home
Screen install, APNs-backed Web Push, cold delivery, and notification navigation.

1. Use an iPhone on iOS 16.4 or later. Serve the switchboard web app from a stable HTTPS URL the
   phone can reach, with `CODOR_RELAY_URL` set to the public relay from the next section and
   `CODOR_VAPID_PUBLIC_KEY` set to that relay deployment's public VAPID key. Never place the
   VAPID private key on the switchboard or phone.
2. Open a fresh single-use browser pairing URL on the iPhone and pair it. In the browser Share
   sheet choose **Add to Home Screen**, then launch Codor from its Home Screen icon. Confirm it
   opens without browser chrome, the channel stream and bottom composer fit without horizontal
   scrolling, the channels/members drawer opens, and the app survives a cold relaunch.
3. From the Home Screen app, open Settings and tap **Enable** under notifications. Accept the iOS
   prompt. The prompt must follow that tap; do not treat a permission request on page load as a
   pass. Confirm the paired device row changes to `Push on`.
4. Fully close the Home Screen app. From the switchboard, create exactly one human-targeted event:
   an unread human inbox record, targeted ask/approval, brake hold, or first stall flag. Confirm a
   concise redacted notification arrives on the Lock Screen and Notification Center. A handle may
   legitimately appear in a hold or message preview; confirm instead that configured secret
   markers and any content the redactor should remove are absent.
5. Tap the notification and confirm the Home Screen app opens the correct channel/message fragment.
   Record whether this iOS version exposes the custom `Release hold` action; WebKit versions may
   present only the main notification tap. If the custom action is present, trigger it and confirm
   the held delivery releases exactly once.
6. In Settings, unpair this browser. Confirm the push subscription disappears server-side and the
   phone no longer receives a notification for another targeted event. Reopening the icon must
   require pairing again and must not show prior channel content offline.
7. With two browsers paired, revoke a third disposable device so every channel key rotates. Fully
   close one surviving browser, trigger one targeted event, and confirm its next push still opens;
   the revoked device must receive or decrypt nothing. This checks the device-sealed key refresh
   on a real push provider rather than only the automated worker simulation.

## Public Web Push relay

Status on 2026-07-11: **not run**, by the M3 operator directive. This verifies the self-hosted
container and real push-provider hop; do not use `OPEN_MODE` for this check.

1. On a public host, build `relay/Dockerfile` from the repository root. Generate one VAPID keypair
   outside the repository and configure `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`,
   `VAPID_PRIVATE_KEY`, and `ALLOWED_SENDERS`. The allowlist value is the switchboard's Ed25519
   public identity. Do not print or commit private keys, pairing tokens, line secrets, or browser
   subscription values.
2. Run the container without a persistent volume. Terminate TLS at a reverse proxy and expose only
   `GET /health` and `POST /notify`. Confirm startup fails with neither `ALLOWED_SENDERS` nor an
   explicit open mode, and confirm an unsigned or wrong-sender notify request is rejected. If open
   mode is tested, set `TRUST_PROXY` to the proxy's exact address/CIDR and verify two distinct
   forwarded client addresses do not share one rate bucket.
3. Configure the switchboard with the relay's HTTPS URL and matching public VAPID key, then perform
   the iPhone pairing and notification steps above. Confirm the relay returns success, the sealed
   notification reaches the phone, and relay logs contain no preview plaintext or private key.
4. Restart the relay container and trigger one more targeted notification. It must still forward
   without restoring a database, queue, subscription file, or mailbox. A deliberately expired test
   subscription should surface as `410 subscription_expired` so the switchboard removes it.
5. Record the public URL, image digest, iOS version, Safari/WebKit version, HTTP result codes, and
   pass/fail observations only. Do not record the VAPID private key, full PushSubscription, sealed
   payload, bearer token, or device private keys.

## Live Slack and Telegram bridges

Status on 2026-07-11: **not run**, by the M5 spend and credential directive. Bolt and grammY are
built against injected mock gateways; no Slack app token, Telegram bot token, or live external
channel was available or requested on this machine.

1. Create a disposable Slack channel and a Socket Mode Slack app with message read/write scopes.
   Run `codor-bridge-slack` with `CODOR_URL`, an admin-or-owner `CODOR_TOKEN`,
   `CODOR_ROOM`, `SLACK_CHANNEL_ID`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and
   `SLACK_APP_TOKEN`. Keep the default private state file under `~/.codor/bridges/`, or set
   `CODOR_BRIDGE_STATE` to a persistent owner-only path. Confirm the channel immediately shows the
   permanent bridged privacy band.
2. Post one Slack message containing a unique marker, one `@agent` mention, one `#N` reference,
   and one `[[ledger-note]]` reference. Confirm exactly one Codor message appears as
   `via slack: <display name>` and routes only to the valid agent. Force Slack to retry the same
   event and confirm no second channel message or agent turn appears.
3. Post one local Codor message and confirm exactly one Slack copy appears. Confirm the inbound
   message from step 2 is not echoed back. Stop the bridge, post a second local marker, restart with
   the same state file, and confirm the downtime marker appears once. Do not record tokens, signing
   secrets, state-file contents, channel contents, or bearer headers.
4. Create a disposable Telegram group, add a bot with permission to read and send messages, and
   run `codor-bridge-telegram` with `CODOR_URL`, an admin-or-owner `CODOR_TOKEN`,
   `CODOR_ROOM`, `TELEGRAM_CHAT_ID`, and `TELEGRAM_BOT_TOKEN`. Repeat the inbound retry,
   sender attribution, reference preservation, outbound mirror, and own-origin echo checks.
5. Attempt bridge enable and ingress with observer and member credentials and confirm both receive
   403. Attempt to mention the bridge handle and use the bridge member id to answer an ask; neither
   may select the bridge as a recipient or answerer. Revoke every disposable platform token after
   recording platform/app versions and pass/fail results only.
