#!/usr/bin/env bash
set -Eeuo pipefail

# harn:assume global-cli-install-is-idempotent ref=per-user-cli-install-script
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRYPOINT="$ROOT/packages/cli/dist/index.js"
BIN_DIR="${HOME:?HOME is required}/.local/bin"
TARGET="$BIN_DIR/codor"

if [[ ! -f "$ENTRYPOINT" ]]; then
  printf 'CLI build is missing: run corepack pnpm --filter @codor/cli build first\n' >&2
  exit 1
fi

install -d "$BIN_DIR"
chmod 755 "$ENTRYPOINT"
ln -sfn "$ENTRYPOINT" "$TARGET"
printf 'installed %s -> %s\n' "$TARGET" "$ENTRYPOINT"
# harn:end global-cli-install-is-idempotent
