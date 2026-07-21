import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// harn:assume source-cli-installers-remain-idempotent-fallback ref=windows-cli-install-regression
describe('Windows CLI installer source contract', () => {
  it('refuses a missing build, forwards arguments, and de-duplicates user PATH', () => {
    const script = readFileSync(
      fileURLToPath(new URL('../../../scripts/install-cli.ps1', import.meta.url)),
      'utf8',
    );
    expect(script).toContain("if (-not (Test-Path -LiteralPath $Entry))");
    expect(script).toContain('node `"$EscapedEntry`" %*');
    expect(script).toContain("Join-Path $env:USERPROFILE '.local\\bin'");
    expect(script).toContain("[Environment]::GetEnvironmentVariable('Path', 'User')");
    expect(script).toContain("[Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')");
    expect(script).toContain("if (-not $Present)");
  });
});
// harn:end source-cli-installers-remain-idempotent-fallback
