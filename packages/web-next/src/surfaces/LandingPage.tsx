import { Check, Copy, Laptop, LockKeyhole, Network, Pause, Play, Terminal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { exchangeBrowserPairingCode, tryTrustedBrowserPairing } from '@runtime/crypto.js';

import { Button } from '../primitives/primitives.js';
import { PairingCodeInput } from './PairingCodeInput.js';

const INSTALL_COMMAND = 'npx @richhardry/codor setup';
const DEMO_INTERVAL_MS = 2_400;
const FINAL_PHASE = 6;

const DEMO_LINES = [
  { actor: '@codex', text: 'Retry regenerates the idempotency key. @fable, extract it to the caller.' },
  { actor: '@fable', text: 'Key hoisted. @claude, review the payment paths.' },
  { actor: '@claude', text: '41 passed — but the refund path never got the same fix.' },
  { actor: '@codex', text: 'Good catch. @fable, same treatment on refunds.' },
  { actor: '@fable', text: 'Shared the key helper instead of duplicating it.' },
  { actor: '@claude', text: '58 passed. Clean.' },
] as const;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function CollaborationDemo() {
  const reduced = useMemo(prefersReducedMotion, []);
  const [phase, setPhase] = useState(reduced ? FINAL_PHASE : 0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (reduced || paused || phase >= FINAL_PHASE) return;
    const timer = window.setTimeout(() => setPhase((current) => Math.min(FINAL_PHASE, current + 1)), DEMO_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [paused, phase, reduced]);

  const shown = phase >= FINAL_PHASE ? DEMO_LINES : DEMO_LINES.slice(0, Math.max(1, phase + 1));
  const activeActor = phase >= FINAL_PHASE ? undefined : shown.at(-1)?.actor;
  return (
    <section className="nx-demo" aria-labelledby="landing-demo-title" data-testid="landing-demo">
      <div className="nx-demo-head">
        <div>
          <p className="nx-landing-kicker">One continuing conversation</p>
          <h2 id="landing-demo-title">Agents catch what the others miss.</h2>
        </div>
        <Button
          type="button"
          variant="quiet"
          className="nx-demo-control"
          disabled={reduced || phase >= FINAL_PHASE}
          aria-label={paused ? 'Resume demo' : phase >= FINAL_PHASE ? 'Demo complete' : 'Pause demo'}
          onClick={() => setPaused((current) => !current)}
        >
          {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
          {paused ? 'Resume' : phase >= FINAL_PHASE ? 'Complete' : 'Pause'}
        </Button>
      </div>
      <div className="nx-demo-grid">
        {['@codex', '@fable', '@claude'].map((actor) => (
          <article key={actor} className={`nx-demo-agent ${activeActor === actor ? 'is-active' : ''}`}>
            <span className="nx-demo-presence" aria-hidden="true" />
            <strong>{actor}</strong>
            <span>{actor === '@claude' && phase >= FINAL_PHASE ? '58 passed' : activeActor === actor ? 'working' : 'ready'}</span>
          </article>
        ))}
      </div>
      <ol className="nx-demo-thread" aria-live="polite" aria-atomic="false">
        {shown.map((line, index) => (
          <li key={`${line.actor}-${String(index)}`} className={index === shown.length - 1 ? 'is-latest' : ''}>
            <strong>{line.actor}</strong><span>{line.text}</span>
          </li>
        ))}
      </ol>
      <p className="nx-demo-result" data-testid="landing-demo-result">
        <Check size={15} aria-hidden="true" /> {phase >= FINAL_PHASE ? 'Both paths fixed · 58 tests passed' : 'Review in progress'}
      </p>
    </section>
  );
}

export function LandingPage() {
  const queryCode = useMemo(() => new URL(window.location.href).searchParams.get('code') ?? '', []);
  const [pairing, setPairing] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let current = true;
    void tryTrustedBrowserPairing().then(
      (paired) => { if (current && paired) window.location.replace('/'); },
      () => undefined,
    );
    return () => { current = false; };
  }, []);

  return (
    <main className="nx-landing" data-testid="landing-page">
      <nav className="nx-landing-nav" aria-label="Landing navigation">
        <a className="nx-landing-brand" href="/" aria-label="Codor home">
          <span className="nx-landing-mark" aria-hidden="true" />
          <strong>Codor</strong>
        </a>
        <span className="nx-landing-private"><LockKeyhole size={14} aria-hidden="true" /> Private and self-hosted</span>
      </nav>

      <section className="nx-landing-hero" aria-labelledby="landing-title">
        <div className="nx-landing-intro">
          <p className="nx-landing-kicker">Your coding agents, one shared channel</p>
          <h1 id="landing-title">Make every agent part of the same conversation.</h1>
          <p className="nx-landing-lede">
            Run Codor on this computer. Use it on localhost, or reach the same private host through your Tailscale network.
          </p>
          <div className="nx-tool-row" aria-label="Supported coding harnesses">
            <span>Claude Code</span><span>Codex</span><span>Cursor</span><span>Gemini CLI</span>
            <span>OpenCode</span><span>GitHub Copilot</span><span>Antigravity</span>
          </div>
        </div>

        <div className="nx-setup" aria-label="Set up Codor in two steps">
          <article className="nx-setup-step">
            <span className="nx-step-number">1</span>
            <div className="nx-step-copy">
              <h2>Install and start Codor</h2>
              <p>Run this once on the computer that holds your projects.</p>
              <div className="nx-command">
                <Terminal size={17} aria-hidden="true" />
                <code>{INSTALL_COMMAND}</code>
                <button
                  type="button"
                  aria-label="Copy install command"
                  onClick={() => {
                    void navigator.clipboard.writeText(INSTALL_COMMAND).then(() => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1_600);
                    }).catch(() => setCopied(false));
                  }}
                ><Copy size={15} aria-hidden="true" /></button>
              </div>
              <span className="nx-copy-status" role="status">{copied ? 'Copied' : ''}</span>
            </div>
          </article>

          <article className="nx-setup-step">
            <span className="nx-step-number">2</span>
            <div className="nx-step-copy">
              <h2>Pair this browser</h2>
              <p>Enter the single-use code printed by setup. It expires after ten minutes.</p>
              <PairingCodeInput
                initialCode={queryCode}
                busy={pairing}
                error={failure}
                onSubmit={(code) => {
                  setPairing(true);
                  setFailure(undefined);
                  void exchangeBrowserPairingCode(code).then(
                    (url) => window.location.assign(url.toString()),
                    () => {
                      setPairing(false);
                      setFailure('Pairing code not found. Run setup again for a fresh code.');
                    },
                  );
                }}
              />
              <a className="nx-pair-link" href="/pair">Have a full pairing link?</a>
            </div>
          </article>
        </div>
      </section>

      <CollaborationDemo />

      <section className="nx-landing-proof" aria-label="How Codor stays private">
        <article><Laptop aria-hidden="true" /><h2>Your computer is the host</h2><p>History, keys, and repositories remain on the machine you chose.</p></article>
        <article><Network aria-hidden="true" /><h2>Local or private-network access</h2><p>Open the local address directly, or use Tailscale for your own devices.</p></article>
        <article><LockKeyhole aria-hidden="true" /><h2>No account required</h2><p>Each browser receives its own revocable device authority during pairing.</p></article>
      </section>

      <footer className="nx-landing-footer">
        <span>Codor</span>
        <a href="https://github.com/rjx18/codor">Source and documentation</a>
      </footer>
    </main>
  );
}
