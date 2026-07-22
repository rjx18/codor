import type { AcpLaunchConfig } from '@codor/protocol';

import { executableOnPath } from './adapter-registry.js';

// harn:assume named-acp-provider-catalog-is-path-detected-and-command-private ref=acp-provider-definition
/**
 * A curated named ACP provider. `executable` and `argv` are PRIVATE daemon-side
 * launch material: they resolve the generic ACP transport for a friendly named
 * selection and are never projected to any public catalog, member, prompt, log,
 * or error. Only {@link AcpProviderMetadata} (id/label/help_url plus detection
 * state) ever crosses an API boundary.
 */
export interface AcpProviderDefinition {
  /** Stable public id, e.g. `kimi`. Matches the protocol AcpProviderIdSchema. */
  readonly id: string;
  /** Human label shown in selectors. */
  readonly label: string;
  /** Direct executable name resolved on the daemon service PATH. Private. */
  readonly executable: string;
  /** Literal argv handed to the generic ACP transport. Private. */
  readonly argv: readonly string[];
  /** Documentation link surfaced beside the named tile. */
  readonly help_url: string;
  /**
   * An installed richer native adapter that shadows this provider from PRIMARY
   * new selection only — never from the metadata existing members still need.
   */
  readonly native_adapter_id?: string;
}

/**
 * The frozen curated provider set. Order is stable and drives catalog and
 * selector ordering. Adding a provider is a deliberate registry edit, never a
 * client- or PATH-driven mutation.
 */
export const ACP_PROVIDER_DEFINITIONS: readonly AcpProviderDefinition[] = Object.freeze([
  Object.freeze({
    id: 'kimi',
    label: 'Kimi Code CLI',
    executable: 'kimi',
    argv: Object.freeze(['acp']),
    help_url: 'https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp',
  }),
  Object.freeze({
    id: 'kilo',
    label: 'Kilo Code',
    executable: 'kilo',
    argv: Object.freeze(['acp']),
    help_url: 'https://kilo.ai/docs/code-with-ai/platforms/cli',
  }),
]) as readonly AcpProviderDefinition[];

/** Safe public projection of a curated provider. Carries no command material. */
export interface AcpProviderMetadata {
  readonly id: string;
  readonly label: string;
  readonly help_url: string;
  /** Present on the daemon service PATH as an executable non-directory file. */
  readonly installed: boolean;
  /** Hidden from primary selection because a richer native adapter is installed. */
  readonly shadowed: boolean;
}

/** Resolve a curated definition by its stable public id, or undefined. */
export function findAcpProviderDefinition(id: string): AcpProviderDefinition | undefined {
  return ACP_PROVIDER_DEFINITIONS.find((definition) => definition.id === id);
}

/**
 * Presence-only detection: true iff the definition's executable resolves to an
 * executable non-directory file on the given PATH. Never invokes the provider,
 * a package runner, an installer, a downloader, or a version probe, and never
 * mutates PATH — it delegates solely to the shared {@link executableOnPath}.
 */
export function isAcpProviderInstalled(
  definition: AcpProviderDefinition,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return executableOnPath(definition.executable, env);
}

/**
 * A provider is shadowed only when it explicitly prefers a native adapter that
 * is currently installed. Shadowing hides it from PRIMARY new selection but
 * never from the metadata an existing member depends on. A provider with no
 * native preference is never shadowed, whatever is installed.
 */
export function isProviderShadowed(
  definition: AcpProviderDefinition,
  isNativeInstalled: (nativeAdapterId: string) => boolean,
): boolean {
  return definition.native_adapter_id !== undefined
    && isNativeInstalled(definition.native_adapter_id);
}

export interface DetectAcpProvidersOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Presence predicate. Defaults to a PATH scan via {@link isAcpProviderInstalled}
   * using `env`; the daemon injects its own testable executable resolver so all
   * detection shares one implementation.
   */
  isInstalled?: (definition: AcpProviderDefinition) => boolean;
  /** Whether a native adapter id is currently installed (drives shadowing). */
  isNativeInstalled?: (nativeAdapterId: string) => boolean;
}

/**
 * Detect every curated provider in stable definition order, returning only the
 * command-private-safe metadata.
 */
export function detectAcpProviders(
  options: DetectAcpProvidersOptions = {},
): AcpProviderMetadata[] {
  const env = options.env ?? process.env;
  const isInstalled = options.isInstalled ?? ((definition) => isAcpProviderInstalled(definition, env));
  const isNativeInstalled = options.isNativeInstalled ?? (() => false);
  return ACP_PROVIDER_DEFINITIONS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    help_url: definition.help_url,
    installed: isInstalled(definition),
    shadowed: isProviderShadowed(definition, isNativeInstalled),
  }));
}

/**
 * Build the private structured launch for a curated definition: a fresh mutable
 * `AcpLaunchConfig` clone the daemon passes through the existing ACP validator.
 * The returned object shares no state with the frozen definition.
 */
export function buildAcpProviderLaunch(definition: AcpProviderDefinition): AcpLaunchConfig {
  return {
    executable: definition.executable,
    argv: [...definition.argv],
  };
}
// harn:end named-acp-provider-catalog-is-path-detected-and-command-private
