// Runs the browser suite one spec file at a time: each file gets its own
// Playwright invocation, which boots its own harness daemon on its own port
// trio, so nothing durable can cross a spec-file boundary.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testsRoot = join(packageRoot, 'tests');

function readBasePort() {
  const value = Number(process.env.CODOR_E2E_PORT_BASE ?? 18_137);
  if (!Number.isInteger(value) || value < 1 || value + 32 > 65_535) {
    throw new Error('CODOR_E2E_PORT_BASE must leave room for every spec port trio');
  }
  return value;
}

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

const basePort = readBasePort();
const reportRoot = mkdtempSync(join(tmpdir(), 'codor-e2e-report-'));
const totals = { expected: 0, unexpected: 0, flaky: 0, skipped: 0, total: 0 };
const failed = [];

try {
  for (const [index, spec] of specs.entries()) {
    const apiPort = basePort + index * 3;
    const reportPath = join(reportRoot, `${spec}.json`);
    process.stdout.write(`\n[e2e] ${spec} on ports ${String(apiPort)}-${String(apiPort + 2)}\n`);
    const result = spawnSync(
      'xvfb-run',
      ['-a', 'playwright', 'test', `tests/${spec}`, '--reporter=list,json'],
      {
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
