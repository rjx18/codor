// Runs the browser suite one spec file at a time: each file gets its own
// Playwright invocation, which boots its own harness daemon on its own port
// trio, so nothing durable can cross a spec-file boundary.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testsRoot = join(packageRoot, 'tests');

// harn:assume concurrent-browser-suites-do-not-collide ref=e2e-runner-port-selection
/**
 * The reviewer and the implementer gate at the same time. A fixed base means the
 * second suite to start cannot bind, and that failure is indistinguishable from a
 * product regression — it already cost one phantom finding. So claim a range that
 * is actually free, and say which one.
 */
function readOverride() {
  const raw = process.env.CODOR_E2E_PORT_BASE;
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value + 32 > 65_535) {
    throw new Error('CODOR_E2E_PORT_BASE must leave room for every spec port trio');
  }
  return value;
}

function isFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function selectBasePort(trios) {
  const override = readOverride();
  if (override !== undefined) return override;
  const span = trios * 3;
  for (let base = 18_137; base + span < 30_000; base += span) {
    const ports = Array.from({ length: span }, (_, offset) => base + offset);
    const free = await Promise.all(ports.map((port) => isFree(port)));
    if (free.every(Boolean)) return base;
  }
  throw new Error('no free contiguous port range for the browser suite');
}
// harn:end concurrent-browser-suites-do-not-collide

// A spec file whose report is missing or unreadable fails the gate rather than
// silently contributing zero tests to the total.
function readCounts(reportPath, spec) {
  let stats;
  try {
    stats = JSON.parse(readFileSync(reportPath, 'utf8')).stats;
  } catch (error) {
    throw new Error(`${spec}: unreadable Playwright report (${String(error)})`);
  }
  if (!stats) throw new Error(`${spec}: Playwright report carried no stats`);
  const expected = stats.expected ?? 0;
  const unexpected = stats.unexpected ?? 0;
  const flaky = stats.flaky ?? 0;
  const skipped = stats.skipped ?? 0;
  return { expected, unexpected, flaky, skipped, total: expected + unexpected + flaky + skipped };
}

// harn:assume e2e-gate-covers-every-spec-file ref=isolated-e2e-spec-runner
const specs = readdirSync(testsRoot)
  .filter((name) => name === 'e2e.spec.ts' || name.endsWith('.e2e.spec.ts'))
  .sort();
if (specs.length === 0) throw new Error('no browser spec file matched the suite pattern');

const basePort = await selectBasePort(specs.length);
process.stdout.write(`[e2e] port base ${String(basePort)}\n`);
const reportRoot = mkdtempSync(join(tmpdir(), 'codor-e2e-report-'));
const totals = { expected: 0, unexpected: 0, flaky: 0, skipped: 0, total: 0 };
const failed = [];

try {
  for (const [index, spec] of specs.entries()) {
    const apiPort = basePort + index * 3;
    const reportPath = join(reportRoot, `${spec}.json`);
    process.stdout.write(`\n[e2e] ${spec} on ports ${String(apiPort)}-${String(apiPort + 2)}\n`);
    // xvfb-run exists only on Linux; everywhere else Playwright renders headless natively.
    // Windows resolves the playwright .cmd shim through the shell (plain spawn EINVALs on it).
    const [runner, runnerArgs] = process.platform === 'linux'
      ? ['xvfb-run', ['-a', 'playwright', 'test', `tests/${spec}`, '--reporter=list,json']]
      : ['playwright', ['test', `tests/${spec}`, '--reporter=list,json']];
    const result = spawnSync(
      runner,
      runnerArgs,
      {
        shell: process.platform === 'win32',
        cwd: packageRoot,
        env: {
          ...process.env,
          CODOR_E2E_API_PORT: String(apiPort),
          CODOR_E2E_CONTROL_PORT: String(apiPort + 1),
          CODOR_E2E_RELAY_PORT: String(apiPort + 2),
          PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
        },
        stdio: 'inherit',
      },
    );
    if (result.error) throw result.error;

    const counts = readCounts(reportPath, spec);
    for (const key of Object.keys(totals)) totals[key] += counts[key];
    if (result.status !== 0) failed.push(spec);
    process.stdout.write(
      `[e2e] ${spec}: ${String(counts.total)} tests (${String(counts.expected)} passed,`
      + ` ${String(counts.unexpected)} failed, ${String(counts.flaky)} flaky,`
      + ` ${String(counts.skipped)} skipped)\n`,
    );
  }
} finally {
  rmSync(reportRoot, { recursive: true, force: true });
}

process.stdout.write(
  `\n[e2e] ${String(specs.length)} spec files, ${String(totals.total)} tests`
  + ` (${String(totals.expected)} passed, ${String(totals.unexpected)} failed,`
  + ` ${String(totals.flaky)} flaky, ${String(totals.skipped)} skipped)\n`,
);
if (failed.length > 0) {
  process.stdout.write(`[e2e] failed spec files: ${failed.join(', ')}\n`);
  process.exit(1);
}
// harn:end e2e-gate-covers-every-spec-file
