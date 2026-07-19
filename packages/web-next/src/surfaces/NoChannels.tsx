/**
 * An account with no authorized channels. This is a truthful terminal state,
 * not a loading one: it opens no room subscription, because there is no room
 * to subscribe to. Inventing one is what produced the phantom `default`.
 */
export function NoChannels() {
  return (
    <main className="nx-upgrade" data-testid="no-channels">
      <section className="nx-upgrade-card" aria-labelledby="no-channels-title">
        <p className="nx-eyebrow">No channels</p>
        <h1 id="no-channels-title">Nothing to open yet</h1>
        <p>
          This device is paired, but no channels are available to it. Create one
          from another surface, or ask an owner to add you.
        </p>
      </section>
    </main>
  );
}
