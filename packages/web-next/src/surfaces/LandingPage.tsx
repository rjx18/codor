import {
  AudioLines,
  ArrowRight,
  Check,
  ChevronRight,
  Code2,
  Compass,
  Copy,
  Crown,
  Eye,
  FileImage,
  FileText,
  Gauge,
  GitCompareArrows,
  GitBranch,
  Globe2,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  Mic,
  Monitor,
  Network,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  Smartphone,
  Terminal,
  TestTube2,
  Upload,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { PAIRING_TIME_COPY, SESSION_COPY } from '../app/connection-state.js';
import { Chip, StatusPill, TypingDots } from '../primitives/primitives.js';
import { harnessLabel, harnessMark } from '../room/harness-marks.js';
import { exchangeBrowserPairingCode, pairThroughRelay, tryTrustedBrowserPairing } from '@runtime/crypto.js';
import { relayUrlConfigured } from '@runtime/relay-mode.js';

import { PairingCodeInput } from './PairingCodeInput.js';

// harn:assume unpaired-root-explains-primary-install-and-hosted-access ref=landing-primary-install-command
const INSTALL_COMMAND = 'npx @richhardry/codor install';
// harn:end unpaired-root-explains-primary-install-and-hosted-access
const DEMO_INTERVAL_MS = 1_180;
const FINAL_PHASE = 38;

// Thinking beats scale with the size of the response that follows. Short
// handoffs stay brisk; plans, reviews, and fixes get enough time to feel like
// actual work instead of a metronome advancing every line at one speed.
const DEMO_PHASE_DELAYS: Partial<Record<number, number>> = {
  1: 2_500,
  5: 1_750,
  6: 1_900,
  18: 1_550,
  20: 1_550,
  23: 2_300,
  30: 2_050,
  35: 2_100,
  37: 1_650,
};

const HARNESSES = [
  'claude-code',
  'codex',
  'cursor',
  'gemini',
  'opencode',
  'grok',
  'copilot',
  'antigravity',
] as const;

interface DemoTool {
  icon: 'search' | 'edit' | 'terminal';
  label: ReactNode;
}

const WORKFLOWS = [
  {
    label: 'Production pipeline',
    outcome: 'A clean handoff from plan → implementation → independent review.',
    layout: 'pipeline',
    routes: ['M31 50 H35', 'M65 50 H69'],
    roles: [
      { name: 'Fable 5', role: 'Orchestrator', accent: 'green' as const, icon: Crown, harness: 'claude-code', slot: 'lead', weight: 'lead', responsibilities: ['Shape the plan', 'Split ownership', 'Hold the ship gate'], output: 'Approved plan' },
      { name: 'Opus', role: 'Implementation owner', accent: 'violet' as const, icon: Code2, harness: 'claude-code', slot: 'build', weight: 'primary', responsibilities: ['Trace both paths', 'Build the patch', 'Run focused gates'], output: 'Tested change' },
      { name: 'GPT 5.6 Sol', role: 'Independent reviewer', accent: 'indigo' as const, icon: ShieldCheck, harness: 'codex', slot: 'review', weight: 'support', responsibilities: ['Attack invariants', 'Verify recovery'], output: 'Ship verdict' },
    ],
  },
  {
    label: 'Design studio',
    outcome: 'One brief fans out, then converges into a tested product decision.',
    layout: 'studio',
    routes: ['M50 29 V34 H25 V38', 'M50 29 V34 H75 V38', 'M25 67 V72 H50', 'M75 67 V72 H50'],
    roles: [
      { name: 'GPT 5.6 Sol', role: 'Product lead', accent: 'indigo' as const, icon: Compass, harness: 'codex', slot: 'brief', weight: 'lead', responsibilities: ['Turn the ask into a brief', 'Set success criteria', 'Resolve tradeoffs'], output: 'Product brief' },
      { name: 'Opus', role: 'Visual system', accent: 'violet' as const, icon: Palette, harness: 'claude-code', slot: 'visual', weight: 'primary', responsibilities: ['Explore directions', 'Build responsive states'], output: 'Visual language' },
      { name: 'GPT 5.6 Luna', role: 'Prototype track', accent: 'green' as const, icon: Code2, harness: 'cursor', slot: 'prototype', weight: 'primary', responsibilities: ['Wire interaction', 'Exercise edge cases'], output: 'Working prototype' },
      { name: 'Fable 5', role: 'Convergence', accent: 'green' as const, icon: Check, harness: 'claude-code', slot: 'decision', weight: 'support', responsibilities: ['Compare both tracks', 'Choose the final direction'], output: 'Design decision' },
    ],
  },
  {
    label: 'Review council',
    outcome: 'Three specialist reads feed one explicit ship decision.',
    layout: 'council',
    routes: ['M16 46 V51 H50 V57', 'M50 46 V57', 'M84 46 V51 H50 V57'],
    roles: [
      { name: 'Opus', role: 'Implementation read', accent: 'violet' as const, icon: Code2, harness: 'claude-code', slot: 'implementation', weight: 'support', responsibilities: ['Trace control flow', 'Check test depth'], output: 'Code findings' },
      { name: 'GPT 5.6 Sol', role: 'Security critique', accent: 'indigo' as const, icon: ShieldCheck, harness: 'codex', slot: 'security', weight: 'support', responsibilities: ['Probe trust boundaries', 'Attack failure states'], output: 'Risk findings' },
      { name: 'Luna', role: 'UX + regression read', accent: 'green' as const, icon: TestTube2, harness: 'gemini', slot: 'experience', weight: 'support', responsibilities: ['Walk real journeys', 'Check mobile + a11y'], output: 'Journey findings' },
      { name: 'Fable 5', role: 'Council chair', accent: 'green' as const, icon: Crown, harness: 'claude-code', slot: 'verdict', weight: 'lead', responsibilities: ['Reconcile disagreements', 'Rank concrete defects', 'Set the release decision'], output: 'One verdict' },
    ],
  },
  {
    label: 'Incident room',
    outcome: 'Observe, repair, and verify in parallel under one commander.',
    layout: 'incident',
    routes: ['M47 24 H53', 'M47 50 H53', 'M24 68 V74 H50', 'M76 68 V74 H50', 'M50 74 V79'],
    roles: [
      { name: 'Fable 5', role: 'Incident commander', accent: 'green' as const, icon: Crown, harness: 'claude-code', slot: 'command', weight: 'lead', responsibilities: ['Own the timeline', 'Route live evidence', 'Choose rollback or fix'], output: 'Live decision' },
      { name: 'Luna', role: 'Signal desk', accent: 'green' as const, icon: Search, harness: 'gemini', slot: 'observe', weight: 'support', responsibilities: ['Correlate logs', 'Pin reproduction'], output: 'Root cause' },
      { name: 'Opus', role: 'Repair track', accent: 'violet' as const, icon: Code2, harness: 'cursor', slot: 'repair', weight: 'primary', responsibilities: ['Patch live path', 'Prepare rollback'], output: 'Candidate fix' },
      { name: 'GPT 5.6 Sol', role: 'Recovery verifier', accent: 'indigo' as const, icon: Eye, harness: 'codex', slot: 'verify', weight: 'support', responsibilities: ['Replay the failure', 'Watch recovery'], output: 'Recovery proof' },
    ],
  },
  {
    label: 'Parallel worktrees',
    outcome: 'Three isolated branches move at once, then one integration gate lands the result.',
    layout: 'worktrees',
    routes: ['M50 23 V29 H17 V35', 'M50 23 V35', 'M50 29 H83 V35', 'M17 66 V72 H50 V78', 'M50 66 V78', 'M83 66 V72 H50 V78'],
    roles: [
      { name: 'Fable 5', role: 'Worktree coordinator', accent: 'green' as const, icon: Crown, harness: 'claude-code', slot: 'worklead', weight: 'lead', responsibilities: ['Split non-overlapping scopes', 'Track shared assumptions', 'Sequence integration'], output: 'Parallel brief' },
      { name: 'Opus 1', role: 'relay-link worktree', accent: 'violet' as const, icon: GitBranch, harness: 'claude-code', slot: 'treea', weight: 'primary', responsibilities: ['Own failover path', 'Test reconnects'], output: 'relay-link branch' },
      { name: 'Opus 2', role: 'setup worktree', accent: 'violet' as const, icon: GitBranch, harness: 'cursor', slot: 'treeb', weight: 'primary', responsibilities: ['Own install path', 'Test degrade'], output: 'setup branch' },
      { name: 'Luna', role: 'web worktree', accent: 'green' as const, icon: GitBranch, harness: 'gemini', slot: 'treec', weight: 'support', responsibilities: ['Own recovery UI', 'Run journeys'], output: 'web branch' },
      { name: 'GPT 5.6 Sol', role: 'Integration gate', accent: 'indigo' as const, icon: GitCompareArrows, harness: 'codex', slot: 'integrate', weight: 'lead', responsibilities: ['Review composed diff', 'Resolve merge risk', 'Run the shared gate'], output: 'Integrated change' },
    ],
  },
  {
    label: 'Multi-tier delivery',
    outcome: 'A permanent orchestrator delegates one phase to a reviewer-lead, who directs three implementation subphases.',
    layout: 'tiers',
    routes: ['M50 27 V35', 'M50 62 V68 H17 V74', 'M50 62 V74', 'M50 68 H83 V74'],
    roles: [
      { name: 'Fable 5', role: 'Program orchestrator', accent: 'green' as const, icon: Crown, harness: 'claude-code', slot: 'chief', weight: 'lead', responsibilities: ['Own every phase', 'Maintain global context', 'Hold final release'], output: 'Program direction' },
      { name: 'GPT 5.6 Sol', role: 'Phase lead + reviewer', accent: 'indigo' as const, icon: ShieldCheck, harness: 'codex', slot: 'phaselead', weight: 'primary', responsibilities: ['Plan this phase', 'Delegate subphases', 'Review all outputs'], output: 'Phase verdict' },
      { name: 'Opus 1', role: 'API subphase', accent: 'violet' as const, icon: Code2, harness: 'claude-code', slot: 'suba', weight: 'support', responsibilities: ['Implement API seam'], output: 'API patch' },
      { name: 'Opus 2', role: 'UI subphase', accent: 'violet' as const, icon: Code2, harness: 'cursor', slot: 'subb', weight: 'support', responsibilities: ['Implement UI states'], output: 'UI patch' },
      { name: 'Luna', role: 'Verification subphase', accent: 'green' as const, icon: TestTube2, harness: 'gemini', slot: 'subc', weight: 'support', responsibilities: ['Build journey proof'], output: 'Test proof' },
    ],
  },
] as const;

function useEnteredViewport<T extends Element>(threshold = 0.35) {
  const ref = useRef<T>(null);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (entered || !ref.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry?.isIntersecting) setEntered(true); },
      { threshold },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [entered, threshold]);

  return [ref, entered] as const;
}

// Live viewport presence: `entered` latches true once (for one-shot entrance
// styling) while `visible` tracks the element in real time, so looping
// animations can pause the moment the section scrolls offscreen instead of
// running their intervals forever.
function useViewportPresence<T extends Element>(threshold = 0.35) {
  const ref = useRef<T>(null);
  const [entered, setEntered] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const onScreen = entry?.isIntersecting ?? false;
        setVisible(onScreen);
        if (onScreen) setEntered(true);
      },
      { threshold },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [threshold]);

  return [ref, entered, visible] as const;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function DemoToolRow({ tool, running = false }: { tool: DemoTool; running?: boolean }) {
  const Icon = tool.icon === 'edit' ? Pencil : tool.icon === 'search' ? Search : Terminal;
  return (
    <div className={`nx-tool ${running ? 'is-running' : 'is-ok'}`}>
      <Icon className="nx-tool-icon" size={14} aria-hidden="true" />
      <span className="nx-tool-label">{tool.label}</span>
      <span className={`nx-tool-mark ${running ? 'is-running' : 'is-ok'}`}>
        {running
          ? <LoaderCircle className="nx-spin" size={13} aria-label="running" />
          : <Check size={13} aria-label="done" />}
      </span>
    </div>
  );
}

function DemoTurn(props: {
  actor: string;
  accent: 'user' | 'green' | 'indigo' | 'violet';
  time: string;
  children: ReactNode;
}) {
  return (
    <li className="nx-turn nx-demo-turn">
      <Chip name={props.actor} accent={props.accent} size={34} />
      <div className="nx-turn-main">
        <div className="nx-turn-meta">
          <strong className="nx-turn-author">{props.actor}</strong>
          <time className="nx-turn-time">{props.time}</time>
        </div>
        {props.children}
      </div>
    </li>
  );
}

function DemoToolProgress(props: {
  tools: DemoTool[];
  step: number;
  summary: string;
}) {
  if (props.step < 0) return null;
  if (props.step >= props.tools.length) {
    return (
      <div className="nx-batch">
        <span className="nx-batch-line"><ChevronRight size={14} aria-hidden="true" />{props.summary}</span>
      </div>
    );
  }
  return (
    <div className="nx-run">
      {props.tools.slice(0, props.step + 1).map((tool, index) => (
        <DemoToolRow key={String(index)} tool={tool} running={index === props.step} />
      ))}
    </div>
  );
}

function DemoInteraction(props: {
  kind: 'Question' | 'Approval needed';
  prompt: string;
  detail?: string;
  options: string[];
  selected?: string;
  sent?: boolean;
}) {
  if (props.kind === 'Approval needed' && props.sent) {
    return (
      <div className="nx-ask nx-demo-ask is-approved">
        <div className="nx-demo-approved-head"><span><Check size={14} aria-hidden="true" /> Approved</span><small>9:43 PM</small></div>
        <strong>Four-phase plan approved</strong>
        <p>Both implementation tracks can start. Codex remains the independent ship gate.</p>
      </div>
    );
  }

  return (
    <div className="nx-ask nx-demo-ask">
      <div className="nx-ask-head"><span className="nx-ask-kind">{props.kind}</span></div>
      <p className="nx-ask-prompt">{props.prompt}</p>
      {props.detail && <pre className="nx-ask-detail">{props.detail}</pre>}
      <div className="nx-ask-options">
        {props.options.map((option) => (
          <button
            key={option}
            type="button"
            className={`nx-btn ${props.selected === option ? 'is-primary is-demo-clicked' : ''}`}
            aria-pressed={props.selected === option}
            tabIndex={-1}
          >{props.selected === option && <Check size={13} aria-hidden="true" />}{option}</button>
        ))}
        {props.kind === 'Question' && (
          <button type="button" className={`nx-btn is-primary ${props.sent ? 'is-demo-clicked' : ''}`} tabIndex={-1}>
            {props.sent ? <><Check size={13} aria-hidden="true" /> Sent</> : 'Send answer'}
          </button>
        )}
      </div>
      {props.sent && props.kind === 'Question' && (
        <p className="nx-ask-sent">
          Answered — the team is continuing…
        </p>
      )}
    </div>
  );
}

function DemoTyping({ actor, accent }: { actor: string; accent: 'green' | 'indigo' | 'violet' }) {
  return (
    <div className="nx-demo-typing">
      <span className="nx-typing-agent">
        <Chip name={actor} accent={accent} size={24} />
        <TypingDots label={`@${actor} is working`} />
        <span className="nx-typing-elapsed" aria-hidden="true">working</span>
      </span>
    </div>
  );
}

function CollaborationDemo() {
  const reduced = useMemo(prefersReducedMotion, []);
  const [sectionRef, entered] = useEnteredViewport<HTMLElement>(0.28);
  const [phase, setPhase] = useState(reduced ? FINAL_PHASE : -1);
  const streamRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(180);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    if (reduced || !entered || phase >= FINAL_PHASE) return;
    if (phase < 0) {
      setPhase(0);
      return;
    }
    const delay = DEMO_PHASE_DELAYS[phase] ?? DEMO_INTERVAL_MS;
    const timer = window.setTimeout(() => setPhase((current) => Math.min(FINAL_PHASE, current + 1)), delay);
    return () => window.clearTimeout(timer);
  }, [entered, phase, reduced]);

  useLayoutEffect(() => {
    const stream = streamRef.current;
    const content = contentRef.current;
    if (!stream || !content) return;

    const measure = (): void => {
      const nextHeight = Math.ceil(content.getBoundingClientRect().height);
      setContentHeight((current) => current === nextHeight ? current : nextHeight);
      setOverflowing(content.scrollHeight > stream.clientHeight + 4);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    observer.observe(stream);
    return () => observer.disconnect();
  }, []);

  const opusOneResearch: DemoTool[] = [
    { icon: 'search', label: <>Searched relay dial, cache, and setup entry points</> },
    { icon: 'terminal', label: <>Read 11 files across the host runtime and CLI</> },
    { icon: 'search', label: <>Mapped cold-start and reconnect state transitions</> },
  ];
  const opusTwoResearch: DemoTool[] = [
    { icon: 'search', label: <>Traced universal-offer mint and local degrade</> },
    { icon: 'terminal', label: <>Inspected pairing tests and install output</> },
    { icon: 'search', label: <>Checked the one-code burn invariant at both doors</> },
  ];
  const opusOneBuild: DemoTool[] = [
    { icon: 'edit', label: <><span className="nx-stat-add">+46</span> <span className="nx-stat-del">−18</span> <code>relay/link.ts</code></> },
    { icon: 'edit', label: <><span className="nx-stat-add">+22</span> <span className="nx-stat-del">−6</span> <code>relay/store.ts</code></> },
    { icon: 'terminal', label: <><code>pnpm test --filter relay-link</code></> },
    { icon: 'terminal', label: <>Typechecked the host package</> },
  ];
  const opusTwoBuild: DemoTool[] = [
    { icon: 'edit', label: <><span className="nx-stat-add">+38</span> <span className="nx-stat-del">−14</span> <code>setup.ts</code></> },
    { icon: 'edit', label: <><span className="nx-stat-add">+17</span> <span className="nx-stat-del">−4</span> <code>program.ts</code></> },
    { icon: 'terminal', label: <><code>pnpm test --filter setup-flow</code></> },
    { icon: 'terminal', label: <>Ran packed launcher proof</> },
  ];
  const opusOneTests: DemoTool[] = [
    { icon: 'terminal', label: <>Simulated canonical SNI reset</> },
    { icon: 'terminal', label: <>Simulated cached-alias outage</> },
    { icon: 'edit', label: <><span className="nx-stat-add">+29</span> <span className="nx-stat-del">−2</span> <code>link.spec.ts</code></> },
  ];
  const opusTwoTests: DemoTool[] = [
    { icon: 'terminal', label: <>Exercised relay-enabled first install</> },
    { icon: 'terminal', label: <>Exercised labelled local-only degrade</> },
    { icon: 'edit', label: <><span className="nx-stat-add">+31</span> <span className="nx-stat-del">−0</span> <code>setup-flow.spec.ts</code></> },
  ];
  const reviewTools: DemoTool[] = [
    { icon: 'search', label: <>Traced winner scope through URL changes</> },
    { icon: 'search', label: <>Attacked pre-open versus mid-session failure</> },
    { icon: 'terminal', label: <>Ran host and CLI gates</> },
  ];
  const fixTools: DemoTool[] = [
    { icon: 'search', label: <>Reproduced cached-alias outage after network change</> },
    { icon: 'edit', label: <><span className="nx-stat-add">+24</span> <span className="nx-stat-del">−3</span> <code>relay/link.ts</code></> },
    { icon: 'terminal', label: <>Reran symmetric failover matrix</> },
  ];

  const active = phase === 1 || phase === 5
    ? { actor: 'Fable 5', accent: 'green' as const }
    : phase === 6
      ? { actor: 'Opus 1', accent: 'violet' as const }
      : phase === 18 || phase === 20
        ? { actor: 'Fable 5', accent: 'green' as const }
        : phase === 23
          ? { actor: 'GPT 5.6', accent: 'indigo' as const }
          : phase === 30
            ? { actor: 'Opus 1', accent: 'violet' as const }
            : phase === 35
              ? { actor: 'GPT 5.6', accent: 'indigo' as const }
              : undefined;

  const windowHeight = Math.min(760, Math.max(320, contentHeight + 116));

  return (
    <section ref={sectionRef} className={`nx-landing-story nx-demo-story ${entered ? 'is-entered' : ''}`} aria-labelledby="landing-demo-title">
      <div className="nx-story-copy">
        <p className="nx-landing-kicker">One continuous conversation</p>
        <h2 id="landing-demo-title">The whole team sees the work.</h2>
        <p>
          Your agents work through the problem together: asking the right questions, testing ideas, building the
          solution, and improving one another’s work without losing the thread.
        </p>
      </div>

      <div className="nx-demo-stage">
        <div className="nx-demo-window" style={{ '--demo-window-height': `${String(windowHeight)}px` } as CSSProperties}>
          <div className="nx-demo-windowbar" data-testid="landing-demo-channel">
            <span className="nx-window-lights" aria-hidden="true"><i /><i /><i /></span>
            <span className="nx-landing-mark" aria-hidden="true" />
            <span><small>Codor</small><strong># relay-onboarding</strong></span>
            <i className="nx-channel-live" aria-hidden="true" />
            <small>5 members</small>
          </div>
          <div
            ref={streamRef}
            className={`nx-demo-stream ${overflowing ? 'is-overflowing' : ''}`}
            data-testid="landing-demo"
            aria-live="polite"
            aria-atomic="false"
          >
            <div ref={contentRef} className="nx-demo-content">
              <ol className="nx-demo-thread">
          {phase >= 0 && (
            <DemoTurn actor="Richard" accent="user" time="9:41 PM">
              <div className="nx-prose"><p>Make the first Codor setup work on filtered networks too. Keep one pairing code for local and relay access, preserve custom relay URLs, and have the team prove both recovery directions before we ship it.</p></div>
            </DemoTurn>
          )}
          {phase >= 2 && (
            <DemoTurn actor="Fable 5" accent="green" time="9:42 PM">
              <div className="nx-prose">
                <p>I’ll run this as four gated phases and keep the pairing invariant explicit:</p>
                <ol>
                  <li><strong>Map:</strong> trace relay dialing and first-install offer minting independently.</li>
                  <li><strong>Build:</strong> Opus 1 owns symmetric failover; Opus 2 owns universal setup.</li>
                  <li><strong>Challenge:</strong> Codex reviews hostile-network and double-grant failure modes.</li>
                  <li><strong>Ship:</strong> fix real findings, re-review, run the full gate, then deploy.</li>
                </ol>
              </div>
              <DemoInteraction
                kind="Approval needed"
                prompt="Approve this phased plan and start both implementation tracks?"
                detail="Two workers in parallel · independent review before deploy"
                options={['Approve plan', 'Ask for changes']}
                selected={phase >= 3 ? 'Approve plan' : undefined}
                sent={phase >= 5}
              />
            </DemoTurn>
          )}
          {phase >= 5 && (
            <DemoTurn actor="Richard" accent="user" time="9:43 PM">
              <div className="nx-prose"><p>Approved — run all four phases. Ship only after Codex has signed off on the hostile-network and double-grant failure modes.</p></div>
            </DemoTurn>
          )}
          {phase >= 6 && (
            <DemoTurn actor="Fable 5" accent="green" time="9:43 PM">
              <div className="nx-prose"><p>Approved. I’ve started two workflows: Opus 1 is isolating the relay-link state machine; Opus 2 is tracing the daemon-only mint and install experience. Work in parallel, keep scopes disjoint, and report concrete tests with each handoff.</p></div>
            </DemoTurn>
          )}
          {phase >= 7 && (
            <DemoTurn actor="Opus 1" accent="violet" time="9:44 PM">
              <div className="nx-prose"><p>I’m mapping the link before touching it. The important split is pre-open failure versus a mid-session drop: only a socket that never opened should try the alternate hostname. I’m also checking whether the stored winner is scoped to the configured relay URL.</p></div>
              <DemoToolProgress tools={opusOneResearch} step={phase - 7} summary="Ran 3 tools · inspected relay dialing and persistence" />
            </DemoTurn>
          )}
          {phase >= 8 && (
            <DemoTurn actor="Opus 2" accent="green" time="9:44 PM">
              <div className="nx-prose"><p>I’m following the first code from installer output to the stored grant. Setup currently has enough information to mint locally, but doing so beside the daemon would fork the room. The safe route is status → daemon offer → labelled local fallback if relay reservation fails.</p></div>
              <DemoToolProgress tools={opusTwoResearch} step={phase - 8} summary="Ran 3 tools · traced one code through both doors" />
            </DemoTurn>
          )}
          {phase >= 10 && (
            <DemoTurn actor="Opus 1" accent="violet" time="9:46 PM">
              <div className="nx-prose"><p>The state machine is smaller than it looked. I’ll preserve the configured URL as identity, keep the winning dial URL beside it, and permit one alternate attempt only before <code>onOpen</code>. A custom relay never gets the hosted alias because it has no eligible alternate.</p></div>
            </DemoTurn>
          )}
          {phase >= 11 && (
            <DemoTurn actor="Opus 2" accent="green" time="9:47 PM">
              <div className="nx-prose"><p>The universal path is confirmed: the daemon’s pairing host creates one stored grant, and both local exchange and relay completion consume that same entry. I’ll make relay-on the install default, but keep <code>--no-relay</code> as a complete opt-out and label every degrade honestly.</p></div>
            </DemoTurn>
          )}
          {phase >= 12 && (
            <DemoTurn actor="Opus 1" accent="violet" time="9:48 PM">
              <div className="nx-prose"><p>I’m implementing the scoped winner and guarded alternate now. The reconnect path remains unchanged after a healthy session; only a failed handshake can flip endpoints.</p></div>
              <DemoToolProgress tools={opusOneBuild} step={phase - 12} summary="Ran 4 tools · wrote 2 files +68 −24" />
            </DemoTurn>
          )}
          {phase >= 13 && (
            <DemoTurn actor="Opus 2" accent="green" time="9:48 PM">
              <div className="nx-prose"><p>I’m wiring setup to ask the live daemon for the offer after the service starts. The output carries the same browser endpoint as local pairing, and a relay reservation failure returns a clearly marked local-only code instead of aborting install.</p></div>
              <DemoToolProgress tools={opusTwoBuild} step={phase - 13} summary="Ran 4 tools · wrote 2 files +55 −18" />
            </DemoTurn>
          )}
          {phase >= 16 && (
            <DemoTurn actor="Opus 1" accent="violet" time="9:51 PM">
              <div className="nx-prose"><p>The forward leg is green. I added an explicit matrix for canonical blocked, alias blocked, cached winner, and custom origin. I’m running the reverse network-change case separately so a previous alias win cannot become sticky.</p></div>
              <DemoToolProgress tools={opusOneTests} step={phase - 16} summary="Ran 3 tools · wrote 1 file +29 −2" />
            </DemoTurn>
          )}
          {phase >= 17 && (
            <DemoTurn actor="Opus 2" accent="green" time="9:52 PM">
              <div className="nx-prose"><p>The install track now boots relay-enabled, waits for the daemon, and mints through <code>/api/pairing/offers</code>. I’m pinning the two degraded cases: relay unavailable still completes setup; <code>--no-relay</code> never starts a relay session.</p></div>
              <DemoToolProgress tools={opusTwoTests} step={phase - 17} summary="Ran 3 tools · wrote 1 file +31 −0" />
            </DemoTurn>
          )}
          {phase >= 19 && (
            <DemoTurn actor="Opus 1" accent="violet" time="9:54 PM">
              <div className="nx-prose"><p>My track is ready. Canonical reset → alias opens; cached alias reset → canonical recovers; custom relays remain on their own origin. The winner is persisted only after open and discarded when the configured URL changes.</p></div>
            </DemoTurn>
          )}
          {phase >= 21 && (
            <DemoTurn actor="Opus 2" accent="green" time="9:54 PM">
              <div className="nx-prose"><p>Setup is ready too. The first printed code is universal when relay is reachable, visibly local-only when it is not, and <code>--no-relay</code> leaves relay disabled. CLI and packed-install proofs are green.</p></div>
            </DemoTurn>
          )}
          {phase >= 22 && (
            <DemoTurn actor="Fable 5" accent="green" time="9:55 PM">
              <div className="nx-prose"><p>Both tracks are integrated without overlapping ownership. I’ve handed the combined diff to Codex with one review brief: attack winner scoping, reverse failover, and the single shared pairing grant.</p></div>
            </DemoTurn>
          )}
          {phase >= 24 && (
            <DemoTurn actor="GPT 5.6" accent="indigo" time="9:57 PM">
              <div className="nx-prose"><p>I’m reviewing the composed behavior, not the two patches in isolation. I’ve verified the daemon-only mint first; now I’m forcing every endpoint transition and checking which state survives reconnect.</p></div>
              <DemoToolProgress tools={reviewTools} step={phase - 24} summary="Ran 3 tools · reviewed failover, grants, and setup" />
            </DemoTurn>
          )}
          {phase >= 28 && (
            <DemoTurn actor="GPT 5.6" accent="indigo" time="10:00 PM">
              <div className="nx-prose"><p>One concrete defect: after the alias has won once, an asynchronous failure before its next <code>open</code> schedules ordinary backoff but never tries canonical. A user who changes networks can stay stranded even though the other endpoint works. The one-code path is clean.</p></div>
            </DemoTurn>
          )}
          {phase >= 29 && (
            <DemoTurn actor="Fable 5" accent="green" time="10:01 PM">
              <div className="nx-prose"><p>Confirmed. Opus 1, make pre-open failover symmetric for the cached winner and add the exact regression. Keep mid-session reconnect behavior untouched. Codex will re-review only that repair.</p></div>
            </DemoTurn>
          )}
          {phase >= 31 && (
            <DemoTurn actor="Opus 1" accent="violet" time="10:03 PM">
              <div className="nx-prose"><p>Reproduced it. The alternate was derived from the configured URL instead of the attempted dial URL, so a cached alias could not point back to canonical. I’ve corrected that lookup and guarded it with the same once-per-attempt flag.</p></div>
              <DemoToolProgress tools={fixTools} step={phase - 31} summary="Ran 3 tools · wrote 1 file +24 −3" />
            </DemoTurn>
          )}
          {phase >= 34 && (
            <DemoTurn actor="Fable 5" accent="green" time="10:05 PM">
              <div className="nx-prose"><p>The regression is green in both directions. Codex, re-review the repair and confirm the cached winner, custom URL, and mid-session boundaries still hold.</p></div>
            </DemoTurn>
          )}
          {phase >= 36 && (
            <DemoTurn actor="GPT 5.6" accent="indigo" time="10:06 PM">
              <div className="nx-prose"><p>Re-review is clean. The cached winner now fails over symmetrically before open, no endpoint flips after a healthy session, custom relays cannot inherit the hosted alias, and every new branch has a reachable regression.</p></div>
              <div className="nx-batch"><span className="nx-batch-line"><ChevronRight size={14} aria-hidden="true" />Ran 4 tools · 693 host tests passed</span></div>
            </DemoTurn>
          )}
          {phase >= 38 && (
            <DemoTurn actor="Fable 5" accent="green" time="10:09 PM">
              <div className="nx-prose"><p>Final gate passed: CLI, host, web, and the packed fresh-install proof are all green. Deployed to <strong>codor.app</strong> 🚀 Everything is green ✅</p></div>
              <div className="nx-batch"><span className="nx-batch-line is-active"><Upload size={14} aria-hidden="true" />Production deployment complete · 0 regressions</span></div>
            </DemoTurn>
          )}
              </ol>
              {active && <DemoTyping actor={active.actor} accent={active.accent} />}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function HarnessRail() {
  return (
    <div className="nx-harness-wrap">
      <div className="nx-harness-rail" aria-label="Supported coding harnesses" tabIndex={0}>
        {HARNESSES.map((id) => (
          <span className="nx-harness-logo" key={id} title={harnessLabel(id)}>
            {harnessMark(id, 28)}
            <span>{harnessLabel(id)}</span>
          </span>
        ))}
      </div>
      <p className="nx-subscription-line">Works with your Claude and ChatGPT subscriptions too</p>
    </div>
  );
}

function HeroActivity() {
  const activity = [
    { name: 'Fable 5', accent: 'green' as const, label: 'is orchestrating', className: 'is-fable' },
    { name: 'GPT 5.6', accent: 'indigo' as const, label: 'is reviewing', className: 'is-gpt' },
    { name: 'Opus', accent: 'violet' as const, label: 'is coding', className: 'is-opus' },
    { name: 'Luna', accent: 'green' as const, label: 'is researching', className: 'is-luna' },
  ];
  return (
    <div className="nx-hero-activity" aria-hidden="true">
      {activity.map((item) => (
        <span className={`nx-hero-typing ${item.className}`} key={item.name}>
          <Chip name={item.name} accent={item.accent} size={26} />
          <span><strong>{item.name}</strong> {item.label}</span>
          <TypingDots />
        </span>
      ))}
    </div>
  );
}

function WorkflowStory() {
  const reduced = useMemo(prefersReducedMotion, []);
  const [sectionRef, entered, visible] = useViewportPresence<HTMLElement>(0.3);
  const [active, setActive] = useState(0);

  useEffect(() => {
    // Gate rotation on live visibility so it stops once scrolled past.
    if (reduced || !visible) return;
    const timer = window.setInterval(() => setActive((current) => (current + 1) % WORKFLOWS.length), 4_800);
    return () => window.clearInterval(timer);
  }, [visible, reduced]);

  const workflow = WORKFLOWS[active] ?? WORKFLOWS[0];
  const meteorGradient = `workflow-meteor-${workflow.layout}`;
  return (
    <section ref={sectionRef} className={`nx-landing-story is-split nx-workflow-story ${entered ? 'is-entered' : ''}`} aria-labelledby="workflow-title">
      <div className="nx-story-copy">
        <p className="nx-landing-kicker">Compose the team</p>
        <h2 id="workflow-title">Multi-agent workflows, with ease.</h2>
        <p>Choose who leads, who builds, and who challenges the result. Codor keeps the whole group in one conversation even when the shape of the team changes.</p>
      </div>
      <div className="nx-workflow-visual" aria-live="polite">
        <header>
          <span><Sparkles size={15} aria-hidden="true" /> Workflow {active + 1} of {WORKFLOWS.length}</span>
          <strong>{workflow.label}</strong>
        </header>
        <div className={`nx-workflow-map is-${workflow.layout}`} key={workflow.label}>
          <svg className={`nx-workflow-links ${visible ? 'is-live' : ''}`} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id={meteorGradient} x1="-8" y1="0" x2="1" y2="0" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="var(--c-agent)" stopOpacity="0" />
                <stop offset="0.62" stopColor="var(--c-agent)" stopOpacity="0.55" />
                <stop offset="1" stopColor="var(--c-agent)" stopOpacity="1" />
              </linearGradient>
            </defs>
            {workflow.routes.map((route, index) => {
              const routeId = `workflow-${workflow.layout}-${String(index)}`;
              const duration = 2.4 + index * 0.28;
              const delay = index * 0.44;
              return (
                <g key={routeId}>
                  <path className="nx-workflow-route" id={routeId} d={route} />
                  {visible && !reduced && (
                    <g className="nx-workflow-meteor" opacity="0">
                      <path className="nx-workflow-meteor-tail" d="M -10 -2 L 0.2 0 L -10 2 L -6 0 Z" fill={`url(#${meteorGradient})`} />
                      <path className="nx-workflow-meteor-head" d="M -1.4 -1.65 L 1.5 0 L -1.4 1.65 Z" />
                      <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.14;0.84;1" dur={`${String(duration)}s`} begin={`${String(delay)}s`} repeatCount="indefinite" />
                      <animateMotion rotate="auto" dur={`${String(duration)}s`} begin={`${String(delay)}s`} repeatCount="indefinite">
                        <mpath href={`#${routeId}`} />
                      </animateMotion>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>
          {workflow.roles.map((member, index) => {
            const RoleIcon = member.icon;
            return (
              <article className={`nx-workflow-role is-${member.slot} is-${member.weight} is-${member.accent}`} key={`${workflow.label}-${member.name}`}>
                <span className="nx-workflow-harness" title={`${harnessLabel(member.harness)} harness`}>
                  {harnessMark(member.harness, 28)}
                  <i aria-hidden="true" />
                </span>
                <span className="nx-workflow-identity">
                  <small><RoleIcon size={12} aria-hidden="true" /> {member.role}</small>
                  <strong>{member.name}</strong>
                </span>
                <ul>
                  {member.responsibilities.map((responsibility) => <li key={responsibility}>{responsibility}</li>)}
                </ul>
                <span className="nx-workflow-output"><i aria-hidden="true" /> {member.output}</span>
                <i className="nx-workflow-order" aria-hidden="true">{index + 1}</i>
              </article>
            );
          })}
        </div>
        <footer><Check size={15} aria-hidden="true" /> {workflow.outcome}</footer>
        <div className="nx-workflow-dots" aria-hidden="true">
          {WORKFLOWS.map((item, index) => <i className={index === active ? 'is-active' : ''} key={item.label} />)}
        </div>
      </div>
    </section>
  );
}

function ConnectivityMap() {
  return (
    <div className="nx-connectivity-map" aria-label="Devices connect privately to any Codor computer">
      <svg viewBox="0 0 600 360" preserveAspectRatio="none" aria-hidden="true">
        <path d="M191 117 C204 117 201 180 213 180" />
        <path d="M191 180 H213" />
        <path d="M191 243 C204 243 201 180 213 180" />
        <path d="M362 180 C374 180 371 117 384 117" />
        <path d="M362 180 H384" />
        <path d="M362 180 C374 180 371 243 384 243" />
      </svg>
      <div className="nx-connectivity-sources">
        <span><Monitor aria-hidden="true" /><strong>Desktop</strong></span>
        <span><Smartphone aria-hidden="true" /><strong>Mobile</strong></span>
        <span><Terminal aria-hidden="true" /><strong>CLI</strong></span>
      </div>
      <div className="nx-connectivity-core">
        <LockKeyhole aria-hidden="true" />
        <strong>E2E encrypted relay</strong>
        <small>or direct connection</small>
        <i aria-hidden="true" />
      </div>
      <div className="nx-connectivity-hosts">
        <span><Laptop aria-hidden="true" /><strong>Studio Mac</strong><small>relay-ui</small></span>
        <span><Server aria-hidden="true" /><strong>Workstation</strong><small>compiler</small></span>
        <span><Server aria-hidden="true" /><strong>GPU box</strong><small>evals</small></span>
      </div>
    </div>
  );
}

const VOICE_ENVELOPE = [
  0.08, 0.12, 0.2, 0.36, 0.58, 0.76, 0.62, 0.86, 0.7, 0.43, 0.2, 0.1,
  0.09, 0.18, 0.38, 0.68, 0.91, 0.73, 0.48, 0.24, 0.11,
  0.08, 0.16, 0.33, 0.57, 0.78, 0.66, 0.84, 0.52, 0.27, 0.12,
  0.09, 0.22, 0.42, 0.25, 0.1,
] as const;

// A deterministic speech envelope: phrase clusters rise and decay around short
// pauses, while each animation frame adds small asymmetric syllable energy.
const VOICE_LEVELS = Array.from({ length: 18 }, (_, frame) => VOICE_ENVELOPE.map((base, index) => {
  const syllable = 0.86 + 0.16 * Math.sin(frame * 0.92 + index * 1.71);
  const formant = 0.93 + 0.09 * Math.sin(frame * 0.47 - index * 0.63);
  return Math.max(0.07, Math.min(0.98, base * syllable * formant));
}));

function VoiceVisual() {
  const reduced = useMemo(prefersReducedMotion, []);
  const [visualRef, , visible] = useViewportPresence<HTMLDivElement>(0.45);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    // Live visibility: the 92ms waveform interval must not run offscreen.
    if (reduced || !visible) return;
    const timer = window.setInterval(() => setFrame((current) => (current + 1) % VOICE_LEVELS.length), 92);
    return () => window.clearInterval(timer);
  }, [visible, reduced]);

  const levels = VOICE_LEVELS[frame] ?? VOICE_ENVELOPE;
  return (
    <div ref={visualRef} className="nx-feature-visual nx-voice-visual" aria-label="Voice control preview">
      <div className="nx-voice-recording"><span><Mic size={17} aria-hidden="true" /> Recording 0:08</span><i /></div>
      <div className="nx-voice-wave" aria-hidden="true">
        {levels.map((level, index) => (
          <i key={String(index)} style={{ '--voice-level': String(level) } as CSSProperties} />
        ))}
      </div>
      <div className="nx-voice-transcript"><AudioLines size={16} aria-hidden="true" /><span>“Ask Opus to tighten the mobile layout, then have GPT review it.”</span></div>
    </div>
  );
}

function ContextRing({ value }: { value: number }) {
  return (
    <span className="nx-landing-context" title={`${String(value)}% context window used`}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="8" pathLength="100" />
        <circle className="is-progress" cx="10" cy="10" r="8" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - value} />
      </svg>
      <small>{value}% context</small>
    </span>
  );
}

function LimitsVisual() {
  const reduced = useMemo(prefersReducedMotion, []);
  const [visualRef, , visible] = useViewportPresence<HTMLDivElement>(0.48);
  const [drain, setDrain] = useState(0);

  useEffect(() => {
    if (reduced || !visible || drain >= 9) return;
    const timer = window.setTimeout(() => setDrain((current) => Math.min(9, current + 1)), 2_200);
    return () => window.clearTimeout(timer);
  }, [drain, reduced, visible]);

  const members = [
    { name: 'Richard', handle: 'richard', detail: 'Channel owner', accent: 'user' as const, human: true, state: 'Owner', context: 0, fiveHour: 0, weekly: 0 },
    { name: 'Fable 5', handle: 'fable', detail: 'claude-code · opus', accent: 'green' as const, human: false, state: 'Idle', context: 32, fiveHour: 72 - drain, weekly: 18 - Math.floor(drain / 3) },
    { name: 'GPT 5.6', handle: 'codex', detail: 'codex · gpt-5.6', accent: 'indigo' as const, human: false, state: 'Working', context: 68, fiveHour: 43 - Math.floor(drain * 0.78), weekly: 61 - Math.floor(drain / 2) },
  ];
  return (
    <div ref={visualRef} className="nx-feature-visual nx-limits-visual" aria-label="People and agents with live usage limits">
      <header>
        <strong>People &amp; agents</strong>
        <span><RefreshCw size={13} aria-hidden="true" /> Updated now</span>
        <button type="button" tabIndex={-1} aria-label="Add agent"><Plus size={14} aria-hidden="true" /></button>
      </header>
      <div className="nx-landing-roster">
        {members.map((member) => (
          <article className={`nx-landing-member ${member.human ? 'is-owner' : ''}`} key={member.name}>
            <div className="nx-landing-member-row">
              <Chip name={member.name} accent={member.accent} size={31} presence={member.human ? undefined : member.state === 'Working' ? 'live' : 'idle'} />
              <span className="nx-landing-member-id"><strong>@{member.handle}</strong><small>{member.detail}</small></span>
              {member.human
                ? <span className="nx-landing-owner">Owner</span>
                : <StatusPill tone={member.state === 'Working' ? 'live' : 'neutral'}>{member.state}</StatusPill>}
            </div>
            {!member.human && (
              <div className="nx-landing-member-detail">
                <ContextRing value={member.context} />
                <div className="nx-landing-member-limits">
                  <span><b>5h usage</b><small>{member.fiveHour}% left</small><i><em style={{ '--limit-width': `${String(member.fiveHour)}%` } as CSSProperties} /></i></span>
                  <span><b>Weekly</b><small>{member.weekly}% left</small><i><em style={{ '--limit-width': `${String(member.weekly)}%` } as CSSProperties} /></i></span>
                </div>
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

function ReviewVisual() {
  const [visualRef, entered] = useEnteredViewport<HTMLDivElement>(0.45);

  return (
    <div ref={visualRef} className={`nx-feature-visual nx-review-visual ${entered ? 'is-entered' : ''}`} aria-label="Preview gallery and diff viewer">
      <section className="nx-review-window nx-review-preview-window" aria-label="Attachment preview">
        <header><span><Eye size={13} aria-hidden="true" /> Preview</span><small>2 attachments</small></header>
        <div className="nx-review-gallery">
          <article className="nx-review-image-card"><div className="nx-review-image-placeholder"><FileImage size={34} aria-hidden="true" /><span>Image preview</span></div><strong>mobile-reference.png</strong><small>Image · #527 · 164 KB</small></article>
          <article className="nx-review-doc-card"><FileText size={22} aria-hidden="true" /><strong>handoff.md</strong><small>Document · #531 · 8 KB</small><span>Download</span></article>
        </div>
      </section>
      <section className="nx-review-window nx-review-diff-window" aria-label="Git diff and history">
        <header><span><GitCompareArrows size={13} aria-hidden="true" /> Diff</span><small><span className="nx-stat-add">+84</span> <span className="nx-stat-del">−31</span></small></header>
        <div className="nx-review-diff">
          <aside className="nx-review-history">
            <div className="nx-review-history-toggle"><ChevronRight className="is-open" size={13} aria-hidden="true" /><strong>Working tree / HEAD</strong><small>History</small></div>
            <div className="nx-review-history-list">
              <span className="is-active"><b>Working tree / HEAD</b><small>Live</small></span>
              <span><b>Expand landing workflow story</b><code>5f0811a</code><small>Richard · now</small></span>
              <span><b>Polish landing product visuals</b><code>8c5e961</code><small>Richard · 24m</small></span>
              <span><b>Deepen landing product story</b><code>15b7a00</code><small>Richard · 38m</small></span>
            </div>
          </aside>
          <div className="nx-review-patch">
            <header><code>LandingPage.tsx</code><span className="nx-stat-add">+84</span><span className="nx-stat-del">−31</span></header>
            <code className="is-meta">@@ -286,8 +286,14 @@</code>
            <code className="is-del">- The whole team sees the work.</code>
            <code className="is-add">+ The team works through it together.</code>
            <code className="is-add">+ Ran 3 tools · wrote 2 files</code>
            <code>  Independent review is clean.</code>
          </div>
        </div>
      </section>
    </div>
  );
}

function AttachmentVisual() {
  return (
    <div className="nx-feature-visual nx-attachment-visual" aria-label="Automatic attachment sending">
      <div className="nx-attachment-drop"><Upload size={19} aria-hidden="true" /><span><strong>Drop files into the conversation</strong><small>Codor uploads and attaches them to your next message.</small></span></div>
      <div className="nx-attachment-files">
        <span><FileImage size={16} aria-hidden="true" /><b>mobile-reference.png</b><small>164 KB</small></span>
        <span><FileText size={16} aria-hidden="true" /><b>review-notes.md</b><small>8 KB</small></span>
      </div>
      <div className="nx-attachment-send"><span>Give these to Fable and ask for one pass.</span><i><Send size={14} aria-hidden="true" /></i></div>
    </div>
  );
}

function FeatureSection(props: {
  id: string;
  kicker: string;
  title: string;
  body: string;
  icon: LucideIcon;
  visual: ReactNode;
  reverse?: boolean;
}) {
  const Icon = props.icon;
  const [sectionRef, entered] = useEnteredViewport<HTMLElement>(0.25);
  return (
    <section ref={sectionRef} className={`nx-landing-story is-split nx-compact-feature ${entered ? 'is-entered' : ''} ${props.reverse ? 'is-reverse' : ''}`} aria-labelledby={props.id}>
      <div className="nx-story-copy">
        <p className="nx-landing-kicker"><Icon size={13} aria-hidden="true" /> {props.kicker}</p>
        <h2 id={props.id}>{props.title}</h2>
        <p>{props.body}</p>
      </div>
      {props.visual}
    </section>
  );
}

function ConnectivityStory() {
  const [sectionRef, entered] = useEnteredViewport<HTMLElement>(0.24);
  return (
    <section ref={sectionRef} className={`nx-landing-story is-split nx-connectivity-story ${entered ? 'is-entered' : ''}`} aria-labelledby="computers-title">
      <div className="nx-story-copy">
        <p className="nx-landing-kicker"><Network size={13} aria-hidden="true" /> Runs where you work</p>
        <h2 id="computers-title">Every computer. Every device. Still private.</h2>
        <p>
          Start agents on your laptop, workstation, or remote box. Use the same room from desktop, mobile, or
          terminal over a direct connection or the end-to-end encrypted relay. The relay connects the devices;
          it never receives your channel keys.
        </p>
        <div className="nx-connectivity-facts">
          <span><ShieldCheck size={14} aria-hidden="true" /> Relay sees ciphertext only</span>
          <span><Users size={14} aria-hidden="true" /> No Codor account required</span>
        </div>
      </div>
      <ConnectivityMap />
    </section>
  );
}

function ProductStories() {
  return (
    <div className="nx-product-stories">
      <WorkflowStory />
      <ConnectivityStory />

      <FeatureSection id="voice-title" kicker="Talk it through" title="Voice control that stays in the room." body="Record one thought or several takes, choose the agent, and send the transcript into the same conversation. Codor keeps the voice note beside the words it produced." icon={Mic} visual={<VoiceVisual />} />
      <FeatureSection id="limits-title" kicker="Always current" title="Limits update themselves." body="Account usage and context pressure refresh while the agents work, so you know who has room for the next task without checking every provider by hand." icon={Gauge} visual={<LimitsVisual />} reverse />
      <FeatureSection id="review-title" kicker="See the result" title="Preview the app. Inspect the diff." body="Keep the working UI and the files that changed together. Move from the browser preview to the exact additions and deletions without leaving the channel." icon={GitCompareArrows} visual={<ReviewVisual />} />
      <FeatureSection id="attachments-title" kicker="Context included" title="Attachments go with the ask." body="Drop screenshots, design references, logs, or notes into the composer. Codor uploads them once and attaches them to the message automatically." icon={Upload} visual={<AttachmentVisual />} reverse />
    </div>
  );
}

export function LandingPage() {
  const queryCode = useMemo(() => new URL(window.location.href).searchParams.get('code') ?? '', []);
  const [pairing, setPairing] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Trusted same-origin enrollment only makes sense on a self-hosted,
    // switchboard-served SPA. The hosted app's origin is the relay (no switchboard
    // to trust), so skip the probe there rather than fire a cross-purpose request.
    if (relayUrlConfigured()) return undefined;
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
        <div className="nx-landing-nav-actions">
          <a href="#conversation">See it work</a>
          <a className="nx-nav-cta" href="#get-started">Get started</a>
        </div>
      </nav>

      <section className="nx-landing-hero" aria-labelledby="landing-title">
        <div className="nx-landing-intro">
          <div className="nx-hero-title-stage">
            <HeroActivity />
            <h1 id="landing-title">Fable 5 and GPT 5.6 on the same team? <mark>That's just unfair</mark></h1>
          </div>
          <HarnessRail />
        </div>

        <div className="nx-setup-shell" id="get-started">
          <div className="nx-setup-heading">
            <span><Globe2 size={16} aria-hidden="true" /> Your private Codor</span>
            <strong>Two steps. No account.</strong>
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
                    // A device-network problem must never be blamed on the code.
                    if (typeof navigator !== 'undefined' && !navigator.onLine) {
                      setFailure(SESSION_COPY['device-offline'].body);
                      return;
                    }
                    setPairing(true);
                    setFailure(undefined);
                    const relayUrl = relayUrlConfigured();
                    // pairThroughRelay carries its own abortable deadline, so a dead
                    // room (host never joins) rejects here instead of hanging forever.
                    const flow = relayUrl
                      ? pairThroughRelay(code, relayUrl).then(() => window.location.replace('/'))
                      : exchangeBrowserPairingCode(code).then((url) => window.location.assign(url.toString()));
                    void flow.catch(() => {
                      setPairing(false);
                      // Offline AT rejection time is a device problem, not a bad code.
                      if (typeof navigator !== 'undefined' && !navigator.onLine) {
                        setFailure(SESSION_COPY['device-offline'].body);
                        return;
                      }
                      setFailure(
                        relayUrl
                          // Pairing-time host-never-joins/code-bad (incl. the dead-room
                          // case): a fresh code, not re-pair. Single-sourced copy.
                          ? PAIRING_TIME_COPY['code-bad'].body
                          : 'Pairing code not found. Run setup again for a fresh code.',
                      );
                    });
                  }}
                />
                <a className="nx-pair-link" href="/pair">Have a full pairing link?</a>
              </div>
            </article>
          </div>
          <p className="nx-setup-foot"><ShieldCheck size={15} aria-hidden="true" /> Use it on localhost, over Tailscale, or through the encrypted relay.</p>
        </div>
      </section>

      <div id="conversation"><CollaborationDemo /></div>
      <ProductStories />

      <section className="nx-final-cta" aria-labelledby="final-cta-title">
        <span className="nx-final-mark" aria-hidden="true" />
        <p className="nx-landing-kicker">Your channel is waiting</p>
        <h2 id="final-cta-title">Put the unfair team to work.</h2>
        <a href="#get-started">Set up Codor <ArrowRight size={16} aria-hidden="true" /></a>
      </section>

      <footer className="nx-landing-footer">
        <span>Codor</span>
        <span className="nx-footer-private"><LockKeyhole size={13} aria-hidden="true" /> Private and self-hosted</span>
        <a href="https://github.com/rjx18/codor">Source and documentation</a>
      </footer>
    </main>
  );
}
