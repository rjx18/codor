# Setup

The M0 boot-script workflow has been retired. Build and install the CLI, then use the one-shot
setup wizard documented in the [self-host guide](/docs/SELF-HOST):

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm -r build
scripts/install-cli.sh
codor setup
```

Use `codor setup --dry-run` to inspect the generated platform user service, explicit
harness-aware `PATH=`, and every proposed host action without changing files or services. The
wizard installs systemd on Linux and a per-user LaunchAgent on macOS; neither path requires a
foreground terminal.
