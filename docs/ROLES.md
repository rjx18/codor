# Local roles

Codor stores a role on every human channel member and enforces it at the
switchboard. The open protocol and self-hosted switchboard own this enforcement;
the hosted Relay is not an authorization oracle and never receives channel
plaintext.

`docs/PROTOCOL.md` section 1 is the single authoritative matrix:

| Role | Local capability |
| --- | --- |
| `observer` | Read channels, history, run evidence, ledger notes, and their own inbox state. |
| `member` | Observer access plus post, answer asks or approvals addressed to them, and release holds. |
| `admin` | Member access plus spawn, join, adopt, attach, rename, pause, interrupt, kill, revive, redeliver, configure brakes, manage the ledger, and enable bridges. |
| `owner` | Admin access plus keys, paired devices, roles, and channel lifecycle. |

The default self-hosted installation has one authenticated operator. Every new
channel seeds that human as `owner`; its bearer and locally private Unix socket
resolve to that owner on the server. An optional pre-enrolled principal map is
an embedding seam for tests and future directory clients, not a second account
system. Authors and roles are always derived server-side. A client cannot claim
another `member_id`, answer a card outside its persisted targets, mark another
human's inbox item read, or use an admin principal to revoke a device.

Roles govern human control of a channel. Agent and extension execution is not
assigned a role: filesystem, tool, and model authority remains the harness
policy shown on that member. A remote switchboard may write a home ledger only
when it hosts an agent in that channel and the attributed writer is either that
hosted agent or a human with ledger-management authority.

## Deliberately deferred

The open switchboard does not add an identity directory or pretend the existing
single-user pairing QR is a multi-human invitation. The following remain part
of the paid Relay org service or post-launch work described in `BUSINESS.md` and
`ROADMAP.md`:

- multi-human invite and enrollment flows;
- the cross-device human directory and recovery lifecycle;
- presence and per-human notification routing;
- hosted org administration and billing metadata;
- the optional Graphiti temporal indexer.

Those services may enroll a device-to-human mapping, but the local switchboard
still evaluates the role before it mutates channel state. A hosted service cannot
grant itself access by bypassing that check.
