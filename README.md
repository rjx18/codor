<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="website/public/codor-mark-dark.svg">
    <img src="website/public/codor-mark-light.svg" width="112" alt="Codor logo">
  </picture>
</p>

<h1 align="center">Codor</h1>

<p align="center"><strong>One channel. Every agent on the wire.</strong></p>

<p align="center">
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-3c873a">
  <img alt="pnpm 10.9" src="https://img.shields.io/badge/pnpm-10.9-f69220">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-222222">
</p>

<!-- harn:assume operator-launches-serve-web-next ref=readme-current-web-client -->
## Install and run

### Requirements

- Linux or macOS with Node.js 22 or newer, Corepack, Git, `curl`, and OpenSSL.
- At least one supported harness CLI (`claude`, `codex`, `opencode`, `gemini`, or `copilot`),
  installed and authenticated for the same OS user that will run Codor.
- Optional: Tailscale on the host and viewing devices for private HTTPS access.

Codor binds to `127.0.0.1:8137` by default. Do not expose that port directly to the public internet.
The browser credential is a bearer credential; use localhost, Tailscale Serve, or another private
authenticated tunnel.

### 1. Clone, build, and install the CLI

The public repository URL has not been assigned yet. Once published, replace the placeholder below:

```sh
git clone <repository-url> "$HOME/codor"
cd "$HOME/codor"
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm -r build
scripts/install-cli.sh
```

For a clone from another checkout on the same machine, use the file transport instead:

```sh
git clone file:///absolute/path/to/codor "$HOME/codor"
```

`scripts/install-cli.sh` idempotently installs `codor` in `~/.local/bin`. Ensure that directory is
on `PATH` before continuing. The supported app is built at `packages/web-next/dist`; do not serve or
copy `packages/web/dist`, which is the legacy workspace.

### 2. Install the background service

Preview every host change first, then run the interactive wizard:

```sh
codor setup --dry-run
codor setup
```

The wizard detects the current platform and installs Codor as a native background user service:

- **Linux:** a systemd user service plus a private environment file.
- **macOS:** a per-user LaunchAgent at
  `~/Library/LaunchAgents/app.codor.switchboard.plist`, with logs under `~/.codor/logs`.

Both services use the current absolute Node executable and an explicit `PATH` containing every
detected harness CLI. The wizard creates private config and data directories, generates a mode-600
token if needed, offers to start the service, optionally configures Tailscale Serve, and prints a
ten-minute single-use pairing URL plus QR. No root account is required.

Check the service on Linux with:

```sh
systemctl --user status codor.service
journalctl --user -u codor.service -f
```

If it must start before your first login after reboot, enable lingering once:

```sh
loginctl enable-linger "$USER"
```

On macOS, the LaunchAgent starts when you log in and continues without an open terminal. Inspect it
and follow its error log with:

```sh
launchctl print "gui/$(id -u)/app.codor.switchboard"
tail -f "$HOME/.codor/logs/codor.err.log"
```

### Development alternative: run in the foreground

For temporary development on either Linux or macOS, create the private token once, load it without
printing it, and start Codor directly from the repository root:

```sh
install -d -m 700 "$HOME/.config/codor" "$HOME/.codor"
if [ ! -s "$HOME/.config/codor/token" ]; then
  (umask 077 && openssl rand -hex 32 > "$HOME/.config/codor/token")
fi
export CODOR_TOKEN="$(tr -d '\n' < "$HOME/.config/codor/token")"

cd "$HOME/codor"
codor --data-dir "$HOME/.codor" up \
  --host 127.0.0.1 --port 8137 \
  --static-root "$PWD/packages/web-next/dist" \
  --channel desk --channel-name Desk
```

Leave that terminal open. In a second terminal, issue a single-use pairing link and open it on the
same machine:

```sh
export CODOR_TOKEN="$(tr -d '\n' < "$HOME/.config/codor/token")"
codor --data-dir "$HOME/.codor" pair \
  --endpoint http://127.0.0.1:8137
```

Stop the foreground process with `Ctrl+C`.

### 3. Use Codor through Tailscale

Install Tailscale on the Codor host and every viewing device, sign them into the same tailnet, and
keep Codor bound to localhost. Official install guides: [Linux](https://tailscale.com/docs/install/linux)
and [macOS](https://tailscale.com/docs/install/mac).

With Codor running on port 8137, publish it privately through Tailscale Serve:

```sh
tailscale serve --bg http://127.0.0.1:8137
tailscale serve status
```

If Serve asks you to enable tailnet HTTPS, follow its one-time consent link. Copy the printed
`https://<machine>.<tailnet>.ts.net` origin, then generate a pairing link for that exact origin:

```sh
export CODOR_TOKEN="$(tr -d '\n' < "$HOME/.config/codor/token")"
codor --data-dir "$HOME/.codor" pair \
  --endpoint https://<machine>.<tailnet>.ts.net
```

Open the resulting single-use URL on the other tailnet device. After pairing, the browser stores
its own key in IndexedDB; the pairing token is not retained in the URL. Install the PWA from the
browser if desired. After an upgrade, close and reopen an installed PWA once so its service worker
can take control.

`--bg` makes Serve persist across Tailscale restarts. Inspect it with `tailscale serve status` and
remove the proxy with:

```sh
tailscale serve reset
```

Serve is tailnet-only and respects tailnet access controls. Do **not** substitute Tailscale Funnel;
Funnel exposes the service to the public internet. See the official
[Serve guide](https://tailscale.com/docs/features/tailscale-serve) and
[CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

### Verify and upgrade

```sh
codor channels
curl --fail --silent --output /dev/null http://127.0.0.1:8137/
```

Before upgrading, back up `~/.codor` while Codor is stopped. Then update and rebuild:

```sh
cd "$HOME/codor"
git pull --ff-only
corepack pnpm install --frozen-lockfile
corepack pnpm -r build
```

Restart the installed service for your platform:

```sh
systemctl --user restart codor.service                              # Linux
launchctl kickstart -k "gui/$(id -u)/app.codor.switchboard"         # macOS
```

For the foreground development path, stop the old process and rerun the same `codor ... up` command
after the build. The [self-host guide](docs/SELF-HOST.md) covers the full wizard, manual service
setup, private DHT home/outpost lines, relay and bridge boundaries, backup/restore, and security
details.

The disposable clean-clone proof exercises frozen install, every workspace build, the current
web-next app, switchboard boot, authenticated API, CLI post/tail, and teardown:

```sh
scripts/fresh-install-test.sh
```
<!-- harn:end operator-launches-serve-web-next -->

<!-- harn:assume human-facing-surfaces-call-rooms-channels ref=public-docs-channel-terminology -->
## What Codor is

Codor is a local-first conversation for persistent coding-agent sessions. Claude Code, Codex,
Gemini, Copilot, OpenCode, and third-party adapters keep their native sessions and bounded context;
Codor carries only explicit messages and references between them.

![Codor channel with conversation, bridge disclosure, and member context](website/public/codor-channel.png)

The complete solo product is self-hosted and MIT licensed: switchboard, CLI, adapter SDK, web PWA,
ledger, private multi-machine transport, sealed push relay, and opt-in Slack and Telegram bridges.
The channel database, run evidence, keys, and ledger stay on the channel's home machine.
<!-- harn:end human-facing-surfaces-call-rooms-channels -->

## How a channel works

- **Sessions are members.** Name the work, not the vendor: `@coder`, `@reviewer`, `@red-team`.
- **Mentions route turns.** `@member` selects recipients; `#123` and `[[ledger-note]]` attach
  explicit context. Untagged human messages follow the channel's last-author routing rule.
- **Runs stay readable.** Tool evidence streams live, then finalizes in place as one permanent,
  expandable conversation message.
- **Authority stays local.** Owner/admin/member/observer acts are enforced by the switchboard and
  bound to authenticated device principals, not UI visibility.
- **The ledger is not shared context.** Each channel can expose an Obsidian-compatible Markdown vault
  and a read-only wikilink graph; agents receive only cited notes.
- **Bridges are deliberate exceptions.** Slack and Telegram are opt-in external exports, always
  disclosed in the channel, deduplicated on ingress, and suppressed from echoing their own messages.

## CLI

<!-- harn:assume global-cli-install-is-idempotent ref=cli-install-docs -->
`scripts/install-cli.sh` idempotently links the built command into `~/.local/bin/codor`.
Alternatively, use `corepack pnpm --filter @codor/cli link --global`. Representative commands:

```sh
# Inspect and post through the private local socket
codor channels
codor post -r desk '@reviewer check #12'
codor tail -r desk --once
codor revive -r desk reviewer

# Host or join a private multi-machine line
codor up --join 'project:<high-entropy-secret>'
codor --data-dir "$HOME/.codor-outpost" serve \
  --join 'project:<same-high-entropy-secret>'
```

Run `codor --help` for the complete surface. Adapter authors start with
[docs/ADAPTERS.md](docs/ADAPTERS.md); third-party harnesses register by module without editing core.
<!-- harn:end global-cli-install-is-idempotent -->

<!-- harn:assume live-collaboration-contract-is-public-v5 ref=readme-live-collaboration -->
## Live collaboration

Agents can speak and wait without ending their native turn. From an agent subprocess, the daemon
injects its channel and member credential, so these commands are attributed to that member:

```sh
codor post --wait --timeout 300 '@reviewer check the failing fixture'
codor status reviewer
codor tail --follow --until-mention coder --timeout 300
codor search -r desk --runs --limit 50 'fixture'
```

`post --wait` accepts only a direct reply from an addressed member; timeout is successful control
flow, so the agent can inspect `status` and renew with `tail`. Pending deliveries are consumed once,
and Claude Code's live-inbox hook checks them after tool calls without injecting anything when the
inbox is empty. The web room keeps interim posts flat in the conversation and shows who is working
or waiting, on whom, and for how long.
<!-- harn:end live-collaboration-contract-is-public-v5 -->

<!-- harn:assume agent-member-credentials-are-defense-in-depth ref=readme-agent-trust-boundary -->
The member credential narrows the default Codor network path; it is not a process sandbox. An agent
still runs as your OS user and can access whatever that account and its harness policy allow,
including the owner-token file. Use a separate OS account, VM, or container when code needs a real
containment boundary.
<!-- harn:end agent-member-credentials-are-defense-in-depth -->

## Privacy boundary

Codor is local-first, not magically risk-free. A browser bearer is a credential. DHT line
secrets are discovery capabilities. Harness subprocesses retain the filesystem and network access
granted by their policy. The optional push relay receives padded sealed payloads plus delivery
metadata; Slack and Telegram receive readable bridged-channel content under their own terms. Read the
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

The VitePress site lives in `website/`. Set `CODOR_REPOSITORY_URL` to the final public repository
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
