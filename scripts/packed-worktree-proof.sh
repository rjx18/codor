#!/usr/bin/env bash
set -Eeuo pipefail

# harn:assume packed-management-workflow-persists-target-owned-worktree-turn ref=packed-target-owned-management-workflow
SOURCE_ROOT="${CODOR_PACKED_SOURCE:-$(git rev-parse --show-toplevel)}"
while IFS= read -r name; do
  unset "$name"
done < <(compgen -A variable | grep '^CODOR_' || true)
PROOF_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/codor-packed-worktree.XXXXXX")"
DATA="$PROOF_ROOT/data"
INSTALL="$PROOF_ROOT/install"
PRIMARY="$PROOF_ROOT/primary"
CHILD="$PROOF_ROOT/child"
TOKEN='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
PORT="$((32000 + $$ % 20000))"
DAEMON_PID=''

cleanup() {
  local status=$?
  if [[ "$status" -ne 0 && -f "$PROOF_ROOT/daemon.log" ]]; then
    sed -n '1,160p' "$PROOF_ROOT/daemon.log" >&2 || true
  fi
  if [[ -n "$DAEMON_PID" ]]; then kill "$DAEMON_PID" 2>/dev/null || true; fi
  rm -rf -- "$PROOF_ROOT"
  return "$status"
}
trap cleanup EXIT

cd "$SOURCE_ROOT"
pnpm build:artifact >/dev/null
mkdir -p "$INSTALL" "$DATA" "$PRIMARY"
TARBALL_NAME="$(npm pack "$SOURCE_ROOT/artifact/codor" --pack-destination "$PROOF_ROOT" --silent)"
TARBALL="$PROOF_ROOT/$TARBALL_NAME"
cd "$INSTALL"
npm init -y >/dev/null
npm install --silent "$TARBALL"
BIN="$INSTALL/node_modules/.bin/codor"

git -C "$PRIMARY" init -q -b main
git -C "$PRIMARY" config user.email packed-worktree@example.test
git -C "$PRIMARY" config user.name 'Packed Worktree Proof'
printf 'packed worktree proof\n' >"$PRIMARY/README.md"
git -C "$PRIMARY" add README.md
git -C "$PRIMARY" commit -qm 'packed worktree proof'

CODOR_TOKEN="$TOKEN" "$BIN" --data-dir "$DATA" up \
  --host 127.0.0.1 --port "$PORT" \
  --adapter "housecat=$SOURCE_ROOT/packages/switchboard/test-fixtures/third-party-adapter.mjs" \
  --channel bootstrap --channel-name Bootstrap --owner proof \
  >"$PROOF_ROOT/daemon.log" 2>&1 &
DAEMON_PID="$!"

node --input-type=module -e "
  const origin = 'http://127.0.0.1:${PORT}';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(origin + '/api/pairing/status');
      if (response.ok) process.exit(0);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('focused packed daemon did not become ready');
"

codor_npx() {
  npx --yes --package="$TARBALL" codor --data-dir "$DATA" \
    --url "http://127.0.0.1:${PORT}" --token "$TOKEN" "$@"
}

ROOT_JSON="$(codor_npx channel create 'Packed Root' --owner proof --id packed-root --cwd "$PRIMARY" --json)"
grep -Fq '"id":"packed-root"' <<<"$ROOT_JSON"

CHILD_JSON="$(codor_npx worktree add --channel packed-root --create \
  --path "$CHILD" --branch feat/packed-child --json)"
CHILD_ROOM="$(CHILD_JSON="$CHILD_JSON" node --input-type=module -e \
  "const value=JSON.parse(process.env.CHILD_JSON); if (!/^packed-root-feat-packed-child-[0-9a-f]{8}$/.test(value.conversation_id)) throw new Error(value.conversation_id); console.log(value.conversation_id)")"

FIRST="$(codor_npx agent add worker --channel packed-root --worktree feat/packed-child \
  --adapter housecat --cwd "$CHILD" --json)"
SECOND="$(codor_npx agent add worker --channel packed-root --worktree feat-packed-child \
  --adapter housecat --cwd "$CHILD" --json)"
FIRST_ID="$(FIRST="$FIRST" node --input-type=module -e 'console.log(JSON.parse(process.env.FIRST).id)')"
SECOND_ID="$(SECOND="$SECOND" node --input-type=module -e 'console.log(JSON.parse(process.env.SECOND).id)')"
[[ "$FIRST_ID" == "$SECOND_ID" ]]

codor_npx post -r packed-root '~feat-packed-child:@worker please run the adapter boundary turn'
CHILD_HISTORY=''
for _ in $(seq 1 100); do
  CHILD_HISTORY="$(codor_npx tail -r "$CHILD_ROOM" --once)"
  if grep -Fq 'third-party adapter completed the boundary turn' <<<"$CHILD_HISTORY"; then break; fi
  sleep 0.1
done
grep -Fq 'adapter boundary turn' <<<"$CHILD_HISTORY"
grep -Fq 'third-party adapter completed the boundary turn' <<<"$CHILD_HISTORY"
ROOT_HISTORY="$(codor_npx tail -r packed-root --once)"
if grep -Fq 'adapter boundary turn' <<<"$ROOT_HISTORY"; then
  printf 'installed CLI target-owned turn leaked into the root conversation\n' >&2
  exit 1
fi

printf 'packed npx worktree proof passed: %s\n' "$CHILD_ROOM"
# harn:end packed-management-workflow-persists-target-owned-worktree-turn
