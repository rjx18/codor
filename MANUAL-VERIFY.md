# Manual adapter verification

Live probes are intentionally single-shot and tiny. Do not retry an auth,
quota, or subscription failure.

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

## Real iPhone Home Screen PWA and Web Push

Status on 2026-07-11: **not run**, by the M3 operator directive. Automated acceptance uses a
Chromium standalone app window and CDP push delivery; this step verifies the physical iOS Home
Screen install, APNs-backed Web Push, cold delivery, and notification navigation.

1. Use an iPhone on iOS 16.4 or later. Serve the switchboard web app from a stable HTTPS URL the
   phone can reach, with `WIREROOM_RELAY_URL` set to the public relay from the next section and
   `WIREROOM_VAPID_PUBLIC_KEY` set to that relay deployment's public VAPID key. Never place the
   VAPID private key on the switchboard or phone.
2. Open a fresh single-use browser pairing URL on the iPhone and pair it. In the browser Share
   sheet choose **Add to Home Screen**, then launch Wireroom from its Home Screen icon. Confirm it
   opens without browser chrome, the room stream and bottom composer fit without horizontal
   scrolling, the rooms/members drawer opens, and the app survives a cold relaunch.
3. From the Home Screen app, open Settings and tap **Enable** under notifications. Accept the iOS
   prompt. The prompt must follow that tap; do not treat a permission request on page load as a
   pass. Confirm the paired device row changes to `Push on`.
4. Fully close the Home Screen app. From the switchboard, create exactly one human-targeted event:
   an unread human inbox record, targeted ask/approval, brake hold, or first stall flag. Confirm a
   concise redacted notification arrives on the Lock Screen and Notification Center. A handle may
   legitimately appear in a hold or message preview; confirm instead that configured secret
   markers and any content the redactor should remove are absent.
5. Tap the notification and confirm the Home Screen app opens the correct room/message fragment.
   Record whether this iOS version exposes the custom `Release hold` action; WebKit versions may
   present only the main notification tap. If the custom action is present, trigger it and confirm
   the held delivery releases exactly once.
6. In Settings, unpair this browser. Confirm the push subscription disappears server-side and the
   phone no longer receives a notification for another targeted event. Reopening the icon must
   require pairing again and must not show prior room content offline.
7. With two browsers paired, revoke a third disposable device so every room key rotates. Fully
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
