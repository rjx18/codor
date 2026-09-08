# Optional acknowledged posts

An authenticated `/api/client-compatibility` response can advertise
`post_acknowledgements: true`. This is additive; browser protocol epoch 2 is
unchanged. Missing support means legacy posting and **no automatic post retry**.

A capable caller sends its ordinary `post` frame with one opaque
`submission_id` (1–128 characters). Generate a fresh random ID per intentional
send and retain the same ID and complete payload for any retry. The daemon
responds only to that request with:

```json
{
  "type": "post_accepted",
  "submission_id": "one-intent",
  "origin_room": "source",
  "outcome": {
    "kind": "message",
    "room": "actual-destination",
    "message_id": 42,
    "seq": 73,
    "delivery_ids": ["original-delivery-id"],
    "group_id": "optional-original-group-id"
  }
}
```

A scheduled outcome instead contains `kind: "schedule"`, `room`, `schedule_id`,
`seq` and the original `due_ts`; it contains no immediate message ID. These are
original acceptance results. Current message/schedule state, including deletion
and cancellation, continues through ordinary echo, replay and history. The
receipt's original sequence is **not** a new client replay cursor.

Errors retain their existing `error` frame and message/ref behavior. An opted-in
request additionally receives `submission_id` and `origin_room` on its error,
including valid correlation extracted before payload validation. Other clients
receive no new acknowledgement frame. A transport/authentication loss is not an
application rejection: the existing reconnect/credential lifecycle owns it.

Receipts are scoped to the local daemon database and a stable authenticated
principal: owner, paired device ID, or authenticated human/agent member ID.
Access tokens are never the deduplication key. Current origin authorization
precedes lookup; destination authorization precedes disclosure. The fingerprint
binds the originating room, exact body, reply, ordered uploaded attachment IDs,
voice metadata and waiting intent, plus the original resolved destination.
Optional empty/default values canonicalize identically. Changing that payload
under the same sender/ID is refused.

Receipt insertion shares an immediate SQLite transaction with the accepted
message or schedule, change sequence and complete delivery/group fanout. Live
publication and dispatch happen after commit. A duplicate returns the original
IDs before upload lookup, renamed-handle routing or relative-time parsing, with
no repeated fanout, notifications or usage. Receipts have no TTL or deletion
cascade; deleting an accepted message cannot make a delayed retry recreate it.
Existing history requires no backfill.

The browser keeps one already-dispatched immutable submission per computer
connector. Only the original room's ready authenticated socket generation may
retry it, once per replacement generation. The capability is rechecked on a
replacement connection, so a downgraded daemon cannot accidentally accept a
retained ID as a second legacy post. An unresolved retained submission stays
visible if support disappears. Current-generation results settle only their own
source room/computer. Body, reply, attachments, edited-draft state and completed
voice transcripts stay in page memory while switching views; a result clears
only the unchanged original draft. Rejected voice can be edited or sent again
without transcription/upload being repeated automatically.

`Connection.post()` reports local socket write acceptance, not server acceptance.
Without capability support the browser keeps the existing own-echo matching and
shows the uncertainty after dispatch; it never retries a potentially accepted
legacy post automatically.

| Browser | Daemon | Behavior |
| --- | --- | --- |
| Old | New | Ordinary legacy frames, no unsolicited acknowledgements |
| New | Old | Legacy echo matching, no automatic resubmission |
| New | New | Correlated results and durable same-ID retry |

There is no persistent offline outbox. Closing the page ends automatic recovery;
a caller retaining the original ID can still retry later without duplication.
This prevents duplicate accepted submissions and fanout. It does not promise
exactly-once agent external actions or delivery through a permanent outage.

## Validation

`post-submission.spec.ts` covers rollback, actual process death before receipt
insertion and after commit (messages/groups and schedules), restart, concurrent
socket requests, stable refreshed credentials, revocation, authorization,
qualified routing, changed payloads and attachment/voice deletion tombstones.
`room46-post-submissions.e2e.spec.ts` exercises direct and hosted real browsers,
old/new combinations, loss boundaries, edited drafts, room/computer switching,
grouped attachment posts and voice retries. Its optional runtime and web-root
inputs permit the unchanged base and locally installed npm packages to supply
actual older/newer implementations.

`node scripts/p6-installed-proof.mjs <installed-package-root> <proof-directory>`
runs the installed CLI with native SQLite, locally installed fake agents and
isolated storage/ports, kills and restarts that daemon, and checks original
message/group/schedule outcomes plus deletion tombstones. It also restarts the
installed daemon under actual direct and hosted browsers with an unconsumed
acknowledgement, proving automatic same-ID recovery and preservation of edited
drafts without reload. Test storage can stay
inside a checkout by setting `TMPDIR` there and `GIT_CEILING_DIRECTORIES` to that
test root, preventing non-repository fixtures from inheriting the checkout.

The installed browser restart proof records one inherited P5 relay teardown
diagnostic: a coalescer flush attempts `channel.seal` after the channel was
cleared. The unchanged browser and daemon at clean base `18ee45c2` reproduce the
same exception on an ordinary hosted restart without P6. Both versions recover;
P6 receipt, retry and draft assertions pass. The proof permits only that exact
known diagnostic (at most once per hosted restart) and fails on other browser
errors. Relay teardown source is unchanged in this phase.
