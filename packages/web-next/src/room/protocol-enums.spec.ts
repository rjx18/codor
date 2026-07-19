import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The UI must not carry its own copy of a protocol enum.
 *
 * It did: seven thinking levels inlined against a protocol default of three, so
 * the dialog offered four no harness would accept. An inlined list goes stale
 * silently — nothing fails, the options are simply wrong, and the failure only
 * shows up as a harness rejecting a value the UI proudly displayed.
 */
const roomDir = dirname(fileURLToPath(import.meta.url));

const sources = readdirSync(roomDir)
  .filter((file) => (file.endsWith('.tsx') || file.endsWith('.ts')) && !file.includes('.spec.'))
  .map((file) => [file, readFileSync(resolve(roomDir, file), 'utf8')] as const);

describe('protocol enums are never hardcoded in the UI', () => {
  it('has sources to check', () => {
    expect(sources.length).toBeGreaterThan(3);
  });

  it.each(sources)('%s declares no policy literal list', (_file, source) => {
    expect(source).not.toMatch(/\[\s*'read-only'\s*,\s*'workspace-write'/);
  });

  it.each(sources)('%s declares no thinking-level literal list', (_file, source) => {
    expect(source).not.toMatch(/\[\s*'low'\s*,\s*'medium'\s*,\s*'high'/);
  });

  it('the single policy and thinking source is the protocol', () => {
    const spec = readFileSync(resolve(roomDir, 'agent-spec.ts'), 'utf8');
    expect(spec).toContain('PolicySchema.options');
    expect(spec).toContain('DEFAULT_THINKING_LEVELS');
  });
});
