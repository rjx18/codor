# Self-host Codor

Run the switchboard, web app, adapters, and optional relay on machines you control. The channel
database, run evidence, ledger, and private keys stay in the data directory on the channel's home
machine. No hosted Codor component is required.

<!-- harn:assume fresh-clone-install-proven-by-script ref=selfhost-guide -->
## Prerequisites

- Linux, macOS, or native Windows with Node.js 22.12.0 or newer. Git and pnpm 10.9.0
  are needed only for source development. Linux and macOS also need `curl` and OpenSSL for the
  manual paths below.
- The harness CLIs you intend to use, installed and authenticated for the service user.
- pnpm 10.9.0, selected by the repository's `packageManager` field through Corepack.
- Optional: Tailscale for private HTTPS access from phones and other machines.

Never expose port 8137 directly to the public internet. The browser token is a bearer credential;
use loopback plus Tailscale Serve, another authenticated private tunnel, or a hardened reverse
proxy you operate.

<!-- harn:assume public-npx-setup-is-primary-install ref=selfhost-primary-install -->
## Install

Install and start the complete local runtime:

```sh
npx @richhardry/codor setup
```

The five-stage session checks the computer, prepares private files, chooses localhost or Tailscale,
installs the native per-user service, requires the Codor pairing-status response, and then prints a
QR, URL, eight-character code, and expiry. Use `npx @richhardry/codor setup --dry-run` for a
side-effect-free preview. Unattended mutation requires both `--yes` and
`--access localhost|tailscale`; setup never guesses remote exposure from detection alone.
<!-- harn:end public-npx-setup-is-primary-install -->

<!-- harn:assume source-cli-installers-remain-idempotent-fallback ref=selfhost-windows-cli-installer -->
For source development, clone a stable ref and use the checkout installer:

```sh
git clone https://github.com/rjx18/codor.git ~/codor
cd ~/codor
pnpm install --frozen-lockfile
pnpm -r build
scripts/install-cli.sh
```

On Windows, replace the last command with
`powershell -ExecutionPolicy Bypass -File scripts/install-cli.ps1`. Both checkout installers are
idempotent fallbacks; normal installation uses `npx @richhardry/codor setup`.
<!-- harn:end source-cli-installers-remain-idempotent-fallback -->

<!-- harn:assume operator-launches-serve-web-next ref=selfhost-current-web-client -->
The package carries the supported web-next build inside its private runtime; a source checkout uses
`packages/web-next/dist`. The CLI default and every generated platform service resolve the matching
location from the runtime that invoked setup. It contains the complete client and owned service
worker; there is no second browser workspace to build or deploy.
<!-- harn:end operator-launches-serve-web-next -->

The fresh-install test clones the selected repository ref over a local file URL so it cannot
borrow `node_modules`, build output, or untracked files from the working tree.

## Linux and macOS setup wizard

Run the one-shot wizard under the service user:

```sh
codor setup
```

The interactive session shows the five stages and asks for one access choice before mutation. It
creates `~/.config/codor` and `~/.codor` with mode 700, creates a mode-600 token if one is absent,
and installs the current platform's user service:

- On Linux, `~/.config/systemd/user/codor.service` plus a mode-600 environment file.
- On macOS, `~/Library/LaunchAgents/app.codor.switchboard.plist` plus private logs in
  `~/.codor/logs`. The plist is mode 600 because it contains the owner token.

Both services use the absolute current Node executable. Their explicit `PATH` includes
`~/.local/bin`, the Node bin directory, and the directory of every detected `claude`, `codex`,
`cursor-agent`, `agy`, `opencode`, `gemini`, or `copilot` executable, so nvm and shell-only harness
installs remain visible outside an interactive shell. Setup enables the service, verifies Codor's
pairing-status endpoint, optionally publishes loopback through Tailscale Serve, and generates a
ten-minute pairing URL, compact terminal QR, short code, and expiry.

Preview the complete action list and generated service content without writing files or invoking
system commands:

```sh
codor setup --dry-run
```

Open the single-use URL or scan the QR on the target browser. After pairing, the browser stores its
own keypair in origin-scoped IndexedDB and launches without a token query string. Generate another
offer later with `codor pair`; use `codor pair --no-qr` for plain output.

On macOS, inspect the running user agent and its logs with:

```sh
launchctl print "gui/$(id -u)/app.codor.switchboard"
tail -f "$HOME/.codor/logs/codor.err.log"
```

The LaunchAgent runs after login without a terminal window. It remains a user agent rather than a
root daemon because Codor and its harness subprocesses need that user's project files and harness
credentials.

## Foreground localhost for development

When you want a disposable foreground process on either Linux or macOS, create the private token
once and run the switchboard directly from the repository root:

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

Leave that terminal open. In a second terminal, load the token without printing it and issue a
single-use localhost pairing link:

```sh
export CODOR_TOKEN="$(tr -d '\n' < "$HOME/.config/codor/token")"
codor --data-dir "$HOME/.codor" pair \
  --endpoint http://127.0.0.1:8137
```

Open the printed URL on the same machine. Stop the foreground switchboard with `Ctrl+C`.

## Manual service appendix

The wizard is the primary path on both platforms. On Linux, the checked-in
`packaging/systemd/codor.service` is the manual user-service template. It assumes the checkout is
`~/codor` and the data directory is `~/.codor`; replace `/usr/bin/node` with the exact output of
`command -v node`, and write an explicit harness-aware `PATH=` in the environment file. An nvm-only
shell installation is unavailable to systemd without its absolute Node path.

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

On macOS, use `codor setup --dry-run` to inspect the exact generated plist before installing it.
The generated file resolves Node, the CLI entrypoint, web-next static root, data directory, logs,
owner token, and harness-aware `PATH` to explicit values. Current `launchctl` lifecycle commands are:

```sh
launchctl bootout "gui/$(id -u)/app.codor.switchboard"  # stop/unload; okay if absent
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/app.codor.switchboard.plist"
launchctl enable "gui/$(id -u)/app.codor.switchboard"
launchctl kickstart -k "gui/$(id -u)/app.codor.switchboard"
```

Do not install it as a root LaunchDaemon: that would change which home directory, project files,
and authenticated harness state the agents can access.

<!-- harn:assume windows-setup-installs-private-task-service ref=selfhost-native-windows-service -->
## Native Windows setup wizard

Run the same public setup command from PowerShell:

```powershell
npx @richhardry/codor setup
```

Setup creates the private data and token paths, limits the token ACL to the current user, and
registers a hidden per-user Task Scheduler logon task named `Codor Switchboard`. The task runs the
installed CLI and its packaged browser runtime using absolute paths. Preview every action first
with `npx @richhardry/codor setup --dry-run`.

```powershell
schtasks /Query /TN "Codor Switchboard"
schtasks /Run /TN "Codor Switchboard"
schtasks /End /TN "Codor Switchboard"
```

Logs are written to `%USERPROFILE%\.codor\logs\codor.out.log` and `codor.err.log`.

<!-- harn:assume windows-named-pipe-shares-local-websocket-protocol ref=selfhost-windows-local-transport -->
Native Windows uses a local named pipe derived from the resolved data directory in place of
`codor.sock`. This changes only the local CLI transport: the browser still opens
<http://127.0.0.1:8137>, and the wire protocol is unchanged.
<!-- harn:end windows-named-pipe-shares-local-websocket-protocol -->
<!-- harn:end windows-setup-installs-private-task-service -->

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
  up --static-root "$HOME/codor/packages/web-next/dist" \
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
time. On Linux:

```sh
systemctl --user stop codor.service
umask 077
tar -C "$HOME" -czf "$HOME/codor-backup-$(date +%F).tar.gz" .codor
systemctl --user start codor.service
```

On macOS:

```sh
launchctl bootout "gui/$(id -u)/app.codor.switchboard"
umask 077
tar -C "$HOME" -czf "$HOME/codor-backup-$(date +%F).tar.gz" .codor
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/app.codor.switchboard.plist"
launchctl kickstart -k "gui/$(id -u)/app.codor.switchboard"
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

Restart with `systemctl --user restart codor.service` on Linux or
`launchctl kickstart -k "gui/$(id -u)/app.codor.switchboard"` on macOS. Close and reopen an
installed PWA once after the new static build lands so its service worker can take control.
<!-- harn:end fresh-clone-install-proven-by-script -->

<!-- harn:assume agent-member-credentials-are-defense-in-depth ref=selfhost-agent-trust-boundary -->
## Agent credential and process boundary

Each owned agent member receives a fresh random credential when it is spawned, revived, or rebuilt
after a daemon restart. Codor stores only its SHA-256 digest. The raw value exists in that member's
in-memory session environment as `CODOR_MEMBER_TOKEN`; `CODOR_TOKEN` is set to the same value so the
adapter's environment merge masks, rather than leaks, the service's owner bearer. The credential is
valid only for that member's channel and explicit agent operations: read/subscribe, self-attributed
post, search, own-delivery consumption, own wait begin/end, and member status. It cannot configure
itself or perform channel or member administration. Do not print, journal, or copy either variable.

This is defense in depth for the default command path, **not containment**. Harness subprocesses run
as the service user's OS uid. That uid can read `~/.config/codor/token`, the project checkout,
authenticated harness state, and any filesystem or network resource allowed by the OS and selected
harness policy. A hostile process can therefore obtain wider authority despite the member
credential. Treat agents as trusted local programs. For an actual security boundary, run Codor or
the harness under a separate OS account, VM, or container with independently restricted files,
credentials, and network access.
<!-- harn:end agent-member-credentials-are-defense-in-depth -->

<!-- harn:assume pairing-codes-redacted-from-content ref=pairing-code-selfhost-docs -->
## Pairing Code Security

`codor pair` prints a single-use `XXXX-XXXX` code beside the URL and QR. The
code contains 40 bits of cryptographic randomness from an unambiguous
32-character alphabet, is case-insensitive, and may be entered with or without
the hyphen. It expires with the underlying pairing grant after ten minutes.

The URL and code are alternate credentials for one grant. Exchanging the code
burns it and invalidates the original URL token; completing the URL first also
invalidates the code. Invalid, expired, replayed, and rate-limited exchanges all
return the same 404 response, and failed exchanges do not burn a valid code.
The switchboard accepts at most five exchange attempts per client connection
identity in a rolling minute. Treat the displayed code as a secret until the
new browser finishes pairing.
<!-- harn:end pairing-codes-redacted-from-content -->
