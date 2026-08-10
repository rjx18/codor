#!/usr/bin/env bash
set -Eeuo pipefail

# harn:assume packed-release-proof-runs-install-runtime ref=packed-install-script
SOURCE_ROOT="${CODOR_PACKED_SOURCE:-$(git rev-parse --show-toplevel)}"
SOURCE_REF="${CODOR_PACKED_REF:-$(git -C "$SOURCE_ROOT" branch --show-current)}"

while IFS= read -r name; do
  unset "$name"
done < <(compgen -A variable | grep '^CODOR_' || true)

if [[ -z "$SOURCE_REF" ]]; then
  printf 'CODOR_PACKED_REF is required when the source checkout has detached HEAD\n' >&2
  exit 2
fi

IMAGE='node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3'
GIT_RUNTIME_IMAGE='node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a'
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

docker run --rm -i \
  --user "$(id -u):$(id -g)" \
  --env HOME=/proof/build-home \
  --mount "type=bind,src=$CLONE_ROOT,dst=/source" \
  --mount "type=bind,src=$PROOF_ROOT,dst=/proof" \
  "$IMAGE" bash -s <<'PACKED_NETWORK'
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
    # Prove Richard exact operator invocation (#434): run the CLI straight from
    # the local tarball absolute path via --package, from a directory with no
    # local codor, so the tarball an operator downloads is what dispatches. This
    # runs with network on because the tarball bundles only the @codor/* closure;
    # its third-party and native dependencies resolve from the registry here just
    # as they do on the operator machine.
    cd /proof
    # harn:assume packed-local-tgz-npx-proof-runs-fresh-default-audit ref=packed-npx-fresh-default-audit-proof
    # Keep this cache distinct from the earlier npm install. The first exact
    # local-TGZ npx invocation must therefore perform its normal install-time
    # audit instead of inheriting registry/advisory state from a warm proof.
    NPX_PROOF_CACHE=/proof/npx-audit-cache
    test ! -e "$NPX_PROOF_CACHE"
    mkdir -p "$NPX_PROOF_CACHE"
    export npm_config_cache="$NPX_PROOF_CACHE"
    PACKAGED_DRY_RUN="$(npx --yes --package="$TARBALL" codor install --dry-run)"
    grep -Fq "access localhost; skip Tailscale Serve" <<<"$PACKAGED_DRY_RUN"
    grep -Fq "[dry-run] wait for Codor pairing status" <<<"$PACKAGED_DRY_RUN"
    PACKAGED_WARM_DRY_RUN="$(npx --yes --package="$TARBALL" codor install --dry-run)"
    [[ "$PACKAGED_WARM_DRY_RUN" == "$PACKAGED_DRY_RUN" ]]
    # harn:assume packed-update-bootstrap-crosses-real-candidate-transaction ref=packed-update-transaction-proof
    # Prove the first updater release through the real public npx command, not
    # only --help. A controlled npm shim preserves production argv and registry
    # validation while installing this exact local candidate TGZ; fake user
    # services expose the authenticated generation endpoint without touching the
    # host running this container.
    UPDATE_HOME=/proof/update-home
    UPDATE_DATA=/proof/update-data
    UPDATE_BIN=/proof/update-bin
    UPDATE_NPM_LOG=/proof/update-npm.log
    mkdir -p "$UPDATE_HOME/.config/codor" "$UPDATE_DATA" "$UPDATE_BIN"
    printf "operator-token\n" >"$UPDATE_HOME/.config/codor/token"
    chmod 600 "$UPDATE_HOME/.config/codor/token"
    cp -a /proof/install "$UPDATE_DATA/runtime"
    CANDIDATE_VERSION="$(node -p "require('/proof/install/node_modules/@richhardry/codor/package.json').version")"
    PREVIOUS_VERSION="$(node -e "const [a,b,c]=process.argv[1].split('.').map(Number); console.log([a,b,Math.max(0,c-1)].join('.'))" "$CANDIDATE_VERSION")"
    node -e "const fs=require('fs'); const p=process.argv[1]; const v=JSON.parse(fs.readFileSync(p)); v.version=process.argv[2]; fs.writeFileSync(p, JSON.stringify(v))" \
      "$UPDATE_DATA/runtime/node_modules/@richhardry/codor/package.json" "$PREVIOUS_VERSION"
    cat >"$UPDATE_BIN/npm" <<'UPDATE_NPM'
#!/bin/sh
set -eu
printf '%s\n' "$*" >>"$UPDATE_NPM_LOG"
case "${1:-}" in
  view)
    case "$*" in
      *"@richhardry/codor@latest version --json"*"--registry https://registry.npmjs.org/"*"--@richhardry:registry=https://registry.npmjs.org/"*) ;;
      *) printf 'unexpected official lookup argv: %s\n' "$*" >&2; exit 2 ;;
    esac
    printf '"%s"\n' "$CANDIDATE_VERSION"
    ;;
  install)
    prefix=''
    previous=''
    for argument in "$@"; do
      if [ "$previous" = '--prefix' ]; then prefix="$argument"; fi
      previous="$argument"
    done
    test -n "$prefix"
    case "$*" in
      *"--registry https://registry.npmjs.org/"*"--@richhardry:registry=https://registry.npmjs.org/"*"@richhardry/codor@$CANDIDATE_VERSION"*) ;;
      *) printf 'unexpected official acquisition argv: %s\n' "$*" >&2; exit 2 ;;
    esac
    exec "$REAL_NPM" install --prefix "$prefix" --ignore-scripts --no-audit --no-fund --no-package-lock --no-save "$PROOF_UPDATE_TARBALL"
    ;;
  *) printf 'unexpected npm command: %s\n' "$*" >&2; exit 2 ;;
esac
UPDATE_NPM
    cat >"$UPDATE_BIN/systemctl" <<'UPDATE_SYSTEMCTL'
#!/bin/sh
set -eu
if [ "${2:-}" = 'restart' ]; then
  if [ -f "$UPDATE_DATA/service.pid" ]; then
    kill "$(cat "$UPDATE_DATA/service.pid")" 2>/dev/null || true
  fi
  version="$(sed -n 's/^CODOR_RUNTIME_VERSION=//p' "$UPDATE_HOME/.config/codor/env")"
  generation="$(sed -n 's/^CODOR_SERVICE_GENERATION=//p' "$UPDATE_HOME/.config/codor/env")"
  nohup "$REAL_NODE" "$UPDATE_BIN/runtime-server.mjs" "$version" "$generation" >"$UPDATE_DATA/service.log" 2>&1 &
  printf '%s\n' "$!" >"$UPDATE_DATA/service.pid"
  sleep 0.1
  if ! kill -0 "$!" 2>/dev/null; then
    cat "$UPDATE_DATA/service.log" >&2
    exit 1
  fi
fi
UPDATE_SYSTEMCTL
    cat >"$UPDATE_BIN/loginctl" <<'UPDATE_LOGINCTL'
#!/bin/sh
printf 'yes\n'
UPDATE_LOGINCTL
    cat >"$UPDATE_BIN/runtime-server.mjs" <<'UPDATE_SERVER'
import { createServer } from 'node:http';
const [version, generation] = process.argv.slice(2);
createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/api/pairing/status') {
    response.end(JSON.stringify({ trusted_enrollment: false }));
    return;
  }
  if (request.url === '/api/runtime/status' && request.headers.authorization === 'Bearer operator-token') {
    response.end(JSON.stringify({ version, generation }));
    return;
  }
  response.statusCode = 404;
  response.end('{}');
}).listen(8137, '127.0.0.1');
UPDATE_SERVER
    chmod 755 "$UPDATE_BIN/npm" "$UPDATE_BIN/systemctl" "$UPDATE_BIN/loginctl"
    export CANDIDATE_VERSION PROOF_UPDATE_TARBALL="$TARBALL" REAL_NPM="$(command -v npm)" REAL_NODE="$(command -v node)"
    export UPDATE_BIN UPDATE_DATA UPDATE_HOME UPDATE_NPM_LOG
    PACKAGED_UPDATE="$(HOME="$UPDATE_HOME" PATH="$UPDATE_BIN:$PATH" npx --yes --package="$TARBALL" codor --data-dir "$UPDATE_DATA" update)"
    grep -Fq "Codor updated from $PREVIOUS_VERSION to $CANDIDATE_VERSION" <<<"$PACKAGED_UPDATE"
    test "$(node -p "require('$UPDATE_DATA/runtime/node_modules/@richhardry/codor/package.json').version")" = "$CANDIDATE_VERSION"
    test ! -e "$UPDATE_DATA/runtime.backup"
    grep -Fq "view @richhardry/codor@latest version --json" "$UPDATE_NPM_LOG"
    grep -Fq "install --prefix" "$UPDATE_NPM_LOG"
    kill "$(cat "$UPDATE_DATA/service.pid")"
    wait "$(cat "$UPDATE_DATA/service.pid")" 2>/dev/null || true
    # harn:end packed-update-bootstrap-crosses-real-candidate-transaction
    # harn:end packed-local-tgz-npx-proof-runs-fresh-default-audit
    # Durability: the install copies a durable runtime, and the rendered service
    # ExecStart references that ~/.codor/runtime copy, never the ephemeral npx
    # cache the CLI is invoked from.
    grep -Fq "install a durable Codor runtime" <<<"$PACKAGED_DRY_RUN"
    PACKAGED_EXEC="$(grep -m1 "ExecStart=" <<<"$PACKAGED_DRY_RUN" || true)"
    grep -Fq ".codor/runtime" <<<"$PACKAGED_EXEC"
    if grep -q "_npx" <<<"$PACKAGED_EXEC"; then
      printf "packed install would point the service ExecStart at the npx cache\n" >&2
      exit 1
    fi
    # Non-dry-run must dispatch into the non-TTY unattended guard, not merely
    # parse: install --yes with no --access exits non-zero naming the flag.
    set +e
    PACKAGED_GUARD="$(npx --yes --package="$TARBALL" codor install --yes 2>&1 >/dev/null)"
    PACKAGED_GUARD_STATUS=$?
    set -e
    [[ "$PACKAGED_GUARD_STATUS" -ne 0 ]]
    grep -Fq "also requires --access" <<<"$PACKAGED_GUARD"
    if grep -Eq "[[:space:]]at[[:space:]]|node:internal|Unhandled" <<<"$PACKAGED_GUARD"; then
      printf "packed install guard leaked a stack\n" >&2
      exit 1
    fi
PACKED_NETWORK

docker run --rm --network none \
  --mount "type=bind,src=$PROOF_ROOT,dst=/proof" \
  "$GIT_RUNTIME_IMAGE" bash -s <<'PACKED_OFFLINE'
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

    assert_json() {
      local value="$1"
      [[ "$(printf '%s\n' "$value" | wc -l)" -eq 1 ]]
      JSON_TO_CHECK="$value" node --input-type=module -e "JSON.parse(process.env.JSON_TO_CHECK)"
    }
    assert_safe() {
      local value="$1"
      if grep -Fq "$PROOF_TOKEN" <<<"$value" ||
        grep -Eq '"(acp_launch|acp_executable|acp_arg|executable|argv|session_ref|host|git_admin_id|primary_git_admin_id|common_path|room_key|sealed_key)"[[:space:]]*:' <<<"$value"; then
        printf "packed management output leaked credentials or private fields\n" >&2
        exit 1
      fi
    }

    # harn:assume structured-management-help-and-docs-are-complete ref=packed-management-help-regression
    ROOT_HELP="$("$BIN" --help)"
    assert_safe "$ROOT_HELP"
    for family in channel agent agent-preset default-roster worktree; do
      grep -Fq "codor $family --help" <<<"$ROOT_HELP"
    done
    for family in channel agent agent-preset default-roster worktree; do
      "$BIN" "$family" --help >/proof/"$family"-help.out
    done
    grep -Fq "archive is soft retention only" /proof/channel-help.out || grep -Fq "Archive is soft retention only" /proof/channel-help.out
    grep -Fq "Agent add selects exactly one public adapter or preset" /proof/agent-help.out
    grep -Fq "individual reusable preset CRUD" /proof/agent-preset-help.out
    grep -Fq "ordered roster" /proof/default-roster-help.out
    grep -Fq "Worktree add requires --create or --adopt" /proof/worktree-help.out
    for help_file in /proof/*-help.out; do
      assert_safe "$(<"$help_file")"
    done
    PACKAGED_README=/proof/install/node_modules/@richhardry/codor/README.md
    test -f "$PACKAGED_README"
    grep -Fq "### Structured management" "$PACKAGED_README"
    grep -Fq "npx @richhardry/codor install" "$PACKAGED_README"
    # harn:end structured-management-help-and-docs-are-complete

    DRY_RUN="$("$BIN" install --dry-run)"
    grep -Fq "node_modules/@richhardry/codor/node_modules/@codor/cli/runtime/web" <<<"$DRY_RUN"
    grep -Fq "access localhost; skip Tailscale Serve" <<<"$DRY_RUN"
    if grep -q $'\033' <<<"$DRY_RUN"; then
      printf "packed dry-run emitted terminal control sequences\n" >&2
      exit 1
    fi

    set +e
    SETUP_ERROR="$("$BIN" install --yes 2>&1 >/dev/null)"
    SETUP_STATUS=$?
    set -e
    [[ "$SETUP_STATUS" -eq 1 ]]
    [[ "$(printf "%s\n" "$SETUP_ERROR" | wc -l)" -eq 1 ]]
    grep -Fq "also requires --access" <<<"$SETUP_ERROR"
    if grep -Eq "[[:space:]]at[[:space:]]|node:internal|Unhandled" <<<"$SETUP_ERROR"; then
      printf "packed CLI failure leaked a stack\n" >&2
      exit 1
    fi

    # The user-facing launcher: a real unattended install writes an executable
    # ~/.local/bin/codor. The Install step runs before the service Start that this
    # offline container cannot complete, so the install exits non-zero yet the launcher
    # is already on disk — and it runs the packaged CLI end to end.
    set +e
    "$BIN" install --yes --access localhost >/proof/launcher-setup.log 2>&1
    set -e
    if [[ ! -x "$HOME/.local/bin/codor" ]]; then
      printf "packed install did not write an executable ~/.local/bin/codor launcher\n" >&2
      cat /proof/launcher-setup.log >&2 || true
      exit 1
    fi
    "$HOME/.local/bin/codor" --help | grep -Fq "Usage: codor"

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

    # harn:assume structured-channel-cli-preserves-flat-listing ref=structured-channel-packed-smoke
    # harn:assume management-failures-have-stable-redacted-exits ref=packed-management-failure-regression
    CREATED_CHANNEL="$("$BIN" --data-dir "$DATA" channel create "Packed Channel" --owner proof --id packed --json)"
    grep -Fq '"id":"packed"' <<<"$CREATED_CHANNEL"
    RENAMED_CHANNEL="$("$BIN" --data-dir "$DATA" channel rename packed "Packed Renamed" --json)"
    grep -Fq '"name":"Packed Renamed"' <<<"$RENAMED_CHANNEL"
    set +e
    MISSING_CHANNEL="$("$BIN" --data-dir "$DATA" channel show missing-channel --json 2>/proof/missing-channel.out)"
    MISSING_STATUS=$?
    set -e
    [[ "$MISSING_STATUS" -eq 5 ]]
    [[ -z "$MISSING_CHANNEL" ]]
    [[ "$(wc -l </proof/missing-channel.out)" -eq 1 ]]
    if grep -Eq "[[:space:]]at[[:space:]]|node:internal|Unhandled|PROOF_TOKEN|0123456789abcdef" /proof/missing-channel.out; then
      printf "packed management failure leaked a stack or secret\n" >&2
      exit 1
    fi
    set +e
    INVALID_CHANNEL="$($BIN --data-dir "$DATA" channel create "Invalid Owner" --owner "bad handle" --json 2>/proof/invalid-channel.out)"
    INVALID_STATUS=$?
    set -e
    [[ "$INVALID_STATUS" -eq 2 ]]
    [[ -z "$INVALID_CHANNEL" ]]
    [[ "$(wc -l </proof/invalid-channel.out)" -eq 1 ]]
    if grep -Eq "[[:space:]]at[[:space:]]|node:internal|Unhandled|PROOF_TOKEN|0123456789abcdef" /proof/invalid-channel.out; then
      printf "packed invocation failure leaked a stack or secret\n" >&2
      exit 1
    fi
    # harn:assume structured-worktree-cli-uses-accepted-lifecycle ref=worktree-packed-smoke
    WORKTREE_LIST="$($BIN --data-dir "$DATA" --url "http://127.0.0.1:${PORT}" --token "$PROOF_TOKEN" \
      worktree list --channel fresh --json)"
    [[ "$(printf "%s\n" "$WORKTREE_LIST" | wc -l)" -eq 1 ]]
    grep -Fq '"repository":null' <<<"$WORKTREE_LIST"
    if grep -Eq 'PROOF_TOKEN|0123456789abcdef|git_admin_id|common_path|room_key|sealed_key' <<<"$WORKTREE_LIST"; then
      printf "packed worktree listing leaked private identity or credentials\n" >&2
      exit 1
    fi
    # harn:assume worktree-cli-removal-requires-previewed-consent ref=worktree-removal-packed-smoke
    set +e
    WORKTREE_CREATE="$($BIN --data-dir "$DATA" --url "http://127.0.0.1:${PORT}" --token "$PROOF_TOKEN" \
      worktree add --channel fresh --create --path /proof/not-a-worktree --alias packed-child --branch packed-branch --json \
      2>/proof/worktree-create.out)"
    WORKTREE_CREATE_STATUS=$?
    set -e
    [[ "$WORKTREE_CREATE_STATUS" -eq 6 ]]
    [[ -z "$WORKTREE_CREATE" ]]
    [[ "$(wc -l </proof/worktree-create.out)" -eq 1 ]]
    set +e
    WORKTREE_ADD="$($BIN --data-dir "$DATA" --url "http://127.0.0.1:${PORT}" --token "$PROOF_TOKEN" \
      worktree add --channel fresh --path /proof/not-a-worktree 2>/proof/worktree-add.out)"
    WORKTREE_ADD_STATUS=$?
    set -e
    [[ "$WORKTREE_ADD_STATUS" -eq 2 ]]
    [[ -z "$WORKTREE_ADD" ]]
    [[ "$(wc -l </proof/worktree-add.out)" -eq 1 ]]
    set +e
    WORKTREE_REMOVE="$($BIN --data-dir "$DATA" --url "http://127.0.0.1:${PORT}" --token "$PROOF_TOKEN" \
      worktree remove missing-worktree --channel fresh --yes --json 2>/proof/worktree-remove.out)"
    WORKTREE_REMOVE_STATUS=$?
    set -e
    [[ "$WORKTREE_REMOVE_STATUS" -eq 5 ]]
    [[ -z "$WORKTREE_REMOVE" ]]
    [[ "$(wc -l </proof/worktree-remove.out)" -eq 1 ]]
    if grep -Eq '[[:space:]]at[[:space:]]|node:internal|Unhandled|PROOF_TOKEN|0123456789abcdef|git_admin_id|common_path' \
      /proof/worktree-create.out /proof/worktree-add.out /proof/worktree-remove.out; then
      printf "packed worktree failure leaked a stack, secret, or private identity\n" >&2
      exit 1
    fi
    # harn:end worktree-cli-removal-requires-previewed-consent
    # harn:end structured-worktree-cli-uses-accepted-lifecycle
    "$BIN" --data-dir "$DATA" channel archive packed --yes --json | grep -Fq '"status":"archived"'
    DEFAULT_CHANNELS="$("$BIN" --data-dir "$DATA" channel list --json)"
    if grep -Fq '"id":"packed"' <<<"$DEFAULT_CHANNELS"; then
      printf "packed archived channel remained in default discovery\n" >&2
      exit 1
    fi
    ALL_CHANNELS="$("$BIN" --data-dir "$DATA" channel list --all --json)"
    grep -Fq '"id":"packed"' <<<"$ALL_CHANNELS"
    # harn:end management-failures-have-stable-redacted-exits
    # harn:end structured-channel-cli-preserves-flat-listing

    # harn:assume structured-preset-and-roster-cli-is-safe-and-ordered ref=agent-preset-packed-smoke
    # harn:assume channel-cli-selects-one-initial-agent-mode ref=channel-create-initial-agent-packed-smoke
    PRESET_CWD=/proof/preset-cwd
    mkdir -p "$PRESET_CWD"
    PRESET_JSON="$($BIN --data-dir "$DATA" agent-preset create "Packed Helper" \
      --handle packed-helper --adapter housecat --policy workspace-write --json)"
    grep -Fq '"adapter":"housecat"' <<<"$PRESET_JSON"
    if grep -Eq 'acp_launch|executable|argv|PROOF_TOKEN|0123456789abcdef' <<<"$PRESET_JSON"; then
      printf "packed preset output leaked launch material or credentials\n" >&2
      exit 1
    fi
    PRESET_ID="$(PRESET_JSON="$PRESET_JSON" node --input-type=module -e \
      "console.log(JSON.parse(process.env.PRESET_JSON).id)")"
    UPDATED_PRESET="$($BIN --data-dir "$DATA" agent-preset update "$PRESET_ID" \
      --label "Packed Helper Updated" --handle packed-helper-updated --adapter housecat --json)"
    grep -Fq '"label":"Packed Helper Updated"' <<<"$UPDATED_PRESET"
    if grep -Fq '"policy"' <<<"$UPDATED_PRESET"; then
      printf "packed preset full replacement retained an omitted policy\n" >&2
      exit 1
    fi
    ROSTER_JSON="$($BIN --data-dir "$DATA" default-roster set "$PRESET_ID" --json)"
    grep -Fq "\"preset_ids\":[\"$PRESET_ID\"]" <<<"$ROSTER_JSON"
    [[ "$($BIN --data-dir "$DATA" default-roster show)" == $'0\t'"$PRESET_ID" ]]
    ROSTER_CHANNEL="$($BIN --data-dir "$DATA" channel create "Packed Roster" --owner proof \
      --id packed-roster --cwd "$PRESET_CWD" --default-roster --json)"
    grep -Fq '"id":"packed-roster"' <<<"$ROSTER_CHANNEL"
    grep -Fq '"handle":"packed-helper-updated"' \
      <<<"$($BIN --data-dir "$DATA" agent list --channel packed-roster --json)"
    PRESET_AGENT="$($BIN --data-dir "$DATA" agent add --channel fresh --preset "$PRESET_ID" \
      --cwd "$PRESET_CWD" --purpose packed-preset-add --json)"
    grep -Fq '"handle":"packed-helper-updated"' <<<"$PRESET_AGENT"
    grep -Fq '"purpose":"packed-preset-add"' <<<"$PRESET_AGENT"
    if grep -Eq 'preset_id|session_ref|acp_launch|executable|argv|PROOF_TOKEN|0123456789abcdef' <<<"$PRESET_AGENT"; then
      printf "packed preset add leaked source or launch material\n" >&2
      exit 1
    fi
    set +e
    REFERENCED_PRESET="$($BIN --data-dir "$DATA" agent-preset delete "$PRESET_ID" --json 2>/proof/preset-delete.out)"
    REFERENCED_STATUS=$?
    set -e
    [[ "$REFERENCED_STATUS" -eq 6 ]]
    [[ -z "$REFERENCED_PRESET" ]]
    [[ "$(wc -l </proof/preset-delete.out)" -eq 1 ]]
    grep -Fq 'referenced' /proof/preset-delete.out
    ROSTER_CLEAR="$($BIN --data-dir "$DATA" default-roster set --json)"
    grep -Fq '"preset_ids":[]' <<<"$ROSTER_CLEAR"
    DELETED_PRESET="$($BIN --data-dir "$DATA" agent-preset delete "$PRESET_ID" --yes --json)"
    grep -Fq "\"id\":\"$PRESET_ID\"" <<<"$DELETED_PRESET"
    grep -Fq '"deleted":true' <<<"$DELETED_PRESET"
    if grep -Eq 'PROOF_TOKEN|0123456789abcdef|acp_launch|executable|argv' <<<"$DELETED_PRESET"; then
      printf "packed preset delete output leaked secret material\n" >&2
      exit 1
    fi
    # harn:end channel-cli-selects-one-initial-agent-mode
    # harn:end structured-preset-and-roster-cli-is-safe-and-ordered

    # harn:assume agent-add-selects-public-adapter-or-detached-preset ref=agent-add-packed-smoke
    # harn:assume structured-agent-cli-preserves-flat-lifecycle-and-presets ref=structured-agent-packed-smoke
    # harn:assume agent-management-does-not-invent-work ref=agent-management-packed-no-turn
    AGENT_CWD=/proof/agent-cwd
    mkdir -p "$AGENT_CWD"
    ADDED_AGENT="$($BIN --data-dir "$DATA" agent add worker --channel fresh --adapter housecat --cwd "$AGENT_CWD" --json)"
    grep -Fq '"handle":"worker"' <<<"$ADDED_AGENT"
    grep -Fq '"adapter":"housecat"' <<<"$ADDED_AGENT"
    grep -Fq '"policy":"read-only"' <<<"$ADDED_AGENT"
    CONFIGURED_AGENT="$($BIN --data-dir "$DATA" agent configure worker --channel fresh --model packed-model --json)"
    grep -Fq '"model":"packed-model"' <<<"$CONFIGURED_AGENT"
    RENAMED_AGENT="$($BIN --data-dir "$DATA" agent rename worker worker-renamed --channel fresh --name 'Packed Worker' --json)"
    grep -Fq '"handle":"worker-renamed"' <<<"$RENAMED_AGENT"
    PAUSED_AGENT="$($BIN --data-dir "$DATA" agent pause worker-renamed --channel fresh --json)"
    grep -Fq '"status":"paused"' <<<"$PAUSED_AGENT"
    REVIVED_AGENT="$($BIN --data-dir "$DATA" agent revive worker-renamed --channel fresh --json)"
    grep -Fq '"status":"idle"' <<<"$REVIVED_AGENT"
    set +e
    UNCONFIRMED_REMOVE="$($BIN --data-dir "$DATA" agent remove worker-renamed --channel fresh --json 2>/proof/agent-remove.out)"
    UNCONFIRMED_STATUS=$?
    set -e
    [[ "$UNCONFIRMED_STATUS" -eq 2 ]]
    [[ -z "$UNCONFIRMED_REMOVE" ]]
    [[ "$(wc -l </proof/agent-remove.out)" -eq 1 ]]
    REMOVED_AGENT="$($BIN --data-dir "$DATA" agent remove worker-renamed --channel fresh --yes --json)"
    grep -Fq '"removed_ts"' <<<"$REMOVED_AGENT"
    if grep -Eq 'session_ref|host|acp_launch|PROOF_TOKEN|0123456789abcdef' <<<"$REMOVED_AGENT"; then
      printf "packed agent result leaked native identity or credentials\n" >&2
      exit 1
    fi
    [[ "$($BIN --data-dir "$DATA" agent list --channel fresh --json)" == '[]' ]]
    if grep -Fq 'third-party adapter completed' /proof/daemon.log; then
      printf "packed agent administration unexpectedly delivered a turn\n" >&2
      exit 1
    fi
    # harn:end agent-management-does-not-invent-work
    # harn:end structured-agent-cli-preserves-flat-lifecycle-and-presets
    # harn:end agent-add-selects-public-adapter-or-detached-preset

    # harn:assume packed-management-workflow-recovers-after-restart ref=packed-management-recovery-workflow
    export PHASE5_PRIMARY=/proof/phase5-primary
    node --input-type=module <<'NODE'
      import { execFileSync } from 'node:child_process';
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';

      const primary = process.env.PHASE5_PRIMARY;
      if (!primary) throw new Error('missing phase 5 primary repository path');
      mkdirSync(primary, { recursive: true });
      const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
      git(primary, ['init', '-q', '-b', 'main']);
      git(primary, ['config', 'user.email', 'packed-proof@example.test']);
      git(primary, ['config', 'user.name', 'Packed Proof']);
      writeFileSync(join(primary, 'README.md'), 'phase 5 packed proof\n');
      git(primary, ['add', 'README.md']);
      git(primary, ['commit', '-qm', 'phase 5 packed proof']);
NODE
    export PHASE5_CHILD=/proof/phase5-child

    PHASE5_PRESET_JSON="$($BIN --data-dir "$DATA" agent-preset create "Phase 5 Helper" \
      --handle phase5-helper --adapter housecat --policy workspace-write --json)"
    assert_json "$PHASE5_PRESET_JSON"
    assert_safe "$PHASE5_PRESET_JSON"
    grep -Fq '"adapter":"housecat"' <<<"$PHASE5_PRESET_JSON"
    PHASE5_PRESET_ID="$(PHASE5_PRESET_JSON="$PHASE5_PRESET_JSON" node --input-type=module -e \
      "console.log(JSON.parse(process.env.PHASE5_PRESET_JSON).id)")"
    PHASE5_ROSTER_JSON="$($BIN --data-dir "$DATA" default-roster set "$PHASE5_PRESET_ID" --json)"
    assert_json "$PHASE5_ROSTER_JSON"
    assert_safe "$PHASE5_ROSTER_JSON"
    grep -Fq "\"preset_ids\":[\"$PHASE5_PRESET_ID\"]" <<<"$PHASE5_ROSTER_JSON"

    PHASE5_ROOT_JSON="$($BIN --data-dir "$DATA" channel create "Phase 5 Root" \
      --owner proof --id phase5-root --cwd "$PHASE5_PRIMARY" --default-roster --json)"
    assert_json "$PHASE5_ROOT_JSON"
    assert_safe "$PHASE5_ROOT_JSON"
    grep -Fq '"id":"phase5-root"' <<<"$PHASE5_ROOT_JSON"
    grep -Fq "\"cwd\":\"$PHASE5_PRIMARY\"" <<<"$PHASE5_ROOT_JSON"
    PHASE5_ROOT_AGENTS="$($BIN --data-dir "$DATA" agent list --channel phase5-root --json)"
    assert_json "$PHASE5_ROOT_AGENTS"
    assert_safe "$PHASE5_ROOT_AGENTS"
    grep -Fq '"handle":"phase5-helper"' <<<"$PHASE5_ROOT_AGENTS"
    grep -Fq "\"cwd\":\"$PHASE5_PRIMARY\"" <<<"$PHASE5_ROOT_AGENTS"

    PHASE5_CHILD_JSON="$($BIN --data-dir "$DATA" --url "http://127.0.0.1:${PORT}" --token "$PROOF_TOKEN" \
      worktree add --channel phase5-root --create --path "$PHASE5_CHILD" --alias child \
      --branch phase5-child --default-roster --json)"
    assert_json "$PHASE5_CHILD_JSON"
    assert_safe "$PHASE5_CHILD_JSON"
    grep -Fq '"alias":"child"' <<<"$PHASE5_CHILD_JSON"
    grep -Fq "\"path\":\"$PHASE5_CHILD\"" <<<"$PHASE5_CHILD_JSON"
    grep -Fq '"branch":"phase5-child"' <<<"$PHASE5_CHILD_JSON"
    test -d "$PHASE5_CHILD"
    PHASE5_WORKTREES_CREATED="$($BIN --data-dir "$DATA" --url "http://127.0.0.1:${PORT}" --token "$PROOF_TOKEN" \
      worktree list --channel phase5-root --json)"
    assert_json "$PHASE5_WORKTREES_CREATED"
    assert_safe "$PHASE5_WORKTREES_CREATED"
    grep -Fq '"alias":"child"' <<<"$PHASE5_WORKTREES_CREATED"
    grep -Fq "\"path\":\"$PHASE5_CHILD\"" <<<"$PHASE5_WORKTREES_CREATED"
    grep -Fq '"branch":"phase5-child"' <<<"$PHASE5_WORKTREES_CREATED"
    node --input-type=module <<'NODE'
      import { execFileSync } from 'node:child_process';
      import { existsSync } from 'node:fs';

      const primary = process.env.PHASE5_PRIMARY;
      const child = process.env.PHASE5_CHILD;
      if (!primary || !child || !existsSync(child)) throw new Error('packed CLI did not create the child checkout');
      execFileSync('git', ['-C', primary, 'show-ref', '--verify', 'refs/heads/phase5-child'], { stdio: 'pipe' });
NODE
    PHASE5_CHILD_ROOM="$(PHASE5_CHILD_JSON="$PHASE5_CHILD_JSON" node --input-type=module -e \
      "console.log(JSON.parse(process.env.PHASE5_CHILD_JSON).conversation_id)")"
    PHASE5_CHILD_AGENTS="$($BIN --data-dir "$DATA" --url "http://127.0.0.1:${PORT}" --token "$PROOF_TOKEN" \
      agent list --channel "$PHASE5_CHILD_ROOM" --json)"
    assert_json "$PHASE5_CHILD_AGENTS"
    assert_safe "$PHASE5_CHILD_AGENTS"
    grep -Fq '"handle":"phase5-helper"' <<<"$PHASE5_CHILD_AGENTS"
    grep -Fq "\"cwd\":\"$PHASE5_CHILD\"" <<<"$PHASE5_CHILD_AGENTS"

    PHASE5_EXPLICIT_AGENT="$($BIN --data-dir "$DATA" agent add explicit-worker --channel phase5-root \
      --adapter housecat --cwd "$PHASE5_PRIMARY" --purpose packed-explicit-agent --json)"
    assert_json "$PHASE5_EXPLICIT_AGENT"
    assert_safe "$PHASE5_EXPLICIT_AGENT"
    grep -Fq '"handle":"explicit-worker"' <<<"$PHASE5_EXPLICIT_AGENT"

    "$BIN" --data-dir "$DATA" post -r phase5-root \
      '~child:@phase5-helper please run the adapter boundary turn'
    export PHASE5_ORIGIN="http://127.0.0.1:${PORT}"
    export PHASE5_ROOT_ROOM=phase5-root
    PHASE5_ROOT_MESSAGES="$(node --input-type=module <<'NODE'
      const origin = process.env.PHASE5_ORIGIN;
      const room = process.env.PHASE5_ROOT_ROOM;
      const token = process.env.PROOF_TOKEN;
      const needle = 'third-party adapter completed the boundary turn';
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const response = await fetch(`${origin}/api/rooms/${encodeURIComponent(room)}/messages?limit=100`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (response.ok) {
          const body = await response.json();
          if (body.messages?.some((message) => typeof message.body === 'string' && message.body.includes(needle))) {
            process.stdout.write(JSON.stringify(body.messages));
            process.exit(0);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('packed qualified result did not reach the origin');
NODE
    )"
    assert_json "$PHASE5_ROOT_MESSAGES"
    assert_safe "$PHASE5_ROOT_MESSAGES"
    grep -Fq 'third-party adapter completed the boundary turn' <<<"$PHASE5_ROOT_MESSAGES"
    PHASE5_ROOT_HISTORY="$($BIN --data-dir "$DATA" tail -r phase5-root --once)"
    PHASE5_CHILD_HISTORY="$($BIN --data-dir "$DATA" --url "http://127.0.0.1:${PORT}" --token "$PROOF_TOKEN" \
      tail -r "$PHASE5_CHILD_ROOM" --once)"
    grep -Fq 'third-party adapter completed the boundary turn' <<<"$PHASE5_ROOT_HISTORY"
    if grep -Fq 'third-party adapter completed the boundary turn' <<<"$PHASE5_CHILD_HISTORY"; then
      printf "packed qualified result was copied into the child transcript\n" >&2
      exit 1
    fi
    assert_safe "$PHASE5_ROOT_HISTORY"
    assert_safe "$PHASE5_CHILD_HISTORY"

    PHASE5_ARCHIVED="$($BIN --data-dir "$DATA" channel archive phase5-root --yes --json)"
    assert_json "$PHASE5_ARCHIVED"
    assert_safe "$PHASE5_ARCHIVED"
    grep -Fq '"status":"archived"' <<<"$PHASE5_ARCHIVED"
    PHASE5_ACTIVE="$($BIN --data-dir "$DATA" channel list --json)"
    assert_json "$PHASE5_ACTIVE"
    assert_safe "$PHASE5_ACTIVE"
    if grep -Fq '"id":"phase5-root"' <<<"$PHASE5_ACTIVE"; then
      printf "packed archived phase 5 channel remained in default discovery\n" >&2
      exit 1
    fi
    PHASE5_ALL="$($BIN --data-dir "$DATA" channel list --all --json)"
    assert_json "$PHASE5_ALL"
    assert_safe "$PHASE5_ALL"
    grep -Fq '"id":"phase5-root"' <<<"$PHASE5_ALL"

    kill -TERM "$DAEMON_PID"
    if ! wait "$DAEMON_PID"; then
      printf "packed phase 5 daemon did not shut down successfully\n" >&2
      exit 1
    fi
    DAEMON_PID=""
    CODOR_TOKEN="$PROOF_TOKEN" "$BIN" --data-dir "$DATA" up \
      --host 127.0.0.1 --port "$PORT" \
      --adapter housecat=/proof/third-party-adapter.mjs \
      --channel fresh --channel-name Fresh --owner proof \
      >/proof/daemon-restart.log 2>&1 &
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
      throw new Error('packed restarted daemon did not become ready');
    "

    PHASE5_ACTIVE_AFTER="$($BIN --data-dir "$DATA" channel list --json)"
    assert_json "$PHASE5_ACTIVE_AFTER"
    assert_safe "$PHASE5_ACTIVE_AFTER"
    if grep -Fq '"id":"phase5-root"' <<<"$PHASE5_ACTIVE_AFTER"; then
      printf "packed archived phase 5 channel reappeared in default discovery after restart\n" >&2
      exit 1
    fi
    PHASE5_ALL_AFTER="$($BIN --data-dir "$DATA" channel list --all --json)"
    assert_json "$PHASE5_ALL_AFTER"
    assert_safe "$PHASE5_ALL_AFTER"
    grep -Fq '"id":"phase5-root"' <<<"$PHASE5_ALL_AFTER"
    PHASE5_SHOW_AFTER="$($BIN --data-dir "$DATA" channel show phase5-root --json)"
    assert_json "$PHASE5_SHOW_AFTER"
    assert_safe "$PHASE5_SHOW_AFTER"
    grep -Fq '"status":"archived"' <<<"$PHASE5_SHOW_AFTER"
    grep -Fq "\"cwd\":\"$PHASE5_PRIMARY\"" <<<"$PHASE5_SHOW_AFTER"
    PHASE5_ROSTER_AFTER="$($BIN --data-dir "$DATA" default-roster show --json)"
    assert_json "$PHASE5_ROSTER_AFTER"
    assert_safe "$PHASE5_ROSTER_AFTER"
    grep -Fq "\"preset_ids\":[\"$PHASE5_PRESET_ID\"]" <<<"$PHASE5_ROSTER_AFTER"
    PHASE5_ROOT_AGENTS_AFTER="$($BIN --data-dir "$DATA" agent list --channel phase5-root --json)"
    assert_json "$PHASE5_ROOT_AGENTS_AFTER"
    assert_safe "$PHASE5_ROOT_AGENTS_AFTER"
    grep -Fq '"handle":"phase5-helper"' <<<"$PHASE5_ROOT_AGENTS_AFTER"
    grep -Fq '"handle":"explicit-worker"' <<<"$PHASE5_ROOT_AGENTS_AFTER"
    grep -Fq "\"cwd\":\"$PHASE5_PRIMARY\"" <<<"$PHASE5_ROOT_AGENTS_AFTER"
    PHASE5_CHILD_AGENTS_AFTER="$($BIN --data-dir "$DATA" --url "http://127.0.0.1:${PORT}" --token "$PROOF_TOKEN" \
      agent list --channel "$PHASE5_CHILD_ROOM" --json)"
    assert_json "$PHASE5_CHILD_AGENTS_AFTER"
    assert_safe "$PHASE5_CHILD_AGENTS_AFTER"
    grep -Fq '"handle":"phase5-helper"' <<<"$PHASE5_CHILD_AGENTS_AFTER"
    grep -Fq "\"cwd\":\"$PHASE5_CHILD\"" <<<"$PHASE5_CHILD_AGENTS_AFTER"
    PHASE5_WORKTREES_AFTER="$($BIN --data-dir "$DATA" --url "http://127.0.0.1:${PORT}" --token "$PROOF_TOKEN" \
      worktree list --channel phase5-root --json)"
    assert_json "$PHASE5_WORKTREES_AFTER"
    assert_safe "$PHASE5_WORKTREES_AFTER"
    grep -Fq '"alias":"child"' <<<"$PHASE5_WORKTREES_AFTER"
    grep -Fq "\"path\":\"$PHASE5_CHILD\"" <<<"$PHASE5_WORKTREES_AFTER"
    grep -Fq '"branch":"phase5-child"' <<<"$PHASE5_WORKTREES_AFTER"
    node --input-type=module <<'NODE'
      import { execFileSync } from 'node:child_process';
      import { existsSync } from 'node:fs';

      const primary = process.env.PHASE5_PRIMARY;
      const child = process.env.PHASE5_CHILD;
      if (!primary || !child || !existsSync(child)) throw new Error('packed child checkout did not survive restart');
      execFileSync('git', ['-C', primary, 'show-ref', '--verify', 'refs/heads/phase5-child'], { stdio: 'pipe' });
NODE
    PHASE5_ROOT_HISTORY_AFTER="$($BIN --data-dir "$DATA" tail -r phase5-root --once)"
    PHASE5_CHILD_HISTORY_AFTER="$($BIN --data-dir "$DATA" --url "http://127.0.0.1:${PORT}" --token "$PROOF_TOKEN" \
      tail -r "$PHASE5_CHILD_ROOM" --once)"
    grep -Fq 'third-party adapter completed the boundary turn' <<<"$PHASE5_ROOT_HISTORY_AFTER"
    if grep -Fq 'third-party adapter completed the boundary turn' <<<"$PHASE5_CHILD_HISTORY_AFTER"; then
      printf "packed qualified result was copied into the child transcript after restart\n" >&2
      exit 1
    fi
    assert_safe "$PHASE5_ROOT_HISTORY_AFTER"
    assert_safe "$PHASE5_CHILD_HISTORY_AFTER"
    # harn:end packed-management-workflow-recovers-after-restart

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
printf 'packed install passed: clean clone, build, %s, repeat install, offline install, native daemon, browser, CLI, API, teardown\n' "$TARBALL_NAME"
# harn:end packed-release-proof-runs-install-runtime
