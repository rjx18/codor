# Setup

<!-- harn:assume public-npx-install-is-primary-install ref=setup-quickstart -->
With Node.js 22.12.0 or newer, install and configure Codor interactively:

```sh
npx @richhardry/codor install
```

The five stages check the host and installed coding agents, prepare private configuration, choose
localhost or Tailscale access, install the native per-user service, verify Codor is answering, and
create a ten-minute pairing QR, URL, and short code.

Use `npx @richhardry/codor install --dry-run` to inspect the service, harness-aware `PATH`, access
choice, and every proposed action without changing files or services. Noninteractive mutation must
name both intent and access:

```sh
npx @richhardry/codor install --yes --access localhost
```

`npx @richhardry/codor setup` remains available as a backward-compatible alias.

An installed launcher older than the first updater release cannot contain `codor update`. Bootstrap
that first update once through the official package:

```sh
npx --yes --package=@richhardry/codor@latest codor update
```

After that, Linux and macOS update to the current official stable release with:

```sh
codor update
```

Native Windows setup does not install a persistent `codor` launcher yet. Use the same official
npx command for every Windows update:

```sh
npx --yes --package=@richhardry/codor@latest codor update
```

The command is a no-op when the durable runtime is already current. Otherwise it acquires one
exact stable npm release, replaces the per-user service, and verifies that the new service
generation is answering before it succeeds. It preserves the operator token, relay identity,
pairings, channels, worktrees, presets, roster, agents, logs, and other data under `~/.codor`; no
manual restart is needed. If service verification fails, Codor restores the previous runtime and
reports whether that generation recovered. A source-linked launcher may update an existing durable
installation without changing the checkout. If no durable installation exists, use Git, install
dependencies, and rebuild the source checkout instead.

See the [self-host guide](/docs/SELF-HOST) for Tailscale, source-development fallback, manual
service operation, backup, and recovery.
<!-- harn:end public-npx-install-is-primary-install -->
