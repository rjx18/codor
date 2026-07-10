# Setup (M0)

What exists after M0: the switchboard daemon + WS/REST API, the web room SPA (served by the
switchboard itself), and two live adapters (`claude-code`, `codex`). The `wireroom` CLI, member
spawning UX, and multi-box arrive in M1+ — until then rooms and members are created over the
REST API or a small boot script.

## Prerequisites

- Node ≥ 22, pnpm ≥ 10
- The harness CLIs you want as members, logged in on this machine: `claude` (Claude Code),
  `codex` (Codex CLI). Adapters drive them as plain subprocesses — if the CLI works in your
  terminal, it works as a member.
- Optional but recommended: [Tailscale](https://tailscale.com) on every device that should
  reach the room.

## Build and boot

```sh
pnpm install
pnpm -r build
```

Boot script (save as `boot.mjs`, adjust paths/token; a proper CLI lands in M1):

```js
import { Daemon, startServer } from '@wireroom/switchboard';
import { ClaudeCodeAdapter } from '@wireroom/adapter-claude-code';
import { CodexAdapter } from '@wireroom/adapter-codex';

const daemon = new Daemon({
  dbPath: `${process.env.HOME}/.wireroom/switchboard.sqlite`,
  blobRoot: `${process.env.HOME}/.wireroom/blobs`,
  adapters: [new ClaudeCodeAdapter(), new CodexAdapter()],
});
if (!daemon.store.getRoom('desk')) {
  daemon.createRoom({ id: 'desk', name: 'Desk', owner: { handle: 'you', display_name: 'You' } });
  daemon.spawnMember('desk', { harness: 'codex', handle: 'coder', cwd: '/path/to/project', policy: 'workspace-write' });
  daemon.spawnMember('desk', { harness: 'claude-code', handle: 'planner', cwd: '/path/to/project' });
}
await daemon.reconcile(); // crash-safe: finalize / retry-once / hold in-flight turns
const server = await startServer({
  daemon,
  token: process.env.WIREROOM_TOKEN, // the pairing token — you are the room owner
  host: '127.0.0.1',
  port: 8137,
  staticRoot: new URL('./packages/web/dist', import.meta.url).pathname,
});
console.log(`wireroom on http://127.0.0.1:${server.port}`);
```

```sh
WIREROOM_TOKEN=$(openssl rand -hex 16) node boot.mjs
```

Open `http://127.0.0.1:8137/?room=desk&token=<token>`. Everything the browser sees has passed
the redaction projection; raw run blobs stay on this machine.

## Reaching it from other devices — the tailnet is the network

The switchboard binds loopback/tailnet only. **Never port-forward it to the public internet** —
the token is a bearer credential.

### Zero-config: `tailscale serve`

On the switchboard box:

```sh
tailscale serve --bg https / http://127.0.0.1:8137
```

That publishes `https://<host>.<tailnet>.ts.net` with automatic TLS, reachable from every
device on your tailnet (phone included — install the Tailscale app). The WS endpoint rides the
same origin, so the web app works unchanged: 
`https://<host>.<tailnet>.ts.net/?room=desk&token=<token>`.

### Teams / custom domain: a Tailscale app connector

For a memorable name (`https://wireroom.company.dev`) with centralized ACL control:

1. Run a **connector node** on the tailnet and advertise the app: in the Tailscale admin
   console, add an app connector for your domain, or on the node
   `tailscale set --advertise-connector --advertise-app=wireroom.company.dev`.
2. Point the domain's DNS at the connector (per the admin console instructions); the connector
   routes requests across the tailnet to the switchboard host.
3. Gate access in the tailnet policy file with grants, e.g.:

```jsonc
"grants": [
  { "src": ["group:eng"], "dst": ["tag:wireroom"], "ip": ["tcp:8137", "tcp:443"] }
]
```

Tag the switchboard node `tag:wireroom`. Access control now lives in the policy file — device
enrollment in the tailnet is the login; the room token stays a second factor.

## Verifying a live install

```sh
curl -s "http://127.0.0.1:8137/api/rooms?token=$WIREROOM_TOKEN"          # room list
curl -s "http://127.0.0.1:8137/api/rooms/desk/sync?since_seq=0&token=$WIREROOM_TOKEN" | head -c 400
```

Post `@coder reply with the single word PONG` in the web composer: a run message should
appear, stream a live header, and finalize in place. That is the M0 dial tone (the full
acceptance transcript lives in the build log as `tmp/build/ACCEPT-M0.md`).
