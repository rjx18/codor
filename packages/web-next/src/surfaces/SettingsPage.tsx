// Placeholder until the settings phase (P6).
export function SettingsPage(props: { token: string; refreshToken?: () => Promise<string> }) {
  void props;
  return (
    <main className="nx-surface" aria-label="Settings">
      <section className="nx-surface-card">
        <h1>Settings</h1>
        <p>The rebuilt settings surface lands in a later build phase.</p>
        <p><a href="/">Back to the room</a></p>
      </section>
    </main>
  );
}
