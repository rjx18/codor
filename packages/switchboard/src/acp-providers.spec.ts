import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ACP_PROVIDER_DEFINITIONS,
  buildAcpProviderLaunch,
  detectAcpProviders,
  findAcpProviderDefinition,
  isAcpProviderInstalled,
  isProviderShadowed,
  type AcpProviderDefinition,
} from './acp-providers.js';

// harn:assume named-acp-provider-catalog-is-path-detected-and-command-private ref=acp-provider-detection-regression
describe('the curated ACP provider registry is frozen and exact', () => {
  it('defines exactly Kimi Code CLI and Kilo Code, in that order, with literal acp argv', () => {
    expect(ACP_PROVIDER_DEFINITIONS.map((definition) => ({ ...definition, argv: [...definition.argv] })))
      .toEqual([
        {
          id: 'kimi',
          label: 'Kimi Code CLI',
          executable: 'kimi',
          argv: ['acp'],
          help_url: 'https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp',
        },
        {
          id: 'kilo',
          label: 'Kilo Code',
          executable: 'kilo',
          argv: ['acp'],
          help_url: 'https://kilo.ai/docs/code-with-ai/platforms/cli',
        },
      ]);
  });

  it('is frozen so the curated set cannot be mutated at runtime', () => {
    expect(Object.isFrozen(ACP_PROVIDER_DEFINITIONS)).toBe(true);
    expect(() => {
      (ACP_PROVIDER_DEFINITIONS as AcpProviderDefinition[]).push({
        id: 'evil', label: 'Evil', executable: 'evil', argv: ['acp'], help_url: 'x',
      });
    }).toThrow();
  });

  it('resolves a curated definition by id and refuses an unknown id', () => {
    expect(findAcpProviderDefinition('kimi')?.executable).toBe('kimi');
    expect(findAcpProviderDefinition('kilo')?.executable).toBe('kilo');
    expect(findAcpProviderDefinition('acp:kimi')).toBeUndefined();
    expect(findAcpProviderDefinition('ghost')).toBeUndefined();
  });
});

describe('provider detection is PATH-only and never invokes the provider', () => {
  const kimi = findAcpProviderDefinition('kimi')!;

  it('reports installed for an executable non-directory file without running it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-acp-path-'));
    const executable = join(dir, 'kimi');
    const marker = join(dir, 'invoked');
    writeFileSync(executable, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(executable, 0o755);
    expect(isAcpProviderInstalled(kimi, { PATH: dir })).toBe(true);
    expect(() => readFileSync(marker)).toThrow(); // never executed
    rmSync(dir, { recursive: true });
  });

  it('treats a present but non-executable file as absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-acp-noexec-'));
    const executable = join(dir, 'kimi');
    writeFileSync(executable, '#!/bin/sh\n');
    chmodSync(executable, 0o644);
    expect(isAcpProviderInstalled(kimi, { PATH: dir })).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('does not treat an executable-named directory as an installed command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-acp-dir-'));
    mkdirSync(join(dir, 'kimi'), { mode: 0o755 });
    expect(isAcpProviderInstalled(kimi, { PATH: dir })).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('reports absent on an empty PATH', () => {
    expect(isAcpProviderInstalled(kimi, { PATH: '' })).toBe(false);
  });
});

describe('detectAcpProviders projects only safe metadata in stable order', () => {
  it('returns command-private metadata (no executable/argv) in definition order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-acp-detect-'));
    for (const name of ['kimi', 'kilo']) {
      const executable = join(dir, name);
      writeFileSync(executable, '#!/bin/sh\n');
      chmodSync(executable, 0o755);
    }
    const detected = detectAcpProviders({ env: { PATH: dir } });
    expect(detected).toEqual([
      { id: 'kimi', label: 'Kimi Code CLI', help_url: ACP_PROVIDER_DEFINITIONS[0].help_url, installed: true, shadowed: false },
      { id: 'kilo', label: 'Kilo Code', help_url: ACP_PROVIDER_DEFINITIONS[1].help_url, installed: true, shadowed: false },
    ]);
    for (const entry of detected) {
      expect(entry).not.toHaveProperty('executable');
      expect(entry).not.toHaveProperty('argv');
    }
    rmSync(dir, { recursive: true });
  });

  it('tracks false -> true -> false as the binary appears and disappears on PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-acp-refresh-'));
    const executable = join(dir, 'kimi');
    expect(detectAcpProviders({ env: { PATH: dir } })[0].installed).toBe(false);
    writeFileSync(executable, '#!/bin/sh\n');
    chmodSync(executable, 0o755);
    expect(detectAcpProviders({ env: { PATH: dir } })[0].installed).toBe(true);
    rmSync(executable);
    expect(detectAcpProviders({ env: { PATH: dir } })[0].installed).toBe(false);
    rmSync(dir, { recursive: true });
  });
});

describe('native shadowing hides a provider from primary selection only when it prefers an installed native', () => {
  const withNative: AcpProviderDefinition = {
    id: 'kimi', label: 'Kimi Code CLI', executable: 'kimi', argv: ['acp'],
    help_url: 'https://example.test', native_adapter_id: 'codex',
  };

  it('shadows a provider whose preferred native adapter is installed', () => {
    expect(isProviderShadowed(withNative, (id) => id === 'codex')).toBe(true);
  });

  it('does not shadow when the preferred native adapter is absent', () => {
    expect(isProviderShadowed(withNative, () => false)).toBe(false);
  });

  it('never shadows a provider with no native preference, whatever is installed', () => {
    for (const definition of ACP_PROVIDER_DEFINITIONS) {
      expect(isProviderShadowed(definition, () => true)).toBe(false);
    }
  });
});

describe('buildAcpProviderLaunch yields a fresh private launch decoupled from the definition', () => {
  it('clones the executable and literal argv', () => {
    const definition = findAcpProviderDefinition('kilo')!;
    const launch = buildAcpProviderLaunch(definition);
    expect(launch).toEqual({ executable: 'kilo', argv: ['acp'] });
    launch.argv.push('--extra');
    expect([...definition.argv]).toEqual(['acp']); // frozen source untouched
  });
});
// harn:end named-acp-provider-catalog-is-path-detected-and-command-private
