/**
 * Startup could not learn which channels this device may open, and it has no
 * remembered room to fall back to. That is UNKNOWN state — typically offline —
 * and it is deliberately distinct from "no channels": claiming an empty
 * authorization here would tell the operator their channels are gone when the
 * truth is that we could not ask.
 */
export function StartupUnavailable() {
  return (
    <main className="nx-upgrade" data-testid="startup-unavailable">
      <section className="nx-upgrade-card" aria-labelledby="startup-unavailable-title">
        <p className="nx-eyebrow">Offline</p>
        <h1 id="startup-unavailable-title">Can’t reach your channels</h1>
        <p>
          This device is paired, but the channel list could not be loaded and it
          has no recent channel to reopen. Reconnect and try again.
        </p>
        <button
          type="button"
          className="nx-btn is-primary"
          data-testid="startup-retry"
          onClick={() => { window.location.reload(); }}
        >
          Try again
        </button>
      </section>
    </main>
  );
}
