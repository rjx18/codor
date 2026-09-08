// Origin-scoped fetch router for the relay tunnel. When the browser is paired
// through the blind relay, requests to the relay origin are tunnelled; every
// other origin (localhost, tailnet) stays on the direct path unchanged. Kept
// dependency-free so both api.ts and crypto.ts (the device-auth handshake) can
// route through it without an import cycle.
let relayTransport: { origin: string; fetch: (input: string, init?: RequestInit) => Promise<Response> } | undefined;

export function setRelayTransport(
  transport: { origin: string; fetch: (input: string, init?: RequestInit) => Promise<Response> } | undefined,
): void {
  relayTransport = transport;
}

/**
 * fetch() that tunnels API requests through the relay when paired, and passes
 * everything else through unchanged. Accepts absolute OR page-relative URLs.
 *
 * In relay mode EVERY API call belongs to the relay — whether the caller built it
 * against the page origin (codor.app) or the relay origin. A direct fetch to the
 * page origin would hit Pages' SPA fallback and get HTML with a 200, which is the
 * exact bug that same-origin test harnesses (SPA served by the switchboard) hid.
 */
export function relayFetch(url: string, init?: RequestInit): Promise<Response> {
  return captureRelayFetch()(url, init);
}

/** Freeze routing for a multi-request operation before the active computer changes. */
export function captureRelayFetch(): typeof relayFetch {
  const transport = relayTransport;
  const base = typeof location !== 'undefined' ? location.origin : 'http://localhost';
  return (url, init) => {
  const target = new URL(url, base); // resolve page-relative paths against the page origin
  if (transport && (target.origin === base || target.origin === transport.origin)) {
    return transport.fetch(target.pathname + target.search, init);
  }
  return fetch(url, init);
  };
}
