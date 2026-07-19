# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Native Windows support (landed 2026-07-19)

Codor runs on native Windows without WSL. The load-bearing pieces, in case they regress:

- Local control socket is platform-aware: `localSocketPath(dataDir)` in
  `packages/switchboard/src/local-socket.ts` returns `<dataDir>/codor.sock` on POSIX and a
  `\\.\pipe\codor-<hash>` named pipe on win32. CLI clients reach it via a
  `ws+unix:///` three-slash URL plus a `createConnection` leading-slash strip (see
  `packages/cli/src/connection.ts`) because the WHATWG parser rejects backslashes.
- `codor setup` has a win32 branch: per-user Task Scheduler logon task + hidden PowerShell
  wrapper (`renderServiceScript` / `renderScheduledTaskXml` in `packages/cli/src/setup.ts`).
  The wrapper must end with `exit $LASTEXITCODE` or restart-on-failure dies silently.
- `scripts/install-cli.ps1` installs a `codor.cmd` shim (Windows twin of `install-cli.sh`).
- Per-turn CLI adapters (gemini/copilot/opencode) spawn through `cross-spawn`, not
  `node:child_process`, so npm `.cmd` shims and shebang fixtures work on Windows.
- Custody liveness probes use the group-leader pid on win32 (no POSIX process groups) —
  `attachChildAlive`/`processAlive` in `packages/switchboard/src/daemon.ts`.
- `website/docs/*.md` are VitePress `@include` stubs, NOT git symlinks (symlinks
  materialize as text files on Windows checkouts and the site builds empty pages).
- `.gitattributes` forces LF so brand-asset byte-comparison survives `core.autocrlf`.
- Tests that encode POSIX semantics (socket-parent perms, mode-0600 asserts, symlink
  script installs, Linux/macOS service render simulations) are `skipIf(win32)` — don't
  "fix" them by weakening the POSIX assertions.
- Known flaky under full-suite load on Windows: `ledger.spec` attribution; both pass isolated.
- The `@codor/web` Playwright e2e suite (the **legacy** client, not shipped web-next) now runs on
  Windows but many main-flow specs fail there on browser-side connect/render timing. The daemon
  data path they exercise is verified working on Windows (browser WebSocket connects and syncs);
  the failures are pre-existing legacy-client browser gaps, not the port. Don't gate Windows work
  on this suite.

## Commands

Requires Node 22+ and pnpm 10.9 (`packageManager` pinned). All packages are private; distribution is the source checkout.

```sh
pnpm install --frozen-lockfile
pnpm -r build                 # tsc per package; web-next also vite build
pnpm test                     # all package vitest suites
pnpm test:all                 # build + all tests + @codor/web e2e (Playwright)
pnpm lint                     # only packages that define lint
pnpm release:check            # test:all + license + release audits
```

Per package / single test:

```sh
pnpm --filter @codor/switchboard test
pnpm --filter @codor/switchboard exec vitest run src/authorization.spec.ts
pnpm --filter @codor/web e2e          # browser suite; one daemon per spec file, own port trio
pnpm --filter @codor/web-next dev     # vite dev server for the current web client
```

Run locally: build, then `scripts/install-cli.sh` (bash) and `codor setup` (`--dry-run` prints every host action and the rendered service without touching anything). Daemon UI at `http://127.0.0.1:8137`.

## Architecture

pnpm monorepo, TypeScript strict, ESM (`NodeNext`), Vitest workspace at root. Full picture: `docs/ARCHITECTURE.md`; wire contract: `docs/PROTOCOL.md`; adapter contract: `docs/ADAPTERS.md`.

- **`packages/switchboard`** — the daemon. One Node process owning: channel/message store (SQLite via better-sqlite3; run event streams are JSONL blobs under `~/.codor/rooms/<room>/runs/`), the mention router (pure function, PROTOCOL §3), the adapter host (spawns/supervises/resumes agent sessions — sessions are durable, processes are cattle), and the WS + REST API used by every surface. `daemon.ts` is a single ~200KB file; its spec is similar size.
- **`packages/protocol`** — shared schemas/types for the wire protocol, adapter contract, rooms, members, deliveries. Change contracts here first.
- **`packages/cli`** — `codor` command. `program.ts` defines commands (`up`, `serve`, `setup`, `spawn`, `post`, ...); `up.ts` boots the daemon in-process and serves the web client; `setup.ts` is the one-shot install wizard.
- **`packages/adapters/*`** — one per agent harness. `claude-code` uses the Claude Agent SDK `query()` as a persistent runtime; `codex` uses the codex app-server; `copilot`, `gemini`, `opencode` are supervised per-turn CLI subprocesses. All expose the same normalized `HarnessAdapter` turn contract (`packages/protocol/src/adapter.ts`).
- **`packages/web-next`** — the current browser client. The daemon's default static root is `packages/web-next/dist`. **`packages/web` is legacy** — never serve or deploy it, but its `e2e` Playwright suite is still part of `test:all`.
- **`packages/bridges`** (slack/telegram/core), **`relay/`** (self-hostable push relay, Docker), **`website/`** (VitePress docs site; its `test` is a static build + verify).

## Harn assumption ledger

`.harn/assumptions/*.yaml` records binding invariants. Code and docs carry paired markers:

```text
// harn:assume <assumption-id> ref=<label>
...guarded region...
// harn:end <assumption-id>
```

When editing a guarded region, keep the markers and keep the code true to the assumption's `statement` — or update the YAML deliberately. Do not strip markers in refactors. `MANUAL-VERIFY.md` holds the live-probe and release checklist (`harn check` is part of the release gate).
