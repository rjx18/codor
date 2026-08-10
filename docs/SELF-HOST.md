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

<!-- harn:assume pnpm-install-docs-disclose-build-approval-boundaries ref=selfhost-pnpm-build-approval-disclosure -->
On pnpm 10.1–10.25, `better-sqlite3`'s native build script needs approval via
`onlyBuiltDependencies: [better-sqlite3]` in `pnpm-workspace.yaml` or the `package.json` `pnpm`
field. On pnpm 10.26 and newer (including pnpm 11), that setting is `allowBuilds: { better-sqlite3:
true }` in `pnpm-workspace.yaml`—`pnpm approve-builds` writes it interactively. Without approval,
`pnpm install` reports `Ignored build scripts: better-sqlite3` and the service fails to start with
no native binding. See [pnpm's settings reference](https://pnpm.io/settings) for the current option
names.
<!-- harn:end pnpm-install-docs-disclose-build-approval-boundaries -->

Never expose port 8137 directly to the public internet. The browser token is a bearer credential;
use loopback plus Tailscale Serve, another authenticated private tunnel, or a hardened reverse
proxy you operate.

<!-- harn:assume public-npx-install-is-primary-install ref=selfhost-primary-install -->
## Install

Install and start the complete local runtime:

```sh
npx @richhardry/codor install
```

The five-stage session checks the computer, prepares private files, chooses localhost or Tailscale,
installs the native per-user service, requires the Codor pairing-status response, and then prints a
QR, URL, eight-character code, and expiry. Use `npx @richhardry/codor install --dry-run` for a
side-effect-free preview. Unattended mutation requires both `--yes` and
`--access localhost|tailscale`; installation never guesses remote exposure from detection alone.
`npx @richhardry/codor setup` remains available as a backward-compatible alias.
<!-- harn:end public-npx-install-is-primary-install -->

<!-- harn:assume pnpm-install-docs-disclose-build-approval-boundaries ref=selfhost-pnpm-dlx-disclosure -->
On pnpm, install into a project (`pnpm add @richhardry/codor`) rather than
`pnpm dlx @richhardry/codor install`. A tested `pnpm dlx` install did not pick up the workspace
`packageExtensions` and native build-approval settings this install needs, including the
`better-sqlite3` approval above—`pnpm dlx` does honor some workspace configuration (for example
catalogs), but not this.
<!-- harn:end pnpm-install-docs-disclose-build-approval-boundaries -->

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
idempotent fallbacks; normal installation uses `npx @richhardry/codor install`.
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
codor install
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
```

The generated agent uses `RunAtLoad`, so a successful bootstrap starts it; an immediate
`kickstart -k` would unnecessarily replace that new process.

Do not install it as a root LaunchDaemon: that would change which home directory, project files,
and authenticated harness state the agents can access.

<!-- harn:assume windows-setup-installs-private-task-service ref=selfhost-native-windows-service -->
## Native Windows setup wizard

Run the same public setup command from PowerShell:

```powershell
npx @richhardry/codor install
```

Setup creates the private data and token paths, limits the token ACL to the current user, and
registers a hidden per-user Task Scheduler logon task named `Codor Switchboard`. The task runs the
installed CLI and its packaged browser runtime using absolute paths. Preview every action first
with `npx @richhardry/codor install --dry-run`.

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

For the common single-operator setup, keep Codor on loopback and let Tailscale terminate HTTPS.

<!-- harn:assume tailscale-serve-docs-disclose-certificate-transparency ref=selfhost-tailscale-certificate-disclosure -->
**Prerequisite:** HTTPS certificates must be enabled for your tailnet at
[the admin console](https://console.tailscale.com/admin/dns) before `tailscale serve` will work
non-interactively. Until that's done, `tailscale serve` blocks waiting for you to complete
enablement in a browser instead of returning—this is the cause if `codor install` appears to hang
at "configuring Tailscale". Enabling HTTPS **authorizes** certificate issuance for the tailnet, and
running `tailscale serve` (as `codor install` does) **issues** one: the device's fully qualified
`*.ts.net` name is written into the public Certificate Transparency log. Tailscale randomizes the
tailnet DNS name so the ledger doesn't reveal your organization, but device names are published as
chosen, and CT entries cannot be withdrawn. The feature itself is reversible—`tailscale serve reset`
or disabling HTTPS breaks reliance on it but does not revoke already-issued certificates—the public
disclosure is not. See
[Tailscale's HTTPS certificate docs](https://tailscale.com/docs/how-to/set-up-https-certificates)
for the full mechanism. Choosing localhost-only access during `codor install` skips Tailscale
entirely.
<!-- harn:end tailscale-serve-docs-disclose-certificate-transparency -->

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

## Hosted access through the blind relay

For access from anywhere without a VPN, the hosted browser app at codor.app can reach your
self-hosted switchboard through the Codor blind relay. The relay is a Cloudflare Worker that holds no
keys and cannot read pairing traffic, session traffic, or your channels; it forwards encrypted
payloads and sees only routing metadata — addresses, timing, sizes, and connection/room identifiers
(see `PLAN` §2.2, §4.1). It never replaces localhost or Tailscale; it is an additional path you opt
into, and each browser stays individually revocable.

Enable it on the switchboard host and pair one browser:

```sh
codor relay enable                 # targets relay.codor.app; override with a URL or CODOR_TUNNEL_URL
codor relay pair                   # prints a single-use code (ten-minute expiry)
codor relay status                 # enabled state, session id, and paired-device count
```

Open codor.app in the browser you want to enroll and enter the code. That browser runs the CPace
pairing and the session handshake with its own WebCrypto keys, so the relay never holds a key that
could open those frames — which is why using the shared `relay.codor.app` is safe even though you do
not operate it.
`codor relay rotate` issues a new session id (every paired browser must pair again) and
`codor relay disable` turns the path off. To avoid the shared relay entirely, deploy the MIT-licensed
Worker in `relay-worker/` to your own Cloudflare account and point `CODOR_TUNNEL_URL` at it.

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

Before an upgrade, take a stopped backup. A packaged installation updates to the current official
stable release with `codor update`. The command acquires an exact npm version without a shell,
atomically stages the durable runtime, replaces the existing per-user service generation, and
verifies that exact version before deleting its rollback copy. It does not rerun onboarding or
mint a pairing code, and it does not require a manual service restart. If the service cannot be
verified, Codor restores the previous runtime and attempts to reconverge it before failing.

For a source checkout, `codor update` refuses with Git guidance. Fetch the intended Git revision,
run `corepack pnpm install --frozen-lockfile && corepack pnpm -r build`, and restart the service
using the platform's ordinary manual lifecycle. Never run a moving branch directly as root. Close
and reopen an installed PWA once after a new static build lands so its service worker can take
control.
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

## One code, every door

The code from `codor pair` is universal: the **same** `XXXX-XXXX` pairs a browser
whether it reaches this switchboard directly (localhost, or across your Tailscale
network) or through the hosted app at codor.app over the blind relay. You do not pick
a "relay code" versus a "local code" — you paste one code into whichever browser you
are pairing, and it works.

Under the hood the code is a single pairing grant registered at both doors; consuming
either door burns it, so a code can pair exactly one browser once. If the relay is
unreachable when you run `codor pair`, the code degrades to local-only (LAN/Tailscale)
rather than failing — it still pairs a browser on your private network. The wire
mechanics are documented in the [relay protocol reference](RELAY-PROTOCOL.md).

## Multiple computers (hosted app)

When you use the hosted app at codor.app, it remembers **every** computer you have
paired, not just the last one. Each computer is its own switchboard reached over its
own tunnel; the app keeps their keys in separate namespaces, keeps those sessions
warm, and shows a switcher in the channel rail:

<!-- harn:assume hosted-add-computer-explains-pairing-code-source ref=guided-add-computer -->
- **Add a computer** — start with `codor pair` on the other machine. Copy the command
  from "Add a computer", then enter the printed eight-character code in the same dialog.
  It is single-use, expires after ten minutes, and travels through the existing private
  relay. The newly paired computer becomes active in place.
- **Switch** — pick a computer from the switcher to activate its already-warm session
  and tunnel in place, without a document reload. Connected, reconnecting, or repair
  status is shown honestly, and unread, attention, or working activity on inactive
  computers remains visible in the switcher. The most recently paired computer is the
  default on a fresh load.
- **Rename** — double-click a computer's name to give it a label (it defaults to
  "Computer 1", "Computer 2", …).
- **Forget** — remove a computer; the app falls back to the next one, or to the pairing
  screen when the last is forgotten.
<!-- harn:end hosted-add-computer-explains-pairing-code-source -->

Every switch and pairing is crash-safe: the app never presents one computer's identity
with another's channel keys, and switching between tabs cannot corrupt the stored set
(see the [relay protocol reference](RELAY-PROTOCOL.md)).
A self-hosted, switchboard-served browser (the direct path) pairs to one switchboard
and shows no switcher.

## Out of the box: `codor` on PATH and a universal first code

`npx @richhardry/codor install` sets both of these up for you, so a fresh machine is
ready without extra steps:

- **A `codor` command in your next shell.** Setup writes an executable launcher to
  `~/.local/bin/codor` pinned to the same Node the service runs. On macOS, where zsh
  omits `~/.local/bin` from PATH, setup appends a marked, idempotent block to
  `~/.zprofile` and tells you to open a new terminal; on Linux `~/.local/bin` is
  already on PATH. (Windows: add `~/.local/bin` to PATH yourself for now.)
- **A universal first code, by default.** Setup enables the blind relay before minting
  your first pairing code and mints it through the running daemon, so the printed code
  works at **codor.app** *and* on your network. If the relay is unreachable it degrades
  to a clearly-labelled local-only code rather than failing. Opt out with
  `codor install --no-relay` (or `codor relay disable` later) for a local-only setup;
  a `codor pair` run with the relay off says the code is local-only and how to enable it.

Node reaches the relay even on networks that reset the `relay.codor.app` name for
non-browser TLS: the switchboard automatically falls back to the `workers.dev` alias
and remembers whichever endpoint worked (see the [relay protocol reference](RELAY-PROTOCOL.md)).
