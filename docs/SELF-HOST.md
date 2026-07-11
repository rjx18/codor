# Self-host Wireroom

Run the switchboard, web app, adapters, and optional relay on machines you control. The room
database, run evidence, ledger, and private keys stay in the data directory on the room's home
machine. No hosted Wireroom component is required.

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
git clone <published-repository-url> ~/wireroom
cd ~/wireroom
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm -r build
```

Until the public repository URL exists, clone the local checkout with
`git clone file:///absolute/path/to/wireroom ~/wireroom`. The fresh-install test uses that exact
transport so it cannot borrow `node_modules`, build output, or untracked files.

Generate a token without printing it into shell history, then start one room on loopback:

```sh
install -d -m 700 ~/.config/wireroom ~/.wireroom
umask 077
openssl rand -hex 32 > ~/.config/wireroom/token
export WIREROOM_TOKEN="$(cat ~/.config/wireroom/token)"
node packages/cli/dist/index.js \
  --data-dir "$HOME/.wireroom" \
  up --static-root "$HOME/wireroom/packages/web/dist" \
  --room desk --room-name Desk
```

The command stays in the foreground and prints the loopback URL plus the private Unix socket.
Open `http://127.0.0.1:8137`, then create a ten-minute browser pairing link without putting the
bearer token in a URL:

```sh
node packages/cli/dist/index.js \
  --data-dir "$HOME/.wireroom" pair \
  --endpoint http://127.0.0.1:8137
```

Open the single-use link on the target browser. After pairing, the browser stores its own keypair
in origin-scoped IndexedDB and launches without a token query string.

## Run with systemd

The checked-in `packaging/systemd/wireroom.service` is a user-service template. It assumes the
checkout is `~/wireroom`, Node is `/usr/bin/node`, and the data directory is `~/.wireroom`. Check
`command -v node` and edit `ExecStart` if your installation uses a different path. An nvm-only
shell installation is not available to systemd unless you provide its absolute Node path.

```sh
install -d -m 700 ~/.config/wireroom ~/.config/systemd/user
install -m 600 packaging/systemd/wireroom.service ~/.config/systemd/user/wireroom.service
printf 'WIREROOM_TOKEN=%s\n' "$(cat ~/.config/wireroom/token)" > ~/.config/wireroom/env
chmod 600 ~/.config/wireroom/env
systemctl --user daemon-reload
systemctl --user enable --now wireroom.service
systemctl --user status wireroom.service
```

Use `loginctl enable-linger "$USER"` if the user service must start at boot before an interactive
login. The service has a restrictive umask but deliberately retains access to the operator's
projects and authenticated harness CLIs; those subprocesses are the work being hosted.

## Private access with Tailscale

For the common single-operator setup, keep Wireroom on loopback and let Tailscale terminate HTTPS:

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

Auto-pairing is opt-in with `wireroom up --trust-tailscale-serve` or
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
tailscale up --advertise-connector --advertise-tags=tag:wireroom-connector
```

Follow Tailscale's current app-connector setup guide for the required `tagOwners`, `autoApprovers`,
`grants`, and `nodeAttrs` policy entries. Restrict the origin to connector egress addresses where
possible, and keep Wireroom's device pairing as a second boundary. For a personal installation,
prefer Serve; it has fewer moving parts and does not require a public origin.
[Tailscale's app-connector guide](https://tailscale.com/docs/features/app-connectors/how-to/setup)
is the authority for current platform requirements and policy syntax.

## Private DHT lines

The room home can accept resident agents from other machines over a shared Hyperswarm line. Create
one high-entropy line secret out of band; anyone holding it can discover the line and attempt the
authenticated peer handshake.

On the room home:

```sh
node packages/cli/dist/index.js \
  --data-dir "$HOME/.wireroom" \
  up --static-root "$HOME/wireroom/packages/web/dist" \
  --join 'project-name:<high-entropy-secret>'
```

On a resident machine whose local harness credentials should execute remote turns:

```sh
node packages/cli/dist/index.js \
  --data-dir "$HOME/.wireroom-outpost" \
  serve --join 'project-name:<same-high-entropy-secret>'
```

Enroll the two switchboard identities before treating the line as trusted. The home remains the
only database, message-id authority, run journal, and ledger writer; an unreachable resident queues
deliveries at home instead of moving room history to the outpost. Store line secrets with mode 600
and never put them in unit files, command transcripts, screenshots, or the repository.

## Optional relay and bridges

The open `relay/` workspace forwards sealed Web Push payloads and stores no queue or room data.
Build its Dockerfile, configure a VAPID keypair and explicit sender allowlist outside the repository,
and pass only the relay URL and public VAPID key to `wireroom up`. The switchboard keeps room and
device keys; the relay receives padded ciphertext.

Slack and Telegram bridges are separate opt-in processes in `packages/bridges/`. They require an
admin-or-owner Wireroom token plus platform tokens in environment variables. A bridged room exports
readable content to that platform and permanently says so in every room surface. Read
`docs/PRIVACY.md`, "Bridged rooms: the one deliberate exception", and the repository's
`MANUAL-VERIFY.md` live checklist before enabling one.

## Back up and restore

The default data directory is `~/.wireroom`; override it with the global CLI `--data-dir` option or
`WIREROOM_DATA_DIR`. It contains the SQLite room store, identity and room keys, pairing records,
run blobs, resident journals, push subscriptions, and per-room ledger vaults. Treat the whole
directory as one secret-bearing unit.

Stop the service before copying it so SQLite, run blobs, keys, and ledger files share one point in
time:

```sh
systemctl --user stop wireroom.service
umask 077
tar -C "$HOME" -czf "$HOME/wireroom-backup-$(date +%F).tar.gz" .wireroom
systemctl --user start wireroom.service
```

Encrypt the archive before moving it off the host. To restore, stop Wireroom, move any existing data
directory aside, extract the archive as the service user, confirm directories are mode 700 and
secret files are mode 600, then start the service. Do not merge two live homes or copy only the
SQLite file: message evidence, ledger notes, and cryptographic authority would diverge.

## Verify and upgrade

Run the same public smoke used by the fresh-clone test:

```sh
node packages/cli/dist/index.js --data-dir "$HOME/.wireroom" rooms
node packages/cli/dist/index.js --data-dir "$HOME/.wireroom" \
  post -r desk 'self-host smoke'
node packages/cli/dist/index.js --data-dir "$HOME/.wireroom" \
  tail -r desk --once
```

Before an upgrade, take a stopped backup. Then fetch the intended Git revision, run
`corepack pnpm install --frozen-lockfile && corepack pnpm -r build`, and restart. Never run a
moving branch directly as root.
<!-- harn:end fresh-clone-install-proven-by-script -->
