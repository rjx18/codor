# Self-host Codor

Run the switchboard, web app, adapters, and optional relay on machines you control. The channel
database, run evidence, ledger, and private keys stay in the data directory on the channel's home
machine. No hosted Codor component is required.

<!-- harn:assume fresh-clone-install-proven-by-script ref=selfhost-guide -->
## Prerequisites

- Linux or macOS with Node.js 22 or newer, `corepack`, Git, `curl`, and OpenSSL.
- The harness CLIs you intend to use, installed and authenticated for the service user.
- pnpm 10.9.0, selected by the repository's `packageManager` field through Corepack.
- Optional: Tailscale for private HTTPS access from phones and other machines.

Never expose port 8137 directly to the public internet. The browser token is a bearer credential;
use loopback plus Tailscale Serve, another authenticated private tunnel, or a hardened reverse
proxy you operate.

## Install

Choose a stable directory and keep the Git checkout for upgrades:

```sh
git clone <published-repository-url> ~/codor
cd ~/codor
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm -r build
scripts/install-cli.sh
```

Until the public repository URL exists, clone the local checkout with
`git clone file:///absolute/path/to/codor ~/codor`. The fresh-install test uses that exact
transport so it cannot borrow `node_modules`, build output, or untracked files.

As an alternative to the install script, run
`corepack pnpm --filter @codor/cli link --global`.

## Setup wizard

Run the one-shot wizard under the service user:

```sh
codor setup
```

The wizard asks before each mutating step. It creates `~/.config/codor` and `~/.codor` with
mode 700, creates a mode-600 token if one is absent, installs the user service with the absolute
path to the current Node executable, and writes a mode-600 environment file. Its explicit `PATH=`
includes `~/.local/bin`, the Node bin directory, and the directory of every detected
`claude`, `codex`, `opencode`, `gemini`, or `copilot` executable, so nvm and shell-only harness
installs remain visible to systemd. It then offers to enable the service, publish loopback through
Tailscale Serve, and generate a ten-minute pairing URL plus a compact terminal QR.

Preview the complete action list and generated unit content without writing files or invoking
system commands:

```sh
codor setup --dry-run
```

Open the single-use URL or scan the QR on the target browser. After pairing, the browser stores its
own keypair in origin-scoped IndexedDB and launches without a token query string. Generate another
offer later with `codor pair`; use `codor pair --no-qr` for plain output.

## Manual service appendix

The wizard is the primary path. For unusual installations, the checked-in
`packaging/systemd/codor.service` is the manual user-service template. It assumes the checkout
is `~/codor` and the data directory is `~/.codor`; replace `/usr/bin/node` with the exact
output of `command -v node`, and write an explicit harness-aware `PATH=` in the environment file.
An nvm-only shell installation is unavailable to systemd without its absolute Node path.

```sh
install -d -m 700 ~/.config/codor ~/.config/systemd/user
umask 077
openssl rand -hex 32 > ~/.config/codor/token
install -m 600 packaging/systemd/codor.service ~/.config/systemd/user/codor.service
printf 'CODOR_TOKEN=%s\n' "$(cat ~/.config/codor/token)" > ~/.config/codor/env
printf 'PATH=%s\n' "$HOME/.local/bin:$(dirname "$(command -v node)"):$PATH" >> ~/.config/codor/env
chmod 600 ~/.config/codor/env
systemctl --user daemon-reload
systemctl --user enable --now codor.service
systemctl --user status codor.service
```

Use `loginctl enable-linger "$USER"` if the user service must start at boot before an interactive
login. The service has a restrictive umask but deliberately retains access to the operator's
projects and authenticated harness CLIs; those subprocesses are the work being hosted.

For development diagnostics only, the single repository-relative fallback is
`node packages/cli/dist/index.js --help`; installed operation should use `codor`.

## Private access with Tailscale

For the common single-operator setup, keep Codor on loopback and let Tailscale terminate HTTPS:

```sh
tailscale serve --bg http://127.0.0.1:8137
tailscale serve status
```

Open the HTTPS URL printed by Tailscale on another tailnet device, then generate the pairing link
with that HTTPS origin as `--endpoint`. Current Tailscale releases persist a background Serve
configuration across daemon restarts. Use `tailscale serve reset` to remove it. Do not use
Tailscale Funnel: Funnel is public internet exposure, while Serve is tailnet-only.
Check the [current Tailscale Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve)
before automating the command because its syntax changed in Tailscale 1.52.

<!-- harn:assume tailnet-auto-pairing-explicit-trust ref=trusted-tailnet-research-evidence -->
Tailscale's [Serve identity-header documentation](https://tailscale.com/docs/features/tailscale-serve#identity-headers),
last validated by Tailscale on 2026-01-20, states that tailnet Serve requests
receive `Tailscale-User-Login` and that an incoming client copy is removed to
prevent spoofing. A local probe on 2026-07-11 through Tailscale Serve 1.98.4
confirmed both properties without exposing the login value: the backend saw a
nonempty identity, and a deliberately supplied spoof value was overridden.

Auto-pairing is opt-in with `codor up --trust-tailscale-serve` or
`CODOR_TRUST_TAILSCALE_SERVE=1`; it is off by default. The switchboard cannot
distinguish the Serve proxy from any other local process connecting to
127.0.0.1:8137, so enabling the flag extends enrollment power to anything that
can reach loopback and set a header — i.e. every local OS user, a wider grant
than the existing token/0600-socket boundary. The flag therefore defaults off
and is recommended only on single-user hosts.
<!-- harn:end tailnet-auto-pairing-explicit-trust -->

### App connector for an existing domain

A Tailscale app connector is an advanced team option when you already operate a custom domain and
a routable application origin. It is not a shortcut for a loopback-only laptop. Current Tailscale
setup requires a stable Linux connector with IP forwarding, a connector tag, route auto-approval,
DNS-discovery grants, a custom app/domain entry, and:

```sh
tailscale up --advertise-connector --advertise-tags=tag:codor-connector
```

Follow Tailscale's current app-connector setup guide for the required `tagOwners`, `autoApprovers`,
`grants`, and `nodeAttrs` policy entries. Restrict the origin to connector egress addresses where
possible, and keep Codor's device pairing as a second boundary. For a personal installation,
prefer Serve; it has fewer moving parts and does not require a public origin.
[Tailscale's app-connector guide](https://tailscale.com/docs/features/app-connectors/how-to/setup)
is the authority for current platform requirements and policy syntax.

## Private DHT lines

The channel home can accept resident agents from other machines over a shared Hyperswarm line. Create
one high-entropy line secret out of band; anyone holding it can discover the line and attempt the
authenticated peer handshake.

On the channel home:

```sh
codor --data-dir "$HOME/.codor" \
  up --static-root "$HOME/codor/packages/web/dist" \
  --join 'project-name:<high-entropy-secret>'
```

On a resident machine whose local harness credentials should execute remote turns:

```sh
codor --data-dir "$HOME/.codor-outpost" \
  serve --join 'project-name:<same-high-entropy-secret>'
```

Enroll the two switchboard identities before treating the line as trusted. The home remains the
only database, message-id authority, run journal, and ledger writer; an unreachable resident queues
deliveries at home instead of moving channel history to the outpost. Store line secrets with mode 600
and never put them in unit files, command transcripts, screenshots, or the repository.

## Optional relay and bridges

The open `relay/` workspace forwards sealed Web Push payloads and stores no queue or channel data.
Build its Dockerfile, configure a VAPID keypair and explicit sender allowlist outside the repository,
and pass only the relay URL and public VAPID key to `codor up`. The switchboard keeps channel and
device keys; the relay receives padded ciphertext.

Slack and Telegram bridges are separate opt-in processes in `packages/bridges/`. They require an
admin-or-owner Codor token plus platform tokens in environment variables. A bridged channel exports
readable content to that platform and permanently says so in every channel surface. Read
`docs/PRIVACY.md`, "Bridged channels: the one deliberate exception", and the repository's
`MANUAL-VERIFY.md` live checklist before enabling one.

## Back up and restore

The default data directory is `~/.codor`; override it with the global CLI `--data-dir` option or
`CODOR_DATA_DIR`. It contains the SQLite channel store, identity and channel keys, pairing records,
run blobs, resident journals, push subscriptions, and per-channel ledger vaults. Treat the whole
directory as one secret-bearing unit.

Stop the service before copying it so SQLite, run blobs, keys, and ledger files share one point in
time:

```sh
systemctl --user stop codor.service
umask 077
tar -C "$HOME" -czf "$HOME/codor-backup-$(date +%F).tar.gz" .codor
systemctl --user start codor.service
```

Encrypt the archive before moving it off the host. To restore, stop Codor, move any existing data
directory aside, extract the archive as the service user, confirm directories are mode 700 and
secret files are mode 600, then start the service. Do not merge two live homes or copy only the
SQLite file: message evidence, ledger notes, and cryptographic authority would diverge.

## Verify and upgrade

Run the same public smoke used by the fresh-clone test:

```sh
codor --data-dir "$HOME/.codor" channels
codor --data-dir "$HOME/.codor" \
  post -r desk 'self-host smoke'
codor --data-dir "$HOME/.codor" \
  tail -r desk --once
```

Before an upgrade, take a stopped backup. Then fetch the intended Git revision, run
`corepack pnpm install --frozen-lockfile && corepack pnpm -r build`, and restart. Never run a
moving branch directly as root.
<!-- harn:end fresh-clone-install-proven-by-script -->
