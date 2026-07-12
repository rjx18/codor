# Changelog

All notable changes to Codor are documented here. This project follows semantic versioning once
public releases begin.

<!-- harn:assume the-changelog-records-what-the-operator-will-notice ref=round-two-changelog -->
## Unreleased

Nine findings from live phone testing of the release candidate, fixed.

### Fixed

- **An untagged message in a fresh channel reached nobody.** The default recipient only
  materialized after an agent had finished a turn, which never happens in a new channel, so
  "hi" was room commentary delivered to no one. The channel's starting agent — or its only
  live agent — is now the default, and the composer materializes `@codor ` as you type.
- **Channel colours were invisible.** Colour was a creation-dialog concept, so channels made
  by the CLI (the systemd unit seeds one that way) had none at all. Every channel now gets an
  accent derived from its own id, at creation and on read, and the rail shows it as a filled
  mark.
- **An approval was unreadable on a phone.** The card is full-width, leads with what is being
  asked and who is asking, makes the command the centre in a wrapped monospace block, and
  stacks full-width 44px options below the mobile breakpoint.
- **Tool rows wasted the screen.** A row is one line showing what the tool actually did — the
  verbatim command, the file it explored, the diffstat it wrote — instead of two lines
  labelled "Bash".
- **An empty channel rendered a blank timeline**, indistinguishable from a broken one. It now
  greets and names the agent that is ready; a dropped connection dims the timeline and says
  it is reconnecting; a switchboard that cannot be reached says so.
- **The inbox badge counted work but could not be clicked.** It opens a panel listing every
  ask and approval waiting on you — who asked, on what tool, how long ago — and choosing one
  takes you to the card.
- **The composer wasted a row** on a heading that repeated its own placeholder, and its input
  and buttons disagreed about height.
- The footer no longer calls the product a "Local switchboard".

### Added

- **Short pairing codes.** `codor pair` prints an eight-character code beside the link and QR;
  an unpaired phone can enrol by typing it, and a paired browser can mint one from Settings to
  add another device. Codes share the link's ten-minute single-use grant, burn on success
  only, are rate-limited per connection, and are redacted from served content.
- **Harness and model catalogs.** Creating a channel or spawning an agent is now tapping tiles
  and buttons: a tile per installed harness, a row of models the harness itself reports, and a
  thinking row that disables itself where the harness does not support one. Adapters answer for
  their own models — opencode by asking its CLI, the rest from lists cited in their NOTES.md —
  so no model id is hardcoded in the web app.
<!-- harn:end the-changelog-records-what-the-operator-will-notice -->

## 0.1.0 - 2026-07-11

### Changed

- Renamed Wireroom to Codor as a clean break: `codor` CLI and service, `CODOR_*` environment,
  `~/.codor` data, `@codor/*` packages, Codor transport/storage domains, and channel terminology
  on every human-facing surface. Wire, REST, and database identifiers continue to use `room`.

### Added

- Local-first channel switchboard with SQLite history, durable routing, compact run evidence, brakes,
  search, permalink references, inbox delivery, and role-bound human acts.
- Claude Code, Codex, Gemini, Copilot, and OpenCode adapters plus a documented third-party adapter
  SDK, fixture convention, registry, and hot-swap acceptance proof.
- Responsive installable web PWA with paired browser identity, sealed Web Push, desktop channel and run
  inspector, settings, relay disclosure, and a read-only ledger graph.
- Ed25519/X25519 device identity, single-use pairing, channel-key rotation, Noise-authenticated private
  DHT home/outpost transport, completion acknowledgements, and home-only ledger authority.
- Optional sealed-payload Web Push relay and opt-in Slack/Telegram bridge processes with durable
  deduplication, restart progress, sender attribution, and permanent privacy disclosure.
- Self-host guide, user-systemd unit, restrained VitePress documentation site, license audit, and a
  fresh-clone install/build/boot/CLI/API/teardown regression.

### Security

- Bearer, pairing, peer, and browser authority fail closed; revocation rotates channel keys and purges
  local browser material; path and ledger writes are contained beneath their configured roots.
- Secrets and raw model events are redacted before durable display, push previews are fixed-size
  authenticated ciphertext, and external bridges require explicit channel opt-in.

### Deferred

- Native iPhone and Apple Watch applications, real-device push-provider validation, physical
  cross-machine NAT validation, and live Slack/Telegram credentials remain operator-owned checks.
- Hosted rendezvous/mailbox, paid multi-human directory/presence, and Stripe billing are not part of
  the self-hosted 0.1.0 product.
