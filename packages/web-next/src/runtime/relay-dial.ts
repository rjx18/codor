// Relay dial-time reachability (P7): some networks kill connections that openly
// name the canonical relay host (SNI/DNS filtering) while the workers.dev alias
// passes. Dialers (pairing claim, session tunnel) try candidates in order and
// stick with the member that works — the browser mirror of the switchboard
// store's {canonical, alias} failover. Config-only module with no runtime
// imports, so crypto.ts and relay.ts can both use it without a cycle.

declare global {
  interface Window {
    __CODOR_RELAY_URL?: string;
    __CODOR_RELAY_ALIAS?: string;
  }
}

/**
 * The relay URL when relay pairing is INTENDED — the hosted codor.app bakes
 * VITE_CODOR_RELAY_URL; e2e sets window.__CODOR_RELAY_URL at runtime. Undefined
 * on a self-hosted switchboard (local pairing), so no default is returned here.
 */
export function relayUrlConfigured(): string | undefined {
  const runtime = typeof window !== 'undefined' ? window.__CODOR_RELAY_URL : undefined;
  const built = (import.meta.env as { VITE_CODOR_RELAY_URL?: string }).VITE_CODOR_RELAY_URL;
  return runtime || built || undefined;
}

/** The alias member of the relay dial pair (undefined when the build ships none). */
export function relayAliasConfigured(): string | undefined {
  const runtime = typeof window !== 'undefined' ? window.__CODOR_RELAY_ALIAS : undefined;
  const built = (import.meta.env as { VITE_CODOR_RELAY_ALIAS?: string }).VITE_CODOR_RELAY_ALIAS;
  return runtime || built || undefined;
}

/**
 * Dial candidates for `target`, in order (target first). When target is a
 * member of the configured {primary, alias} pair the OTHER member follows as
 * the fallback; any other (custom) URL gets no fallback — a custom relay is
 * never silently redirected to our alias (the switchboard store's scoping
 * rule, held on the browser side too).
 */
export function relayDialCandidates(target: string): string[] {
  const primary = relayUrlConfigured();
  const alias = relayAliasConfigured();
  if (!primary || !alias || primary === alias) return [target];
  if (target === primary) return [primary, alias];
  if (target === alias) return [alias, primary];
  return [target];
}
