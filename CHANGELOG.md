# Changelog

All notable changes to Codor are documented here. This project follows semantic versioning once
public releases begin.

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
