#!/usr/bin/env bash
set -Eeuo pipefail

# harn:assume packed-release-proof-runs-offline-runtime ref=packed-install-script
while IFS= read -r name; do
  unset "$name"
done < <(compgen -A variable | grep '^CODOR_' || true)

SOURCE_ROOT="${CODOR_PACKED_SOURCE:-$(git rev-parse --show-toplevel)}"
SOURCE_REF="${CODOR_PACKED_REF:-$(git -C "$SOURCE_ROOT" branch --show-current)}"
if [[ -z "$SOURCE_REF" ]]; then
  printf 'CODOR_PACKED_REF is required when the source checkout has detached HEAD\n' >&2
  exit 2
fi

IMAGE='node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3'
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/codor-packed-install.XXXXXX")"
CLONE_ROOT="$TEST_ROOT/source"
PROOF_ROOT="$TEST_ROOT/proof"

cleanup() {
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

git clone --quiet --single-branch --branch "$SOURCE_REF" "file://$SOURCE_ROOT" "$CLONE_ROOT"
mkdir -p "$PROOF_ROOT/install" "$PROOF_ROOT/home" "$PROOF_ROOT/data" \
  "$PROOF_ROOT/build-home" "$PROOF_ROOT/corepack-bin"

if find "$CLONE_ROOT" -type d \( -name node_modules -o -name dist -o -name artifact \) -print -quit | grep -q .; then
  printf 'packed proof clone inherited build or install output\n' >&2
  exit 1
fi

docker run --rm \
  --user "$(id -u):$(id -g)" \
  --env HOME=/proof/build-home \
  --mount "type=bind,src=$CLONE_ROOT,dst=/source" \
  --mount "type=bind,src=$PROOF_ROOT,dst=/proof" \
  "$IMAGE" bash -lc '
    set -Eeuo pipefail
    corepack enable --install-directory /proof/corepack-bin
    export PATH=/proof/corepack-bin:$PATH
    cd /source
    corepack pnpm install --frozen-lockfile
    corepack pnpm build:artifact
    cp packages/switchboard/test-fixtures/third-party-adapter.mjs /proof/third-party-adapter.mjs
    cd artifact/codor
    npm pack --pack-destination /proof >/proof/pack-name.txt
    TARBALL="/proof/$(tr -d "\r\n" </proof/pack-name.txt)"
    test -f "$TARBALL"
    cd /proof/install
    npm init -y >/dev/null
    npm install "$TARBALL"
    npm ls --all --omit=dev >/proof/npm-ls.txt
    npm install
  '

docker run --rm --network none \
  --mount "type=bind,src=$PROOF_ROOT,dst=/proof" \
  "$IMAGE" bash -s <<'PACKED_OFFLINE'
    set -Eeuo pipefail
    cd /proof/install
    export HOME=/proof/home
    export PROOF_TOKEN=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    BIN=./node_modules/.bin/codor
    DATA=/proof/data
    PORT=18137
    DAEMON_PID=""

    cleanup_daemon() {
      if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
        kill -TERM "$DAEMON_PID" 2>/dev/null || true
        wait "$DAEMON_PID" 2>/dev/null || true
      fi
    }
    trap cleanup_daemon EXIT

    node --input-type=module -e "
      import { pathToFileURL } from 'node:url';
      const entry = '/proof/install/node_modules/@richhardry/codor/node_modules/@codor/switchboard/dist/index.js';
      const loaded = await import(pathToFileURL(entry).href);
      if (Object.keys(loaded).length < 20) throw new Error('native switchboard did not load');
    "
    "$BIN" --help | grep -Fq "Usage: codor"

    DRY_RUN="$(npx --offline @richhardry/codor setup --dry-run)"
    grep -Fq "node_modules/@richhardry/codor/node_modules/@codor/cli/runtime/web" <<<"$DRY_RUN"
    grep -Fq "access localhost; skip Tailscale Serve" <<<"$DRY_RUN"
    if grep -q $'\033' <<<"$DRY_RUN"; then
      printf "packed dry-run emitted terminal control sequences\n" >&2
      exit 1
    fi

    set +e
    SETUP_ERROR="$("$BIN" setup --yes 2>&1 >/dev/null)"
    SETUP_STATUS=$?
    set -e
    [[ "$SETUP_STATUS" -eq 1 ]]
    [[ "$(printf "%s\n" "$SETUP_ERROR" | wc -l)" -eq 1 ]]
    grep -Fq "also requires --access" <<<"$SETUP_ERROR"
    if grep -Eq "[[:space:]]at[[:space:]]|node:internal|Unhandled" <<<"$SETUP_ERROR"; then
      printf "packed CLI failure leaked a stack\n" >&2
      exit 1
    fi

    CODOR_TOKEN="$PROOF_TOKEN" "$BIN" --data-dir "$DATA" up \
      --host 127.0.0.1 --port "$PORT" \
      --adapter housecat=/proof/third-party-adapter.mjs \
      --channel fresh --channel-name Fresh --owner proof \
      >/proof/daemon.log 2>&1 &
    DAEMON_PID=$!

    node --input-type=module -e "
      const origin = 'http://127.0.0.1:${PORT}';
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          const response = await fetch(origin + '/api/pairing/status');
          const body = await response.json();
          if (response.ok && typeof body.trusted_enrollment === 'boolean') process.exit(0);
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('packed daemon did not become ready');
    "

    "$BIN" --data-dir "$DATA" post -r fresh packed-runtime-smoke
    "$BIN" --data-dir "$DATA" tail -r fresh --once | grep -Fq packed-runtime-smoke

    node --input-type=module -e "
      const origin = 'http://127.0.0.1:${PORT}';
      const token = process.env.PROOF_TOKEN;
      const html = await (await fetch(origin + '/')).text();
      if (!html.includes('/codor-favicon.svg')) throw new Error('root is not packaged web-next');
      const script = html.match(/<script[^>]+src=\"([^\"]+\.js)\"/)?.[1];
      if (!script) throw new Error('app bundle reference missing');
      for (const path of [script, '/sw.js']) {
        const response = await fetch(origin + path);
        if (!response.ok || (await response.arrayBuffer()).byteLength < 100) {
          throw new Error('packaged browser asset failed: ' + path);
        }
      }
      const headers = { authorization: 'Bearer ' + token };
      const rooms = await (await fetch(origin + '/api/rooms', { headers })).json();
      if (!rooms.rooms?.some((room) => room.id === 'fresh')) throw new Error('room API smoke failed');
      const adapters = await (await fetch(origin + '/api/adapters', { headers })).json();
      if (!adapters.adapters?.some((adapter) => adapter.id === 'housecat')) {
        throw new Error('third-party packed adapter did not register');
      }
    "

    kill -TERM "$DAEMON_PID"
    wait "$DAEMON_PID"
    DAEMON_PID=""
PACKED_OFFLINE

TARBALL_NAME="$(tr -d '\r\n' <"$PROOF_ROOT/pack-name.txt")"
printf 'packed install passed: clean clone, build, %s, repeat install, offline setup, native daemon, browser, CLI, API, teardown\n' "$TARBALL_NAME"
# harn:end packed-release-proof-runs-offline-runtime
