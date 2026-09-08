# Capri stale hold: rollout-only repair

Do not execute during implementation. The confirmed candidate is room `capri`,
message `2476`, recipient handle `sol3`, removed on 2026-09-04. The report does
not contain the durable delivery/member UUIDs: resolve them from this read-only
preview on the rollout host, never substitute a new member reusing the handle.

```sql
SELECT d.room, d.id AS delivery_id, d.message_id, d.recipient,
       d.state, d.run_msg_id, m.handle, m.removed_ts
FROM deliveries d JOIN members m ON m.room=d.room AND m.id=d.recipient
WHERE d.room='capri' AND d.message_id=2476 AND d.state='held'
  AND m.handle='sol3' AND m.removed_ts IS NOT NULL;
```

Before any repair, save a consistent SQLite backup and referenced run JSONL.
Record the exact UUIDs and the preview result in rollout evidence. Confirm the
recipient is still removed and no native process owns its attempt. If the preview
does not match one expected candidate, stop; do not broaden the filter.

After deploying this phase, invoke the existing owner-authorized `remove` act
with `member_id` set to the preview's exact recipient ID on the Capri connection.
Repeated removal now
drains queued/held work while keeping the tombstone, source messages, run IDs,
journals and accounting. Started group work uses existing attempt settlement;
unstarted group work uses participant skip. It never releases/redelivers the hold.

Re-run the preview: zero held rows must remain. Inspect the preserved source/run
and resulting consumed delivery; reload Capri and verify no unsolicited cursor
walk. Keep backup and before/after evidence. No direct DELETE/UPDATE, mass cleanup,
automatic startup repair, or automatic retry is part of this procedure.
