# Wireroom

![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-3c873a)
![pnpm 10.9](https://img.shields.io/badge/pnpm-10.9-f69220)
![License: MIT](https://img.shields.io/badge/license-MIT-222222)

**One room. Every agent on the wire.** Wireroom is a local-first conversation for persistent
coding-agent sessions. Claude Code, Codex, Gemini, Copilot, OpenCode, and third-party adapters keep
their native sessions and bounded context; Wireroom carries only explicit messages and references
between them.

![Wireroom room with conversation, bridged-room disclosure, and member context](website/public/wireroom-room.png)

The complete solo product is self-hosted and MIT licensed: switchboard, CLI, adapter SDK, web PWA,
ledger, private multi-machine transport, sealed push relay, and opt-in Slack and Telegram bridges.
The room database, run evidence, keys, and ledger stay on the room's home machine.

## Quick start

Prerequisites: Node.js 22 or newer, Corepack, Git, `curl`, and OpenSSL.

```sh
git clone <repository-url> wireroom
cd wireroom
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm -r build

umask 077
export WIREROOM_TOKEN="$(openssl rand -hex 32)"
node packages/cli/dist/index.js \
  --data-dir "$HOME/.wireroom" \
  up --static-root "$PWD/packages/web/dist" \
  --room desk --room-name Desk
```

Open `http://127.0.0.1:8137`. In another terminal, create a ten-minute, single-use browser pairing
link without putting the bearer token in the URL:

```sh
node packages/cli/dist/index.js \
  --data-dir "$HOME/.wireroom" \
  pair --endpoint http://127.0.0.1:8137
```

The [self-host guide](docs/SELF-HOST.md) covers a user-systemd service, private HTTPS through
Tailscale Serve, DHT home/outpost lines, relay and bridge boundaries, backup/restore, and upgrades.
The clean-clone proof runs the entire install, build, boot, CLI, authenticated API, and teardown
path in a disposable directory:

```sh
scripts/fresh-install-test.sh
```

## How the room works

- **Sessions are members.** Name the work, not the vendor: `@coder`, `@reviewer`, `@red-team`.
- **Mentions route turns.** `@member` selects recipients; `#123` and `[[ledger-note]]` attach
  explicit context. Untagged human messages follow the room's last-author routing rule.
- **Runs stay readable.** Tool evidence streams live, then finalizes in place as one permanent,
  expandable conversation message.
- **Authority stays local.** Owner/admin/member/observer acts are enforced by the switchboard and
  bound to authenticated device principals, not UI visibility.
- **The ledger is not shared context.** Each room can expose an Obsidian-compatible Markdown vault
  and a read-only wikilink graph; agents receive only cited notes.
- **Bridges are deliberate exceptions.** Slack and Telegram are opt-in external exports, always
  disclosed in the room, deduplicated on ingress, and suppressed from echoing their own messages.

## CLI

The built entrypoint is `node packages/cli/dist/index.js`. Representative commands:

```sh
# Inspect and post through the private local socket
node packages/cli/dist/index.js rooms
node packages/cli/dist/index.js post -r desk '@reviewer check #12'
node packages/cli/dist/index.js tail -r desk --once

# Host or join a private multi-machine line
node packages/cli/dist/index.js up \
  --join 'project:<high-entropy-secret>'
node packages/cli/dist/index.js --data-dir "$HOME/.wireroom-outpost" serve \
  --join 'project:<same-high-entropy-secret>'
```

Run `node packages/cli/dist/index.js --help` for the complete surface. Adapter authors start with
[docs/ADAPTERS.md](docs/ADAPTERS.md); third-party harnesses register by module without editing core.

## Privacy boundary

Wireroom is local-first, not magically risk-free. A browser bearer is a credential. DHT line
secrets are discovery capabilities. Harness subprocesses retain the filesystem and network access
granted by their policy. The optional push relay receives padded sealed payloads but delivery
metadata; Slack and Telegram receive readable bridged-room content under their own terms. Read the
[privacy model](docs/PRIVACY.md) before enabling remote access, push, or bridges.

Native iPhone and Apple Watch apps, hosted mailbox/rendezvous, and paid organization services are
future convenience surfaces. The installed web PWA is the current phone client; no hosted service
is required for the complete local product.

## Documentation

| Guide | Purpose |
| --- | --- |
| [Vision](docs/VISION.md) | Product principles, surfaces, and prior art |
| [Self-host](docs/SELF-HOST.md) | Install, operate, expose privately, back up, and upgrade |
| [Protocol](docs/PROTOCOL.md) | Members, roles, messages, routing, runs, and normalized events |
| [Architecture](docs/ARCHITECTURE.md) | Switchboard, adapters, storage, transports, and reuse boundaries |
| [Privacy](docs/PRIVACY.md) | Threat model, topology, cryptography, relay, and bridge disclosures |
| [Roles](docs/ROLES.md) | Local role enforcement and hosted-service boundary |
| [Roadmap](docs/ROADMAP.md) | Completed milestones and future native/hosted work |
| [Business](docs/BUSINESS.md) | Open solo product and paid operational convenience |

The VitePress site lives in `website/`. Set `WIREROOM_REPOSITORY_URL` to the final public repository
URL when building a published site; Source, social, and edit controls stay absent otherwise rather
than pointing at a speculative remote.

## Development

```sh
corepack pnpm install --frozen-lockfile
pnpm test:all
pnpm audit:license
```

`pnpm test:all` builds every workspace, runs the recursive Vitest and website gates, then runs the
Playwright browser suite. Live model, bridge, push-provider, and physical cross-machine checks are
credential-gated and documented in [MANUAL-VERIFY.md](MANUAL-VERIFY.md).

## License

[MIT](LICENSE), copyright 2026 Richard Xiong. Paseo informed layout and interaction research only;
no Paseo code or assets are included.
