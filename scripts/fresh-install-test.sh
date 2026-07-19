#!/usr/bin/env bash
set -Eeuo pipefail

# The proof can be launched from an agent that already has a narrow Codor
# identity and a live socket. It must never inherit either into its disposable
# daemon or smoke CLI.
unset CODOR_CHANNEL CODOR_DATA_DIR CODOR_MEMBER_TOKEN CODOR_RELAY_URL CODOR_SOCKET
unset CODOR_TOKEN CODOR_TRUST_TAILSCALE_SERVE CODOR_URL CODOR_VAPID_PUBLIC_KEY

# harn:assume fresh-clone-install-proven-by-script ref=fresh-install-script
SOURCE_ROOT="${CODOR_FRESH_SOURCE:-$(git rev-parse --show-toplevel)}"
SOURCE_REF="${CODOR_FRESH_REF:-$(git -C "$SOURCE_ROOT" branch --show-current)}"
if [[ -z "$SOURCE_REF" ]]; then
  printf 'CODOR_FRESH_REF is required when the source checkout has detached HEAD\n' >&2
  exit 2
fi

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/codor-fresh-install.XXXXXX")"
CLONE_ROOT="$TEST_ROOT/repo"
DATA_DIR="$TEST_ROOT/data"
DAEMON_PID=''

cleanup() {
  if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill -TERM "$DAEMON_PID" 2>/dev/null || true
    for _ in {1..50}; do
      kill -0 "$DAEMON_PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$DAEMON_PID" 2>/dev/null; then
      kill -KILL "$DAEMON_PID" 2>/dev/null || true
    fi
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

git clone --quiet --single-branch --branch "$SOURCE_REF" "file://$SOURCE_ROOT" "$CLONE_ROOT"
cd "$CLONE_ROOT"

corepack pnpm install --frozen-lockfile
corepack pnpm -r build

TOKEN="$(openssl rand -hex 32)"
PORT="$(node -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
SMOKE="fresh-install-$(date +%s)-$$"

# harn:assume operator-launches-serve-web-next ref=fresh-install-current-web-client
CODOR_TOKEN="$TOKEN" node packages/cli/dist/index.js \
  --data-dir "$DATA_DIR" \
  up --host 127.0.0.1 --port "$PORT" \
  --channel fresh --channel-name Fresh --owner fresh-operator \
  >"$TEST_ROOT/daemon.log" 2>&1 &
DAEMON_PID=$!

for _ in {1..100}; do
  if curl --fail --silent --output /dev/null \
    -H "Authorization: Bearer $TOKEN" \
    "http://127.0.0.1:$PORT/api/rooms"; then
    break
  fi
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    printf 'fresh switchboard exited before readiness\n' >&2
    sed -n '1,160p' "$TEST_ROOT/daemon.log" >&2
    exit 1
  fi
  sleep 0.1
done

if ! curl --fail --silent --output /dev/null \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:$PORT/api/rooms"; then
  printf 'fresh switchboard did not become ready\n' >&2
  sed -n '1,160p' "$TEST_ROOT/daemon.log" >&2
  exit 1
fi

APP_HTML="$(curl --fail --silent "http://127.0.0.1:$PORT/")"
grep -Fq '/codor-favicon.svg' <<<"$APP_HTML"
# harn:end operator-launches-serve-web-next

# harn:assume fresh-clone-install-proven-by-script ref=fresh-install-regression
node packages/cli/dist/index.js \
  --data-dir "$DATA_DIR" post -r fresh "$SMOKE"
TAIL_OUTPUT="$(node packages/cli/dist/index.js \
  --data-dir "$DATA_DIR" tail -r fresh --once)"
grep -Fq "$SMOKE" <<<"$TAIL_OUTPUT"

ROOMS_JSON="$(curl --fail --silent \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:$PORT/api/rooms")"
node -e '
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(payload.rooms) || !payload.rooms.some((room) => room.id === "fresh")) {
      process.exitCode = 1;
    }
  });
' <<<"$ROOMS_JSON"
# harn:end fresh-clone-install-proven-by-script

kill -TERM "$DAEMON_PID"
wait "$DAEMON_PID"
DAEMON_PID=''
printf 'fresh install passed: clone, frozen install, build, boot, CLI post/tail, API, teardown\n'
# harn:end fresh-clone-install-proven-by-script
