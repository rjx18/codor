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

See the [self-host guide](/docs/SELF-HOST) for Tailscale, source-development fallback, manual
service operation, backup, and recovery.
<!-- harn:end public-npx-install-is-primary-install -->
