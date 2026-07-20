import type { AgentLimit, Member, Policy, Room, RunItemDiff, ThinkingLevel, WireEvent } from '@codor/protocol';
import { LoaderCircle, Minimize2, MoreVertical, Plus, Square, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { fetchRunEvents, type AdapterRegistration, type MemberDetail } from '@legacy/api.js';
import { AgentControls, Section } from './AgentControls.js';
import { FolderPicker } from './FolderPicker.js';
import {
  DEFAULT_POLICY,
  type AgentConfig,
  type SpawnSpec,
  buildSpawnSpec,
  applyPreset,
  asPolicy,
  channelOwner,
  collidesWithOwner,
  HANDLE_PATTERN,
  defaultSpawnCwd,
  effectiveHarness,
  resolveSpawn,
  supportedThinking,
} from './agent-spec.js';
import { presentRunEvents, type RunRow } from '@legacy/run-presenter.js';
import type { Connection } from '@legacy/ws.js';

import { roomSlice, sortedMessages, useClientStore } from '../app/store.js';
import { clockTime, compactCount, memberAccent } from '../primitives/identity.js';
import { Button, Chip, Eyebrow, IconButton, Modal, Segmented, StatusPill } from '../primitives/primitives.js';
import { useAdapters, useMemberDetails } from '../app/session.js';
import { ContextWindowMeter } from './ContextWindowMeter.js';
import { cachedGitWorkingState, fetchGitWorkingState, rememberGitWorkingState, shortenCwd, statusLetter, type GitWorkingState } from './git-diff.js';
import { costProvenanceLabel } from './spend-label.js';

type Tab = 'members' | 'diff' | 'preview';

/** A chat diff chip asks the Diff tab to focus a file's CURRENT working-tree
 *  diff. Carried as a window CustomEvent, like nx-quote. */
export const OPEN_DIFF_EVENT = 'nx-open-diff';

export function ContextPanel(props: { room: string; token: () => string; connection: Connection }) {
  const [tab, setTab] = useState<Tab>('members');
  const [focus, setFocus] = useState<{ path: string; nonce: number }>();
  const focusCount = useRef(0);

  // A diff chip anywhere in the transcript opens this tab focused on its file.
  useEffect(() => {
    const onOpenDiff = (event: Event): void => {
      const path = (event as CustomEvent<{ path: string }>).detail?.path;
      if (path === undefined) return;
      focusCount.current += 1;
      setTab('diff');
      setFocus({ path, nonce: focusCount.current });
    };
    window.addEventListener(OPEN_DIFF_EVENT, onOpenDiff);
    return () => window.removeEventListener(OPEN_DIFF_EVENT, onOpenDiff);
  }, []);

  return (
    <aside className="nx-context" aria-label="Channel context">
      <div className="nx-context-tabs">
        <Segmented<Tab>
          label="Context"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'members', label: 'Members', testid: 'context-tab-members' },
            { value: 'diff', label: 'Diff', testid: 'context-tab-diff' },
            { value: 'preview', label: 'Preview', testid: 'context-tab-preview' },
          ]}
        />
      </div>
      {tab === 'members' && <MembersTab room={props.room} token={props.token} connection={props.connection} />}
      {tab === 'diff' && <DiffTab room={props.room} token={props.token} focus={focus} />}
      {tab === 'preview' && <PreviewTab room={props.room} token={props.token} />}
    </aside>
  );
}

// ── Members: owner first, then agents; cards carry account + spend; the six
// lifecycle actions live in a kebab dropdown with confirm flows. ────────────

function MembersTab(props: { room: string; token: () => string; connection: Connection }) {
  const members = useClientStore((state) => roomSlice(state, props.room).members);
  const selfId = useClientStore((state) => roomSlice(state, props.room).selfMemberId);
  const details = useMemberDetails(props.room, props.token);
  const adapters = useAdapters(props.token);
  const [spawning, setSpawning] = useState(false);
  // A spawn is only done when the member actually appears. Watching for it — and
  // for a room error naming it — is what keeps a failure visible instead of
  // closing the dialog on a request that was merely *sent*.
  const [pendingHandle, setPendingHandle] = useState<string>();
  const [spawnFailure, setSpawnFailure] = useState<string>();
  const roomErrors = useClientStore((state) => roomSlice(state, props.room).errors);
  const room = useClientStore((state) => roomSlice(state, props.room).room);
  const seenErrors = useRef(0);

  // Interrupt is an owner/admin act (matrix gates it at admin), so only they see
  // the Stop control — the server would refuse anyone else anyway. The lifecycle
  // kebab is owner/admin too, for consistency with the newer controls.
  const selfRole = selfId !== undefined ? members[selfId]?.role : undefined;
  const canStop = selfRole === 'owner' || selfRole === 'admin';
  const canManage = selfRole === 'owner' || selfRole === 'admin';

  // Resolve the pending spawn. Success is the member with the handle we submitted
  // arriving — matching on "membership changed" would let an unrelated member
  // joining report success, trading a silent failure for a false one.
  useEffect(() => {
    if (pendingHandle === undefined) return;
    const outcome = resolveSpawn({
      handle: pendingHandle,
      members: Object.values(members),
      freshErrors: roomErrors.slice(seenErrors.current),
    });
    if (outcome.state === 'arrived') {
      setPendingHandle(undefined);
      setSpawnFailure(undefined);
      setSpawning(false);
    } else if (outcome.state === 'failed') {
      setSpawnFailure(outcome.message);
      setPendingHandle(undefined);
    }
  }, [members, roomErrors, pendingHandle]);

  // A spawn that neither lands nor names itself in an error must not leave the
  // dialog disabled forever. After the grace period say so plainly rather than
  // inventing a cause.
  useEffect(() => {
    if (pendingHandle === undefined) return undefined;
    const timer = setTimeout(() => {
      setSpawnFailure(`No response for @${pendingHandle}. It may still be starting — check the roster before retrying.`);
      setPendingHandle(undefined);
    }, 20_000);
    return () => { clearTimeout(timer); };
  }, [pendingHandle]);

  const roster = useMemo(() => {
    // Extensions are transient run machinery — the roster lists durable members.
    // The structural system member is routing machinery, not a person or agent.
    // Keep this surface truthful by listing only the two addressable member kinds.
    const active = Object.values(members).filter(
      (m) => m.removed_ts === undefined && (m.kind === 'human' || m.kind === 'agent'),
    );
    const humans = active.filter((m) => m.kind === 'human');
    const agents = active.filter((m) => m.kind === 'agent');
    return [...humans, ...agents];
  }, [members]);

  return (
    <div className="nx-members">
      <div className="nx-members-head">
        <Eyebrow>People &amp; agents</Eyebrow>
        <IconButton
          icon={Plus}
          label="Spawn agent"
          size="sm"
          variant="quiet"
          data-testid="spawn-agent"
          onClick={() => setSpawning(true)}
        />
      </div>
      <ul className="nx-roster">
        {roster.map((member) => (
          <MemberCard
            key={member.id}
            member={member}
            detail={details[member.id]}
            adapters={adapters}
            canStop={canStop}
            canManage={canManage}
            connection={props.connection}
            room={props.room}
          />
        ))}
      </ul>
      {spawning && (
        <SpawnDialog
          adapters={adapters}
          token={props.token}
          room={room}
          members={roster}
          pending={pendingHandle !== undefined}
          failure={spawnFailure}
          onClose={() => { setSpawning(false); setPendingHandle(undefined); setSpawnFailure(undefined); }}
          onSpawn={(spec) => {
            seenErrors.current = roomErrors.length;
            setSpawnFailure(undefined);
            setPendingHandle(spec.handle);
            props.connection.act({ act: 'spawn', ...spec });
          }}
        />
      )}
    </div>
  );
}

function MemberCard(props: {
  member: Member;
  detail: MemberDetail | undefined;
  adapters: AdapterRegistration[];
  canStop: boolean;
  canManage: boolean;
  connection: Connection;
  room: string;
}) {
  const { member, detail } = props;
  // Stop interrupts an in-flight turn; a queued agent has nothing to interrupt.
  const running = member.state === 'running';
  const [menu, setMenu] = useState(false);
  const [confirming, setConfirming] = useState<'kill' | 'remove'>();
  const [renaming, setRenaming] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [menu]);

  const spend = detail?.spend;
  const tokens = spend !== undefined ? spend.input_tokens + spend.output_tokens : undefined;

  // Compaction is a round trip to the engine with no run to watch, so the card
  // owns the only evidence the operator has that their click did anything. It
  // clears on the completion edge the daemon emits for this member after every
  // successful compaction — or on a new action error, which is the other way
  // the request can end. Both are edges, so a stale spinner cannot survive.
  const [compacting, setCompacting] = useState(false);
  const errorCount = useClientStore((state) => roomSlice(state, props.room).errors.length);
  const startedAt = useRef<{ errors: number; member: Member } | null>(null);
  useEffect(() => {
    const started = startedAt.current;
    if (!compacting || started === null) return;
    // Watch the MEMBER's identity, not its usage: a successful compaction that
    // re-baselines nothing leaves lastUsage undefined, and watching that field
    // would hang the spinner on exactly the case the daemon's edge exists for.
    // The completion frame round-trips through JSON and a store upsert, so the
    // member object is always a new reference.
    if (errorCount > started.errors || member !== started.member) {
      startedAt.current = null;
      setCompacting(false);
    }
  }, [compacting, errorCount, member]);

  return (
    <li className="nx-member" data-testid={`member-${member.handle}`}>
      <div className="nx-member-row">
        <Chip name={member.handle} accent={memberAccent(member)} size={32} />
        <span className="nx-member-id">
          <strong>@{member.handle}</strong>
          <span className="nx-member-sub">
            {member.kind === 'human'
              ? member.display_name
              : [member.harness, member.model, member.policy].filter(Boolean).join(' · ') || 'agent'}
          </span>
        </span>
        <span className="nx-member-state">
          {member.kind === 'human'
            ? <Eyebrow>{member.role ?? 'human'}</Eyebrow>
            : <MemberStateWord state={member.state} />}
        </span>
        {/* harn:assume member-context-window-meter-derived-from-last-usage ref=context-window-meter-wiring */}
        {member.kind === 'agent' && (
          <ContextWindowMeter
            usage={member.lastUsage}
            pending={member.state === 'running'}
            testId={`member-${member.handle}-context-window`}
          />
        )}
        {/* harn:end member-context-window-meter-derived-from-last-usage */}
        {member.kind === 'agent' && props.canManage && (
          // Beside the ring, because the ring is what makes an operator want it.
          // Never hidden while running — hiding it would read as "not available
          // here"; disabled with the reason keeps the lever discoverable.
          <button
            type="button"
            className="nx-member-compact"
            aria-label={`Compact @${member.handle}'s context`}
            data-testid={`member-${member.handle}-compact`}
            disabled={member.state !== 'idle' || compacting}
            title={running
              ? 'Stop the run first — compacting mid-turn would race the engine'
              : member.state !== 'idle'
                ? `Only an idle agent can be compacted — @${member.handle} is ${member.state}`
                : compacting
                  ? 'Compacting this agent\u2019s engine session…'
                  : 'Compact this agent\u2019s engine session'}
            data-compacting={compacting ? 'true' : undefined}
            onClick={() => {
              startedAt.current = { errors: errorCount, member };
              setCompacting(true);
              props.connection.act({ act: 'compact_member', member_id: member.id });
            }}
          >
            {compacting
              ? <LoaderCircle size={13} className="nx-spin" aria-hidden="true" />
              : <Minimize2 size={13} aria-hidden="true" />}
          </button>
        )}
        {member.kind === 'agent' && running && props.canStop && (
          <button
            type="button"
            className="nx-member-stop"
            aria-label={`Stop @${member.handle}`}
            data-testid={`member-${member.handle}-stop`}
            title="Stop this run (the agent stays alive)"
            onClick={() => props.connection.act({ act: 'interrupt', member_id: member.id })}
          >
            <Square size={13} aria-hidden="true" />
          </button>
        )}
        {member.kind === 'agent' && props.canManage && (
          <div className="nx-member-menu" ref={menuRef}>
            <IconButton
              icon={MoreVertical}
              label={`Actions for @${member.handle}`}
              size="sm"
              variant="quiet"
              data-testid={`member-${member.handle}-menu`}
              onClick={() => setMenu((v) => !v)}
            />
            {menu && (
              <div className="nx-menu" role="menu" aria-label={`@${member.handle} actions`}>
                <button role="menuitem" onClick={() => { setMenu(false); setRenaming(true); }}>Rename…</button>
                <button role="menuitem" onClick={() => { setMenu(false); setConfiguring(true); }}>Configure…</button>
                {member.state === 'dead' ? (
                  <button
                    role="menuitem"
                    data-testid={`member-${member.handle}-revive`}
                    onClick={() => {
                      setMenu(false);
                      props.connection.act({ act: 'revive', member_id: member.id });
                    }}
                  >
                    Revive
                  </button>
                ) : (
                  <button role="menuitem" className="is-danger" onClick={() => { setMenu(false); setConfirming('kill'); }}>
                    Kill…
                  </button>
                )}
                <button role="menuitem" className="is-danger" onClick={() => { setMenu(false); setConfirming('remove'); }}>
                  Remove…
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      {member.kind === 'agent' && (spend !== undefined || (detail?.queued_count ?? 0) > 0) && (
        <p className="nx-member-meter">
          {tokens !== undefined ? `${compactCount(tokens)} tokens` : ''}
          {spend !== undefined ? ` · ${costProvenanceLabel(spend)} · ${spend.turns} turns` : ''}
          {(detail?.queued_count ?? 0) > 0 ? ` · ${detail?.queued_count} queued` : ''}
        </p>
      )}
      {member.limits !== undefined && member.limits.length > 0 && (
        <p className="nx-member-limits" data-testid={`member-${member.handle}-limits`}>
          {member.limits.map((limit) =>
            limit.used_percent !== undefined
              ? <LimitGauge key={limit.window} limit={limit} />
              : (
                <span key={limit.window} className={`nx-limit is-${limit.status ?? 'unknown'}`}>
                  {limitWindowLabel(limit.window)}: {(limit.status ?? 'reported').replace(/_/g, ' ')}
                  {limit.resets_at !== undefined ? ` · resets ${clockTime(limit.resets_at)}` : ''}
                </span>
              ),
          )}
        </p>
      )}

      {confirming !== undefined && (
        <Modal
          label={confirming === 'kill' ? `Kill @${member.handle}?` : `Remove @${member.handle}?`}
          onClose={() => setConfirming(undefined)}
          alert
          testid="member-confirm"
        >
          <h2 className="nx-dialog-title">
            {confirming === 'kill' ? `Kill @${member.handle}?` : `Remove @${member.handle}?`}
          </h2>
          <p className="nx-dialog-body">
            {confirming === 'kill'
              ? 'The running session ends now; queued work stays queued and the agent can be revived later.'
              : 'The member leaves the roster. Queued work addressed to it is consumed.'}
          </p>
          <div className="nx-dialog-actions">
            <Button variant="quiet" onClick={() => setConfirming(undefined)}>Cancel</Button>
            <Button
              variant="danger"
              data-testid="member-confirm-go"
              onClick={() => {
                props.connection.act(
                  confirming === 'kill'
                    ? { act: 'kill', member_id: member.id }
                    : { act: 'remove', member_id: member.id },
                );
                setConfirming(undefined);
              }}
            >
              {confirming === 'kill' ? 'Kill session' : 'Remove member'}
            </Button>
          </div>
        </Modal>
      )}

      {renaming && (
        <RenameDialog
          member={member}
          onClose={() => setRenaming(false)}
          onRename={(handle, displayName) => {
            props.connection.act({
              act: 'rename',
              member_id: member.id,
              handle,
              ...(displayName !== '' && { display_name: displayName }),
            });
            setRenaming(false);
          }}
        />
      )}
      {configuring && (
        <ConfigureDialog
          member={member}
          adapters={props.adapters}
          onClose={() => setConfiguring(false)}
          onConfigure={(patch) => {
            props.connection.act({ act: 'configure', member_id: member.id, ...patch });
            setConfiguring(false);
          }}
        />
      )}
    </li>
  );
}

function limitWindowLabel(window: string): string {
  if (window === 'five_hour') return '5h';
  if (window === 'seven_day' || window === 'weekly') return 'weekly';
  return window.replace(/_/g, ' ');
}

/** Mini horizontal gauge for a harness-reported window: how much is LEFT. */
function LimitGauge(props: { limit: AgentLimit }) {
  const left = Math.max(0, Math.round(100 - (props.limit.used_percent ?? 0)));
  const tone = left < 15 ? 'error' : left < 40 ? 'warn' : 'ok';
  return (
    <span
      className={`nx-gauge is-${tone}`}
      title={props.limit.resets_at !== undefined ? `resets ${clockTime(props.limit.resets_at)}` : undefined}
    >
      <span className="nx-gauge-label">{limitWindowLabel(props.limit.window)}</span>
      <span className="nx-gauge-track" aria-hidden="true">
        <span className="nx-gauge-fill" style={{ width: `${left}%` }} />
      </span>
      <span className="nx-gauge-value">{left}% left</span>
    </span>
  );
}

function MemberStateWord(props: { state: Member['state'] }) {
  const tone = props.state === 'running' || props.state === 'queued'
    ? 'live'
    : props.state === 'dead'
      ? 'error'
      : 'neutral';
  const word = props.state === 'running' || props.state === 'queued'
    ? 'Working'
    : props.state === 'dead'
      ? 'Dead'
      : props.state === 'awaiting_input'
        ? 'Waiting'
        : 'Idle';
  return <StatusPill tone={tone}>{word}</StatusPill>;
}

function RenameDialog(props: {
  member: Member;
  onClose: () => void;
  onRename: (handle: string, displayName: string) => void;
}) {
  const [handle, setHandle] = useState(props.member.handle);
  const [displayName, setDisplayName] = useState(props.member.display_name);
  return (
    <Modal label={`Rename @${props.member.handle}`} onClose={props.onClose} testid="rename-dialog">
      <h2 className="nx-dialog-title">Rename @{props.member.handle}</h2>
      <label className="nx-field">
        Handle
        <input value={handle} onChange={(e) => setHandle(e.target.value)} data-testid="rename-handle" />
      </label>
      <label className="nx-field">
        Display name
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      <div className="nx-dialog-actions">
        <Button variant="quiet" type="button" onClick={props.onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={handle.trim() === ''}
          onClick={() => props.onRename(handle.trim(), displayName.trim())}
        >
          Rename
        </Button>
      </div>
    </Modal>
  );
}

function ConfigureDialog(props: {
  member: Member;
  adapters: AdapterRegistration[];
  onClose: () => void;
  onConfigure: (patch: {
    model?: string | null;
    thinking?: ThinkingLevel | null;
    policy?: Policy;
  }) => void;
}) {
  // Same control as spawn and channel-create, with the harness locked: an existing
  // member cannot change the harness it is running.
  const [config, setConfig] = useState<AgentConfig>({
    harness: props.member.harness ?? '',
    model: props.member.model ?? '',
    thinking: props.member.thinking ?? '',
    policy: asPolicy(props.member.policy),
  });

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const adapter = props.adapters.find((candidate) => candidate.id === config.harness);
    props.onConfigure({
      // null clears an override; '' from the Default tile means exactly that.
      model: config.model === '' ? null : config.model,
      thinking: supportedThinking(adapter, config.thinking) ?? null,
      ...(config.policy !== '' && { policy: config.policy }),
    });
    props.onClose();
  };

  return (
    <Modal label="Configure agent" onClose={props.onClose} testid="configure-dialog">
      <form onSubmit={submit}>
        <div className="nx-dialog-head">
          <div>
            <h2 className="nx-dialog-title">Configure @{props.member.handle}</h2>
            <p className="nx-dialog-sub">Applies to this agent&apos;s next turn.</p>
          </div>
          <button type="button" className="nx-dialog-close" aria-label="Close configure agent"
            data-testid="configure-close" onClick={props.onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <AgentControls
          adapters={props.adapters}
          config={config}
          onChange={setConfig}
          lockHarness
          behaviourSection={1}
          permissionsSection={2}
          idPrefix="configure"
        />
        <div className="nx-dialog-actions">
          <Button variant="quiet" type="button" onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" type="submit" data-testid="configure-go">Save</Button>
        </div>
      </form>
    </Modal>
  );
}

function SpawnDialog(props: {
  adapters: AdapterRegistration[];
  token: () => string;
  room: Room | undefined;
  members: readonly Member[];
  onClose: () => void;
  onSpawn: (spec: SpawnSpec) => void;
  /** Set while the request is in flight; cleared with an error if it failed. */
  pending: boolean;
  failure: string | undefined;
}) {
  const [config, setConfig] = useState<AgentConfig>({
    harness: '', model: '', thinking: '', policy: DEFAULT_POLICY,
  });
  const [handle, setHandle] = useState('');
  // The operator should not retype the project path on every spawn.
  const [cwd, setCwd] = useState(() => defaultSpawnCwd(props.room, props.members));
  const [purpose, setPurpose] = useState('');
  // Without this the X close button is the first focusable and takes focus on
  // open, so the dialog greets you with "Cancel" instead of the first field.
  const handleRef = useRef<HTMLInputElement>(null);

  // Adapter discovery is asynchronous; a selection made before the list arrives
  // heals rather than sticking at a dead value.
  const harness = effectiveHarness(config.harness, props.adapters);
  const owner = channelOwner(props.members);
  const derived = handle.trim();
  const ownerClash = collidesWithOwner(derived, owner);
  const canSpawn = harness !== '' && derived !== '' && cwd.trim() !== '' && !ownerClash && !props.pending;

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (!canSpawn) return;
    props.onSpawn(buildSpawnSpec({
      config: { ...config, harness },
      handle: derived,
      cwd,
      purpose,
      adapters: props.adapters,
      members: props.members,
    }));
  };

  return (
    <Modal label="Spawn agent" onClose={props.onClose} testid="spawn-dialog" initialFocus={handleRef}>
      {/* A native form so Enter submits from any field. */}
      <form onSubmit={submit}>
        <div className="nx-dialog-head">
          <div>
            <h2 className="nx-dialog-title">Spawn agent</h2>
            <p className="nx-dialog-sub">Choose a harness and how much autonomy it gets.</p>
          </div>
          <button type="button" className="nx-dialog-close" aria-label="Close spawn agent"
            data-testid="spawn-close" onClick={props.onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <Section n={1} title="Identity">
        <label className="nx-field">
          <span className="nx-label">Handle</span>
          {/* HANDLE_PATTERN's hyphen must stay escaped: HTML compiles `pattern`
              with the `v` flag, under which a bare `-` here is a syntax error —
              and an invalid pattern is silently ignored, so validation vanishes
              rather than failing loudly. */}
          <input
            ref={handleRef}
            value={handle}
            pattern={HANDLE_PATTERN}
            maxLength={31}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="e.g. scout"
            required
            data-testid="spawn-handle"
          />
        </label>
        {ownerClash && (
          <p className="nx-field-error" role="alert" data-testid="spawn-owner-clash">
            @{derived} is already in use by the channel owner.
          </p>
        )}

        <div className="nx-field">
          <span className="nx-label">Working directory</span>
          <FolderPicker token={props.token} value={cwd} onChange={setCwd} idPrefix="spawn" />
        </div>
        </Section>

        <AgentControls
          adapters={props.adapters}
          config={{ ...config, harness }}
          onChange={setConfig}
          presets={{
            onApply: (preset) => {
              const applied = applyPreset({
                preset,
                config: { ...config, harness },
                adapters: props.adapters,
                members: props.members,
              });
              setConfig(applied.config);
              setHandle(applied.handle);
              setPurpose(applied.purpose);
            },
          }}
          behaviourSection={2}
          permissionsSection={3}
          idPrefix="spawn"
        />

        <Section n={4} title="Purpose">
        <label className="nx-field">
          <span className="nx-label">Purpose <span className="nx-opt">· optional</span></span>
          <textarea
            value={purpose}
            rows={3}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="What this agent should focus on…"
            data-testid="spawn-purpose"
          />
        </label>
        </Section>

        {props.failure !== undefined && (
          // A failed spawn used to close the dialog silently, losing both the
          // error and everything the operator had typed.
          <p className="nx-field-error" role="alert" data-testid="spawn-error">{props.failure}</p>
        )}

        <div className="nx-dialog-actions">
          <Button variant="quiet" type="button" onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={!canSpawn} data-testid="spawn-go">
            {props.pending ? 'Spawning…' : 'Spawn agent'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Diff tab: the room's LIVE git working tree — file rows with a status letter
// and ± counts feeding the tinted viewer. A clean or non-git repo reads quiet. ──

/** Image artifacts from recent run evidence — the Preview tab's source. */
function useRunImages(room: string, token: () => string): { images: { msgId: number; media_type: string; data_b64: string }[] } {
  const messages = useClientStore((state) => roomSlice(state, room).messages);
  const [images, setImages] = useState<{ msgId: number; media_type: string; data_b64: string }[]>([]);
  const fetched = useRef(new Set<number>());
  const rowsByMsg = useRef(new Map<number, RunRow[]>());

  useEffect(() => {
    const runs = sortedMessages(messages)
      .filter((m) => m.kind === 'run' && m.run !== undefined && m.run.status !== 'running')
      .slice(-20);
    let cancelled = false;
    void (async () => {
      let changed = false;
      for (const message of runs) {
        if (fetched.current.has(message.id)) continue;
        fetched.current.add(message.id);
        try {
          const events: WireEvent[] = await fetchRunEvents(room, message.id, { token: token() });
          rowsByMsg.current.set(
            message.id,
            presentRunEvents(events.map((event, index) => ({ index, event }))),
          );
          changed = true;
        } catch {
          // journal unavailable — skip
        }
      }
      if (!changed || cancelled) return;
      const next: { msgId: number; media_type: string; data_b64: string }[] = [];
      for (const [msgId, rows] of [...rowsByMsg.current.entries()].sort(([a], [b]) => a - b)) {
        for (const row of rows) if (row.image !== undefined) next.push({ msgId, ...row.image });
      }
      setImages(next);
    })();
    return () => { cancelled = true; };
  }, [messages, room, token]);

  return { images };
}

/** The room's live git working state, refetched on cwd change, explicit refresh,
 *  and whenever a run finalizes (its edits may have changed the tree). */
function useGitWorkingState(
  room: string,
  token: () => string,
  cwd: string | undefined,
  refreshKey: number,
): { state: GitWorkingState | undefined; failed: boolean; refreshing: boolean } {
  const messages = useClientStore((state) => roomSlice(state, room).messages);
  const finalizedRuns = useMemo(
    () => Object.values(messages)
      .filter((m) => m.kind === 'run' && m.run !== undefined && m.run.status !== 'running').length,
    [messages],
  );
  // Stale-while-revalidate (richard #472): the cached working state renders
  // instantly and the fresh read revalidates behind a small pill — an empty
  // pane only on a genuine first visit (or a really-stale saved copy).
  const [state, setState] = useState<GitWorkingState | undefined>(() => cachedGitWorkingState(room, cwd));
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const seed = cachedGitWorkingState(room, cwd);
    setState(seed);
    setFailed(false);
    setRefreshing(true);
    void fetchGitWorkingState(room, token(), cwd)
      .then((next) => {
        if (cancelled) return;
        rememberGitWorkingState(room, cwd, next);
        setState(next);
        setRefreshing(false);
      })
      .catch(() => {
        if (cancelled) return;
        setRefreshing(false);
        // A failed refresh keeps showing the cached copy; only a first visit
        // with nothing cached surfaces the error state.
        if (seed === undefined) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [room, token, cwd, refreshKey, finalizedRuns]);
  return { state, failed, refreshing };
}

function DiffTab(props: { room: string; token: () => string; focus?: { path: string; nonce: number } }) {
  const [selectedCwd, setSelectedCwd] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [pickedPath, setPickedPath] = useState<string>();
  const { state, failed, refreshing } = useGitWorkingState(props.room, props.token, selectedCwd, refreshKey);

  // Each chat diff-chip click focuses its file (nonce re-fires on repeats).
  useEffect(() => {
    if (props.focus !== undefined) setPickedPath(props.focus.path);
  }, [props.focus]);

  if (failed) {
    return <EmptyState testid="diff-error">Couldn’t read the repository.</EmptyState>;
  }
  if (state === undefined) {
    return <EmptyState testid="diff-loading">{refreshing ? 'Reading the working tree…' : 'No repository.'}</EmptyState>;
  }

  const files = state.files;
  const focusMissing = pickedPath !== undefined && !files.some((file) => file.path === pickedPath);
  const active = files.find((file) => file.path === pickedPath) ?? files[0];

  return (
    <div className="nx-diff">
      {refreshing && (
        <span className="nx-diff-refreshing" data-testid="diff-refreshing">
          <LoaderCircle className="nx-spin" size={12} aria-hidden="true" /> Refreshing…
        </span>
      )}
      <div className="nx-diff-toolbar">
        {state.cwds.length > 1 && (
          <select
            className="nx-diff-cwd"
            data-testid="diff-cwd"
            aria-label="Working directory"
            value={state.selected ?? ''}
            onChange={(event) => { setSelectedCwd(event.target.value); setPickedPath(undefined); }}
          >
            {state.cwds.map((cwd) => <option key={cwd} value={cwd}>{shortenCwd(cwd)}</option>)}
          </select>
        )}
        <button
          type="button"
          className="nx-diff-refresh"
          data-testid="diff-refresh"
          onClick={() => setRefreshKey((key) => key + 1)}
        >
          Refresh
        </button>
      </div>

      {files.length === 0 && !focusMissing && (
        <EmptyState testid="diff-clean">Working tree clean — no uncommitted changes.</EmptyState>
      )}
      {files.length > 0 && (
        <ul className="nx-diff-files" data-testid="diff-files">
          {files.map((file) => (
            <li key={file.path}>
              <button
                className={`nx-diff-file ${file === active && !focusMissing ? 'is-active' : ''}`}
                onClick={() => setPickedPath(file.path)}
              >
                <span className={`nx-diff-status is-${file.status}`} title={file.status}>
                  {statusLetter(file.status)}
                </span>
                <span className="nx-diff-path">{file.path}</span>
                <span className="nx-diff-stat">
                  <em className="is-add">+{file.additions}</em> <em className="is-del">−{file.deletions}</em>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {focusMissing ? (
        <p className="nx-diff-note" data-testid="diff-no-current">
          No current changes for {pickedPath}.
        </p>
      ) : (
        active !== undefined && <DiffViewer diff={{ path: active.path, unified: active.diff }} />
      )}
    </div>
  );
}

export function DiffViewer(props: { diff: RunItemDiff }) {
  const lines = useMemo(() => props.diff.unified.split('\n'), [props.diff.unified]);
  return (
    <pre className="nx-diff-view" data-testid="diff-view">
      {lines.map((line, index) => {
        const kind = line.startsWith('@@')
          ? 'hunk'
          : line.startsWith('+++') || line.startsWith('---')
            ? 'meta' // file headers of a real `git diff`, not add/del content
            : line.startsWith('+')
              ? 'add'
              : line.startsWith('-')
                ? 'del'
                : 'ctx';
        return <span key={index} className={`nx-diff-line is-${kind}`}>{line || ' '}</span>;
      })}
    </pre>
  );
}

// ── Preview tab: image artifacts from run evidence; dot-grid empty state ───

function PreviewTab(props: { room: string; token: () => string }) {
  const { images } = useRunImages(props.room, props.token);
  const latest = images.at(-1);
  if (latest === undefined) {
    return <EmptyState testid="preview-empty">Nothing to preview yet — artifacts agents produce appear here.</EmptyState>;
  }
  return (
    <div className="nx-preview">
      <img
        src={`data:${latest.media_type};base64,${latest.data_b64}`}
        alt={`Artifact from turn #${latest.msgId}`}
      />
      <p className="nx-preview-meta">from <a href={`#${latest.msgId}`}>#{latest.msgId}</a></p>
    </div>
  );
}

function EmptyState(props: { children: string; testid?: string }) {
  return (
    <div className="nx-context-empty" data-testid={props.testid}>
      <div className="nx-dotgrid" aria-hidden="true" />
      <p>{props.children}</p>
    </div>
  );
}
