// Placeholder until the pairing phase (P6): the full QR + code + trusted-enrollment
// surface is rebuilt there. Until then this route only explains itself.
export function PairingPage(props: { autoPair?: boolean; returnTo?: string }) {
  return (
    <main className="nx-surface" aria-label="Pairing">
      <section className="nx-surface-card">
        <h1>Pair this device</h1>
        <p>
          {props.autoPair
            ? 'This browser is not paired yet.'
            : 'Device pairing.'}{' '}
          The rebuilt pairing flow lands in a later build phase — pair from the current
          client for now.
        </p>
        {props.returnTo !== undefined && (
          <p><a href={props.returnTo}>Back</a></p>
        )}
      </section>
    </main>
  );
}
