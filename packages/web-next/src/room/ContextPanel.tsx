import type { AgentLimit, AgentPreset, AgentTaskList, AgentTaskStatus, Member, Policy, Room, ThinkingLevel, WireEvent } from '@codor/protocol';
import {
  GitBranch,
  Bot,
  ChevronRight,
  CircleDollarSign,
  Eraser,
  FileText,
  List,
  LoaderCircle,
  Lock,
  Minimize2,
  MoreVertical,
  PencilLine,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  X,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { artifactUrl, fetchAgentPreset, fetchAgentPresets, fetchArtifacts, fetchRunEvents, refreshUsage, type AdapterRegistration, type ArtifactFeed, type MemberDetail } from '@runtime/api.js';
import { formatAttachmentSize, isImageAttachment, useAttachmentDownload, useAttachmentObjectUrl } from './attachments.js';
import { AgentControls, AgentIdentityControls, RolePresetControls, Section } from './AgentControls.js';
import { FolderPicker } from './FolderPicker.js';
import {
  ACP_SELECTOR_PREFIX,
  DEFAULT_POLICY,
  type AgentConfig,
  type SpawnSpec,
  applyAgentPreset,
  buildSpawnSpec,
  applyPreset,
  asPolicy,
  channelOwner,
  collidesWithOwner,
  HANDLE_PATTERN,
  defaultSpawnCwd,
  effectiveHarness,
  reconcileConfig,
  resolveSpawn,
  supportedThinking,
} from './agent-spec.js';
import { presentRunEvents, type RunRow } from '@runtime/run-presenter.js';
import type { Connection } from '@runtime/ws.js';

import { roleAtLeast, roomSlice, sortedMessages, useClientStore } from '../app/store.js';
import { clockTime, compactCount, memberAccent, usd } from '../primitives/identity.js';
import { Button, Chip, Eyebrow, IconButton, Modal, Segmented } from '../primitives/primitives.js';
import { useAdapterCatalog, useMemberDetails } from '../app/session.js';
import { ContextWindowMeter } from './ContextWindowMeter.js';
import {
  cachedGitWorkingState,
  fetchGitCommitState,
  fetchGitHistory,
  fetchGitWorkingState,
  rememberGitWorkingState,
  shortenCwd,
  statusLetter,
  type GitCommit,
  type GitCommitState,
  type GitHistoryPage,
  type GitWorkingState,
} from './git-diff.js';
import { costProvenanceLabel, type CostProvenance } from './spend-label.js';
import { DiffViewer } from './DiffViewer.js';
import { harnessLabel, harnessMark } from './harness-marks.js';

type Tab = 'members' | 'diff' | 'preview';

export function ContextPanel(props: {
  room: string;
  token: () => string;
  connection: Connection;
  /** Opens the worktree manager (Find). Offered only pre-promotion, from the
   *  Diff tab's confirmed Git context, to humans who may manage worktrees. */
  onManageWorktrees?: () => void;
}) {
  const [tab, setTab] = useState<Tab>('members');
  // harn:assume worktree-lifecycle-ui-is-explicit-and-recoverable ref=worktree-git-context-entry
  const worktreeEntry = useClientStore((state) => {
    if (props.onManageWorktrees === undefined) return undefined;
    const groups = state.worktreeGroups;
    const isChild = Object.values(groups).some((group) =>
      group.registered.some((worktree) => !worktree.primary && worktree.conversation_id === props.room));
    if (isChild) return undefined;
    const promoted = groups[props.room]?.registered.some((worktree) => !worktree.primary) === true;
    if (promoted) return undefined;
    const slice = roomSlice(state, props.room);
    const role = slice.selfMemberId !== undefined
      ? slice.members[slice.selfMemberId]?.role
      : undefined;
    if (!roleAtLeast(role, 'admin')) return undefined;
    return props.onManageWorktrees;
  });
  // harn:end worktree-lifecycle-ui-is-explicit-and-recoverable

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
      {tab === 'diff' && (
        <DiffTab
          room={props.room}
          token={props.token}
          {...(worktreeEntry !== undefined && { onManageWorktrees: worktreeEntry })}
        />
      )}
      {/* Key by room so a room switch remounts Preview with fresh state — no stale
          artifact/image frame from the previous room during the next fetch. */}
      {tab === 'preview' && <PreviewTab key={props.room} room={props.room} token={props.token} />}
    </aside>
  );
}

// ── Members: owner first, then agents; cards carry account + spend; the six
// lifecycle actions live in a kebab dropdown with confirm flows. ────────────

function MembersTab(props: { room: string; token: () => string; connection: Connection }) {
  const members = useClientStore((state) => roomSlice(state, props.room).members);
  const selfId = useClientStore((state) => roomSlice(state, props.room).selfMemberId);
  const details = useMemberDetails(props.room, props.token);
  const adapterCatalog = useAdapterCatalog(props.token);
  const [spawning, setSpawning] = useState(false);
  // Manual usage refresh: coalesce repeat clicks while one is in flight, and
  // surface a concise error without disturbing the last-good gauges (updated
  // gauges arrive as member frames).
  const [usageBusy, setUsageBusy] = useState(false);
  const [usageError, setUsageError] = useState<string>();
  const refreshUsageLimits = useCallback(() => {
    if (usageBusy) return;
    setUsageBusy(true);
    setUsageError(undefined);
    void refreshUsage({ token: props.token() })
      // A provider failure is an honest `failed` outcome (200), distinct from a
      // request/auth error (rejection); both surface the same visible message.
      .then((result) => {
        if (result.outcome === 'failed') setUsageError('Couldn’t reach the usage provider. Showing the last known numbers.');
      })
      .catch((error) => setUsageError(error instanceof Error ? error.message : 'Couldn’t refresh usage limits'))
      .finally(() => setUsageBusy(false));
  }, [usageBusy, props.token]);
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
        <div className="nx-members-actions">
          {/* Refresh usage sits immediately left of Plus. */}
          <IconButton
            icon={RefreshCw}
            label="Refresh usage limits"
            title={usageError ?? 'Refresh usage limits'}
            size="sm"
            variant="quiet"
            className={`nx-usage-refresh${usageBusy ? ' is-busy' : ''}${usageError !== undefined ? ' is-error' : ''}`}
            data-testid="refresh-usage"
            disabled={usageBusy}
            onClick={refreshUsageLimits}
          />
          {canManage && (
            <IconButton
              icon={Plus}
              label="Spawn agent"
              size="sm"
              variant="quiet"
              data-testid="spawn-agent"
              onClick={() => setSpawning(true)}
            />
          )}
        </div>
      </div>
      {usageError !== undefined && (
        <p className="nx-usage-error" role="alert" data-testid="usage-refresh-error">{usageError}</p>
      )}
      <ul className="nx-roster">
        {roster.map((member) => (
          <MemberCard
            key={member.id}
            member={member}
            detail={details[member.id]}
            adapters={adapterCatalog.registered}
            canStop={canStop}
            canManage={canManage}
            connection={props.connection}
            room={props.room}
          />
        ))}
      </ul>
      {spawning && (
        <SpawnDialog
          adapters={adapterCatalog.installed}
          advanced={adapterCatalog.advanced}
          onRefresh={adapterCatalog.refresh}
          refreshing={adapterCatalog.refreshing}
          refreshError={adapterCatalog.refreshError}
          token={props.token}
          roomId={props.room}
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

// harn:assume people-and-agents-shows-small-task-status-icons ref=small-member-task-list-ui
const TASK_STATUS_LABEL: Record<AgentTaskStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
};
const TASK_COLLAPSED = 5;

/** A bounded, accessible checklist beneath an agent card. The projection stays
 *  durable and untouched; completed-only state is simply not a useful section
 *  to render, while mixed lists retain their completed history. */
function MemberTaskList(props: { handle: string; tasks: AgentTaskList }) {
  const [expanded, setExpanded] = useState(false);
  const items = props.tasks.items;
  if (!items.some((task) => task.status !== 'completed')) return null;
  const visible = expanded ? items : items.slice(0, TASK_COLLAPSED);
  const extra = items.length - TASK_COLLAPSED;
  return (
    <div className="nx-member-tasks" data-testid={`member-${props.handle}-tasks`}>
      {props.tasks.explanation !== undefined && (
        <p className="nx-tasklist-note">{props.tasks.explanation}</p>
      )}
      <ul className={`nx-tasklist${expanded ? ' is-expanded' : ''}`} aria-label={`@${props.handle} tasks`}>
        {visible.map((task) => (
          <li key={task.id} className={`nx-task is-${task.status}`}>
            {task.status === 'in_progress' ? (
              <span
                className="nx-task-progress"
                role="img"
                aria-label={TASK_STATUS_LABEL[task.status]}
              />
            ) : (
              <span
                className={`nx-task-mark is-${task.status}`}
                role="img"
                aria-label={TASK_STATUS_LABEL[task.status]}
              >
                {task.status === 'completed' ? '✓' : '○'}
              </span>
            )}
            <span className="nx-task-text">
              {task.status === 'in_progress' && task.active_form !== undefined ? task.active_form : task.content}
            </span>
          </li>
        ))}
      </ul>
      {extra > 0 && (
        <button
          type="button"
          className="nx-tasklist-toggle"
          data-testid={`member-${props.handle}-tasks-toggle`}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show fewer' : `Show all ${String(items.length)}`}
        </button>
      )}
    </div>
  );
}
// harn:end people-and-agents-shows-small-task-status-icons

const POLICY_ICON: Record<Policy, typeof Lock> = {
  'read-only': Lock,
  'workspace-write': PencilLine,
  'full-access': Zap,
};
const POLICY_LABEL: Record<Policy, string> = {
  'read-only': 'Read only',
  'workspace-write': 'Workspace write',
  'full-access': 'Full access',
};

function memberStateLabel(state: Member['state']): string {
  if (state === 'running' || state === 'queued') return 'Working';
  if (state === 'dead') return 'Dead';
  if (state === 'awaiting_input') return 'Waiting for input';
  if (state === 'unreachable') return 'Unavailable';
  if (state === 'custody_uncertain') return 'Connection uncertain';
  return 'Idle';
}

function compactCostLabel(value: CostProvenance): string {
  const estimate = value.estimated_cost_usd ?? 0;
  const unknown = value.uncosted_tokens ?? 0;
  const parts: string[] = [];
  if (value.cost_usd > 0 || (estimate === 0 && unknown === 0)) parts.push(usd(value.cost_usd));
  if (estimate > 0) parts.push(`~${usd(estimate)}`);
  if (unknown > 0) parts.push(compactCount(unknown));
  return parts.join(' + ');
}

function MemberMetric(props: {
  icon: typeof FileText;
  label: string;
  value: string;
  title?: string;
  accessibleLabel?: string;
  testId?: string;
}) {
  const Icon = props.icon;
  return (
    <span
      className="nx-member-metric"
      role="img"
      aria-label={props.accessibleLabel ?? `${props.label}: ${props.value}`}
      title={props.title ?? `${props.label}: ${props.value}`}
      data-testid={props.testId}
    >
      <span>{props.value}</span>
      <Icon size={12} aria-hidden="true" />
    </span>
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
  // harn:assume member-context-reset-is-authorized-atomic-and-lazy ref=clear-context-web-control
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const clearStartedAt = useRef<{ errors: number; member: Member } | null>(null);
  // harn:end member-context-reset-is-authorized-atomic-and-lazy
  const [reviving, setReviving] = useState(false);
  const errorCount = useClientStore((state) => roomSlice(state, props.room).errors.length);
  const clearErrorCount = useClientStore((state) =>
    roomSlice(state, props.room).errorRefs.clear_member_context ?? 0);
  const startedAt = useRef<{ errors: number; member: Member } | null>(null);
  const revivedAt = useRef<{ errors: number; member: Member } | null>(null);
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
  // harn:assume member-context-reset-is-authorized-atomic-and-lazy ref=clear-context-web-control
  useEffect(() => {
    const started = clearStartedAt.current;
    if (!clearing || started === null) return;
    if (clearErrorCount > started.errors) {
      clearStartedAt.current = null;
      setClearing(false); // keep the confirm open so the operator can retry or cancel
      return;
    }
    // Success is authoritative only when the member frame has actually removed
    // the native session reference. A coincidental member update cannot erase
    // the old ring or dismiss the confirmation early.
    if (member !== started.member && member.session_ref === undefined) {
      clearStartedAt.current = null;
      setClearing(false);
      setConfirmClear(false);
    }
  }, [clearing, clearErrorCount, member]);
  // harn:end member-context-reset-is-authorized-atomic-and-lazy
  // Revive is guarded the same way: the button disables while the request is in
  // flight and re-enables on the next member update (a success flips the state
  // out of 'dead', removing the button) or on an action error.
  useEffect(() => {
    const started = revivedAt.current;
    if (!reviving || started === null) return;
    if (errorCount > started.errors || member !== started.member) {
      revivedAt.current = null;
      setReviving(false);
    }
  }, [reviving, errorCount, member]);

  const policy = asPolicy(member.policy);
  const PolicyIcon = policy === '' ? undefined : POLICY_ICON[policy];
  const policyLabel = policy === '' ? undefined : POLICY_LABEL[policy];
  const stateLabel = memberStateLabel(member.state);

  // harn:assume agent-member-card-composes-two-compact-rows ref=member-card-compact-rows
  return (
    <li className="nx-member" data-testid={`member-${member.handle}`}>
      <div className={`nx-member-header${member.kind === 'human' ? ' is-human' : ''}`} data-testid={`member-${member.handle}-header`}>
        <Chip name={member.handle} accent={memberAccent(member)} size={32} />
        <div className="nx-member-header-body">
          <div className="nx-member-row nx-member-row-primary" data-testid={`member-${member.handle}-row-primary`}>
            <strong className="nx-member-handle">@{member.handle}</strong>
            <span
              className={`nx-member-state-mark is-${member.state}`}
              role="img"
              aria-label={`${stateLabel} @${member.handle}`}
              title={`${stateLabel} @${member.handle}`}
            />
            {member.kind === 'human' && member.display_name !== '' && (
              <span className="nx-member-display-name">{member.display_name}</span>
            )}
            {member.kind === 'agent' && spend !== undefined && (
              <span className="nx-member-usage-metrics" data-testid={`member-${member.handle}-usage`}>
                <MemberMetric icon={FileText} label="Tokens" value={compactCount(tokens ?? 0)} />
                <MemberMetric
                  icon={CircleDollarSign}
                  label="Cost"
                  value={compactCostLabel(spend)}
                  title={`Cost: ${costProvenanceLabel(spend)}`}
                  accessibleLabel={`Cost: ${costProvenanceLabel(spend)}`}
                />
                <MemberMetric icon={RotateCcw} label="Turns" value={String(spend.turns)} />
              </span>
            )}
            {member.kind === 'agent' && detail !== undefined && detail.queued_count > 0 && (
              <MemberMetric
                icon={List}
                label="Queue"
                value={String(detail.queued_count)}
                testId={`member-${member.handle}-queue`}
              />
            )}
          </div>
          {member.kind === 'agent' && (
            <div className="nx-member-row nx-member-row-secondary" data-testid={`member-${member.handle}-row-secondary`}>
              <div className="nx-member-meta-rail" data-testid={`member-${member.handle}-metadata`}>
                <div className="nx-member-meta-content">
                  {member.harness !== undefined && (
                    <span
                      className="nx-member-harness-mark"
                      role="img"
                      aria-label={`${harnessLabel(member.harness)} harness`}
                      title={`${harnessLabel(member.harness)} harness`}
                    >
                      {harnessMark(member.harness, 16)}
                    </span>
                  )}
                  {member.model !== undefined && (
                    <span className="nx-member-model-pill" title={`Model: ${member.model}`}>
                      {member.model}
                    </span>
                  )}
                  {PolicyIcon !== undefined && policyLabel !== undefined && (
                    <span
                      className="nx-member-policy-mark"
                      role="img"
                      aria-label={`Policy: ${policyLabel}`}
                      title={`Policy: ${policyLabel}`}
                    >
                      <PolicyIcon size={14} aria-hidden="true" />
                    </span>
                  )}
                </div>
              </div>
              <span className="nx-member-action-spacer" aria-hidden="true" />
              <div className="nx-member-actions" data-testid={`member-${member.handle}-context-actions`}>
                {/* harn:assume member-context-window-meter-derived-from-last-usage ref=context-window-meter-wiring */}
                {(member.lastUsage !== undefined || member.state === 'running') && (
                  <span className="nx-member-context-ring">
                    <ContextWindowMeter
                      usage={member.lastUsage}
                      pending={member.state === 'running'}
                      testId={`member-${member.handle}-context-window`}
                    />
                  </span>
                )}
                {/* harn:end member-context-window-meter-derived-from-last-usage */}
                {/* harn:assume dead-agent-surfaces-revive-in-its-action-area ref=member-lifecycle-controls */}
                {props.canManage && member.state !== 'dead' && (
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
                      ? <LoaderCircle size={15} className="nx-spin" aria-hidden="true" />
                      : <Minimize2 size={15} aria-hidden="true" />}
                  </button>
                )}
                {/* harn:assume member-context-reset-is-authorized-atomic-and-lazy ref=clear-context-web-control */}
                {props.canManage && member.state !== 'dead' && member.session_ref !== undefined && (
                  <button
                    type="button"
                    className="nx-member-clear"
                    aria-label={`Clear @${member.handle}'s context`}
                    data-testid={`member-${member.handle}-clear-context`}
                    disabled={member.state !== 'idle' || clearing}
                    title={member.state !== 'idle'
                      ? `Only an idle agent context can be cleared — @${member.handle} is ${member.state}`
                      : clearing
                        ? `Clearing @${member.handle}'s native context…`
                        : `Clear @${member.handle}'s native context`}
                    onClick={() => setConfirmClear(true)}
                  >
                    <Eraser size={15} aria-hidden="true" />
                  </button>
                )}
                {/* harn:end member-context-reset-is-authorized-atomic-and-lazy */}
                {props.canManage && member.state === 'dead' && (
                  <button
                    type="button"
                    className="nx-member-revive"
                    data-testid={`member-${member.handle}-revive`}
                    disabled={reviving}
                    title={reviving ? 'Reviving…' : `Revive @${member.handle} from its saved session`}
                    aria-label={`Revive @${member.handle}`}
                    onClick={() => {
                      if (reviving) return;
                      revivedAt.current = { errors: errorCount, member };
                      setReviving(true);
                      props.connection.act({ act: 'revive', member_id: member.id });
                    }}
                  >
                    {reviving
                      ? <LoaderCircle size={15} className="nx-spin" aria-hidden="true" />
                      : <RotateCcw size={15} aria-hidden="true" />}
                  </button>
                )}
                {running && props.canStop && (
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
                {props.canManage && (
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
                        {member.state !== 'dead' && (
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
                {/* harn:end dead-agent-surfaces-revive-in-its-action-area */}
              </div>
            </div>
          )}
        </div>
      </div>
      {/* harn:end agent-member-card-composes-two-compact-rows */}
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
      {member.kind === 'agent' && member.tasks !== undefined && member.tasks.items.some((task) => task.status !== 'completed') && (
        <MemberTaskList handle={member.handle} tasks={member.tasks} />
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

      {/* harn:assume member-context-reset-is-authorized-atomic-and-lazy ref=clear-context-web-control */}
      {confirmClear && (
        <Modal
          label={`Clear @${member.handle}'s context?`}
          onClose={() => { if (!clearing) setConfirmClear(false); }}
          alert
          testid="clear-context-dialog"
        >
          <h2 className="nx-dialog-title">Clear @{member.handle}&apos;s context?</h2>
          <p className="nx-dialog-body">
            This permanently discards the agent&apos;s native session memory. Channel history,
            identity, configuration, usage limits, and spend remain. The next delivery starts
            a fresh native session.
          </p>
          <div className="nx-dialog-actions">
            <Button variant="quiet" disabled={clearing} onClick={() => setConfirmClear(false)}>Cancel</Button>
            <Button
              variant="danger"
              data-testid="clear-context-confirm"
              disabled={clearing}
              onClick={() => {
                if (clearing) return;
                clearStartedAt.current = { errors: clearErrorCount, member };
                setClearing(true);
                props.connection.act({ act: 'clear_member_context', member_id: member.id });
              }}
            >
              {clearing ? 'Clearing…' : 'Clear context'}
            </Button>
          </div>
        </Modal>
      )}
      {/* harn:end member-context-reset-is-authorized-atomic-and-lazy */}

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
  if (window === 'seven_day' || window === 'weekly') return '7d';
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
  // member cannot change the harness it is running. The locked tile is keyed by the
  // SELECTOR id, not the runtime harness: a named provider member persists its safe
  // `acp_provider`, so its selector is `acp:<provider>` — that is the tile that shows
  // (locked, with its ACP pill) even if the provider's binary later disappears, since
  // the named catalog entry is always listed. A native or custom-ACP member keys off
  // its plain harness id.
  const [config, setConfig] = useState<AgentConfig>({
    harness: props.member.acp_provider !== undefined
      ? `${ACP_SELECTOR_PREFIX}${props.member.acp_provider}`
      : props.member.harness ?? '',
    model: props.member.model ?? '',
    thinking: props.member.thinking ?? '',
    policy: asPolicy(props.member.policy),
  });

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const adapter = props.adapters.find((candidate) => candidate.id === config.harness);
    // An ACP member (named or custom) has no model control and never carries a model, so
    // Configure never serializes one for it.
    const isAcp = props.member.harness === 'acp';
    props.onConfigure({
      // null clears an override; '' from the Default tile means exactly that.
      ...(!isAcp && { model: config.model === '' ? null : config.model }),
      thinking: supportedThinking(adapter, config.thinking) ?? null,
      ...(config.policy !== '' && { policy: config.policy }),
    });
    props.onClose();
  };

  return (
    <Modal label="Configure agent" onClose={props.onClose} testid="configure-dialog" structured>
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
        <div className="nx-dialog-body">
        <AgentControls
          adapters={props.adapters}
          config={config}
          onChange={setConfig}
          lockHarness
          behaviourSection={1}
          permissionsSection={2}
          idPrefix="configure"
        />
        </div>
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
  /** The generic custom ACP transport, offered only inside the Advanced disclosure. */
  advanced: AdapterRegistration[];
  onRefresh: () => void;
  refreshing: boolean;
  refreshError?: string;
  token: () => string;
  roomId: string;
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
  const [agentPresets, setAgentPresets] = useState<AgentPreset[]>([]);
  const [presetLoading, setPresetLoading] = useState(true);
  const [presetError, setPresetError] = useState<string>();
  const [presetBusyId, setPresetBusyId] = useState<string>();
  const presetRequest = useRef(0);
  const invalidatePresetSelection = useCallback(() => {
    presetRequest.current += 1;
    setPresetBusyId(undefined);
    setPresetError(undefined);
  }, []);
  // The operator should not retype the project path on every spawn. "Use current
  // directory" is on by default and inherits the channel's folder; turning it
  // off reveals the picker, pre-seeded with that same directory to edit from.
  const inheritedCwd = defaultSpawnCwd(props.room, props.members);
  // Default the switch off when there is nothing to inherit, so the operator
  // sees the picker instead of a switch that hides it while spawn stays blocked.
  const [useCurrentDir, setUseCurrentDir] = useState(inheritedCwd !== '');
  const [pickedCwd, setPickedCwd] = useState(inheritedCwd);
  const cwd = useCurrentDir ? inheritedCwd : pickedCwd;
  const [purpose, setPurpose] = useState('');
  // Without this the X close button is the first focusable and takes focus on
  // open, so the dialog greets you with "Cancel" instead of the first field.
  const handleRef = useRef<HTMLInputElement>(null);

  // Reconciliation spans both grids: a custom-ACP selection (id `acp`) lives in
  // `advanced`, so healing and adapter lookups must see the combined list.
  const all = [...props.adapters, ...props.advanced];
  // A delayed addressed read must resolve against the current draft/catalog/roster,
  // not the render in which its tile happened to be clicked.
  const latestConfig = useRef(config);
  const latestAdapters = useRef(all);
  const latestMembers = useRef(props.members);
  latestConfig.current = config;
  latestAdapters.current = all;
  latestMembers.current = props.members;

  const updateConfig = useCallback((next: AgentConfig) => {
    invalidatePresetSelection();
    setConfig(next);
  }, [invalidatePresetSelection]);

  // Saved presets are intentionally read on every dialog mount. The list is only
  // a set of labels; selection performs its own addressed read below so edits and
  // deletion between these two requests cannot silently produce an old draft.
  useEffect(() => {
    let active = true;
    setPresetLoading(true);
    setPresetError(undefined);
    void fetchAgentPresets({ token: props.token() })
      .then((presets) => {
        if (!active) return;
        setAgentPresets(presets);
        setPresetLoading(false);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setAgentPresets([]);
        setPresetLoading(false);
        setPresetError(error instanceof Error ? error.message : 'Could not load saved presets.');
      });
    return () => {
      active = false;
      presetRequest.current += 1;
    };
  }, [props.token]);

  const selectAgentPreset = (listed: AgentPreset): void => {
    const request = ++presetRequest.current;
    setPresetBusyId(listed.id);
    setPresetError(undefined);
    void fetchAgentPreset(listed.id, { token: props.token() })
      .then((preset) => {
        if (request !== presetRequest.current) return;
        if (preset.id !== listed.id) {
          throw new Error(`Saved preset response did not match requested preset “${listed.id}”.`);
        }
        const currentAdapters = latestAdapters.current;
        const currentConfig = latestConfig.current;
        const applied = applyAgentPreset({
          preset,
          config: {
            ...currentConfig,
            harness: effectiveHarness(currentConfig.harness, currentAdapters),
          },
          adapters: currentAdapters,
          members: latestMembers.current,
        });
        if (!applied.ok) throw new Error(applied.message);
        // Commit the complete result only after every field has validated. A
        // failed/stale selection therefore cannot partially change the draft.
        setConfig(applied.config);
        setHandle(applied.handle);
      })
      .catch((error: unknown) => {
        if (request !== presetRequest.current) return;
        setPresetError(error instanceof Error ? error.message : 'Could not apply saved preset.');
      })
      .finally(() => {
        if (request === presetRequest.current) setPresetBusyId(undefined);
      });
  };

  // Adapter discovery is asynchronous; a selection made before the list arrives
  // heals rather than sticking at a dead value.
  const harness = effectiveHarness(config.harness, all);
  // harn:assume agent-selection-shows-detected-acp-and-advanced-custom ref=spawn-provider-selection
  useEffect(() => {
    if (config.harness === harness) return;
    setConfig(reconcileConfig(config, harness, all));
  }, [config, harness, all]);
  // harn:end agent-selection-shows-detected-acp-and-advanced-custom
  const owner = channelOwner(props.members);
  const derived = handle.trim();
  const ownerClash = collidesWithOwner(derived, owner);
  const canSpawn = harness !== '' && derived !== '' && cwd.trim() !== '' && !ownerClash
    && (harness !== 'acp' || (config.acpExecutable?.trim() ?? '') !== '') && !props.pending;

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (!canSpawn) return;
    invalidatePresetSelection();
    props.onSpawn(buildSpawnSpec({
      config: { ...config, harness },
      handle: derived,
      cwd,
      purpose,
      adapters: all,
      members: props.members,
    }));
  };

  return (
    <Modal label="Spawn agent" onClose={props.onClose} testid="spawn-dialog" initialFocus={handleRef} structured>
      {/* A native form so Enter submits from any field. */}
      <form onSubmit={submit}>
        <div className="nx-dialog-head">
          <div className="nx-dialog-headings">
            <span className="nx-dialog-icon" aria-hidden="true"><Bot size={19} /></span>
            <div>
              <h2 className="nx-dialog-title">Spawn agent</h2>
              <p className="nx-dialog-sub">Into <code className="nx-mono">#{props.room?.name ?? props.roomId}</code></p>
            </div>
          </div>
          <button type="button" className="nx-dialog-close" aria-label="Close spawn agent"
            data-testid="spawn-close" onClick={props.onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="nx-dialog-body">
        <Section n={1} title="Identity">
        <AgentIdentityControls
          adapters={props.adapters}
          advanced={props.advanced}
          config={{ ...config, harness }}
          onChange={updateConfig}
          idPrefix="spawn"
          onRefresh={props.onRefresh}
          refreshing={props.refreshing}
          refreshError={props.refreshError}
        />
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
            onChange={(e) => {
              invalidatePresetSelection();
              setHandle(e.target.value);
            }}
            placeholder="e.g. scout"
            required
            data-testid="spawn-handle"
          />
        </label>
        <label className="nx-field">
          <span className="nx-label">Display name <span className="nx-opt">· optional</span></span>
          <input
            className="nx-input"
            value={config.displayName ?? ''}
            maxLength={120}
            onChange={(event) => {
              invalidatePresetSelection();
              setConfig((current) => ({ ...current, displayName: event.target.value }));
            }}
            placeholder="Shown in the member list"
            data-testid="spawn-display-name"
          />
        </label>
        {ownerClash && (
          <p className="nx-field-error" role="alert" data-testid="spawn-owner-clash">
            @{derived} is already in use by the channel owner.
          </p>
        )}

        <div className="nx-field">
          <span className="nx-label">Working directory</span>
          <label className="nx-switch-row">
            <input
              type="checkbox"
              role="switch"
              checked={useCurrentDir}
              onChange={(event) => {
                invalidatePresetSelection();
                setUseCurrentDir(event.target.checked);
              }}
              data-testid="spawn-use-current-dir"
            />
            <span>Use current directory</span>
          </label>
          {useCurrentDir
            ? inheritedCwd !== '' && (
              <span className="nx-field-note" data-testid="spawn-inherited-cwd">Inherits {inheritedCwd}</span>
            )
            : <FolderPicker
              token={props.token}
              value={pickedCwd}
              onChange={(next) => {
                invalidatePresetSelection();
                setPickedCwd(next);
              }}
              idPrefix="spawn"
            />}
        </div>
        <RolePresetControls
          idPrefix="spawn"
          customPresets={agentPresets}
          customLoading={presetLoading}
          customError={presetError}
          customBusyId={presetBusyId}
          onApplyCustom={selectAgentPreset}
          onApply={(preset) => {
            invalidatePresetSelection();
            const applied = applyPreset({
              preset,
              config: { ...config, harness },
              adapters: all,
              members: props.members,
            });
            setConfig(applied.config);
            setHandle(applied.handle);
            setPurpose(applied.purpose);
          }}
        />
        </Section>

        <AgentControls
          adapters={all}
          config={{ ...config, harness }}
          onChange={updateConfig}
          hideHarness
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
            onChange={(e) => {
              invalidatePresetSelection();
              setPurpose(e.target.value);
            }}
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

        </div>

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
  enabled: boolean,
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
    if (!enabled) {
      setRefreshing(false);
      return undefined;
    }
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
  }, [room, token, cwd, refreshKey, finalizedRuns, enabled]);
  return { state, failed, refreshing };
}

const GIT_HISTORY_PAGE_SIZE = 5;

function shortHash(hash: string): string { return hash.slice(0, 8); }

function commitLabel(commit: GitCommit): string {
  return `${shortHash(commit.hash)} ${commit.subject}`;
}

// harn:assume diff-panel-floats-refresh-and-overlays-history ref=git-history-panel-state
function DiffTab(props: { room: string; token: () => string; onManageWorktrees?: () => void }) {
  const [selectedCwd, setSelectedCwd] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [pickedPath, setPickedPath] = useState<string>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyToggleRef = useRef<HTMLButtonElement>(null);
  const historyPopoverRef = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<GitHistoryPage>();
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const historyRequest = useRef(0);
  const [selectedCommit, setSelectedCommit] = useState<string>();
  const [commitState, setCommitState] = useState<GitCommitState>();
  const [commitBusy, setCommitBusy] = useState(false);
  const [commitError, setCommitError] = useState(false);
  const liveMode = selectedCommit === undefined;
  const { state, failed, refreshing } = useGitWorkingState(
    props.room,
    props.token,
    selectedCwd,
    refreshKey,
    liveMode,
  );
  const effectiveCwd = selectedCwd ?? state?.selected ?? undefined;

  const loadHistory = useCallback((cursor: number, replace: boolean): void => {
    const request = ++historyRequest.current;
    setHistoryBusy(true);
    setHistoryError(false);
    void fetchGitHistory(props.room, props.token(), {
      cwd: effectiveCwd,
      cursor,
      limit: GIT_HISTORY_PAGE_SIZE,
    }).then((page) => {
      if (request !== historyRequest.current) return;
      setHistory((prior) => replace || prior === undefined
        ? page
        : {
            ...page,
            commits: [...prior.commits, ...page.commits.filter(
              (commit) => !prior.commits.some((existing) => existing.hash === commit.hash),
            )],
          });
      setHistoryBusy(false);
    }).catch(() => {
      if (request !== historyRequest.current) return;
      setHistoryBusy(false);
      setHistoryError(true);
    });
  }, [effectiveCwd, props.room, props.token]);

  useEffect(() => {
    historyRequest.current += 1;
    setHistory(undefined);
    setHistoryBusy(false);
    setHistoryError(false);
    setSelectedCommit(undefined);
    setCommitState(undefined);
    setPickedPath(undefined);
  }, [effectiveCwd, props.room]);

  useEffect(() => () => { historyRequest.current += 1; }, []);

  useEffect(() => {
    if (!historyOpen || history !== undefined || historyBusy || historyError) return;
    loadHistory(0, true);
  }, [history, historyBusy, historyError, historyOpen, loadHistory]);

  // The History popover closes on Escape (returning focus to the toggle) and on
  // an outside pointer press. The selected commit is left untouched, so closing
  // the popover never reverts to the working tree.
  useEffect(() => {
    if (!historyOpen) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setHistoryOpen(false);
      historyToggleRef.current?.focus();
    };
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target !== null && (historyPopoverRef.current?.contains(target) || historyToggleRef.current?.contains(target))) return;
      setHistoryOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [historyOpen]);

  useEffect(() => {
    if (selectedCommit === undefined) {
      setCommitState(undefined);
      setCommitError(false);
      setCommitBusy(false);
      return undefined;
    }
    let cancelled = false;
    setCommitBusy(true);
    setCommitError(false);
    void fetchGitCommitState(props.room, props.token(), selectedCommit, effectiveCwd)
      .then((next) => {
        if (cancelled) return;
        setCommitState(next);
        setCommitBusy(false);
      })
      .catch(() => {
        if (cancelled) return;
        setCommitState(undefined);
        setCommitBusy(false);
        setCommitError(true);
      });
    return () => { cancelled = true; };
  }, [effectiveCwd, props.room, props.token, selectedCommit]);

  if (failed && liveMode) {
    return <EmptyState testid="diff-error">Couldn’t read the repository.</EmptyState>;
  }
  if (state === undefined && liveMode) {
    return <EmptyState testid="diff-loading">{refreshing ? 'Reading the working tree…' : 'No repository.'}</EmptyState>;
  }

  const selectedMeta = history?.commits.find((commit) => commit.hash === selectedCommit)
    ?? commitState?.commit;
  const files = liveMode ? (state?.files ?? []) : (commitState?.files ?? []);
  const focusMissing = pickedPath !== undefined && !files.some((file) => file.path === pickedPath);
  const active = files.find((file) => file.path === pickedPath) ?? files[0];

  return (
    <div className="nx-diff">
      {liveMode && refreshing && (
        <span className="nx-diff-refreshing" data-testid="diff-refreshing">
          <LoaderCircle className="nx-spin" size={12} aria-hidden="true" /> Refreshing…
        </span>
      )}
      {/* A single cwd needs no control row; the working-directory picker appears
          only when more than one eligible directory exists. */}
      {(state?.cwds.length ?? 0) > 1 && (
        <div className="nx-diff-toolbar">
          <select
            className="nx-diff-cwd"
            data-testid="diff-cwd"
            aria-label="Working directory"
            value={effectiveCwd ?? ''}
            onChange={(event) => { setSelectedCwd(event.target.value); }}
          >
            {state?.cwds.map((cwd) => <option key={cwd} value={cwd}>{shortenCwd(cwd)}</option>)}
          </select>
        </div>
      )}
      {/* Refresh floats at the top-right of the Diff content — icon-only, so it
          never consumes a row — and re-reads only the live working tree. */}
      {liveMode && (
        <button
          type="button"
          className="nx-diff-refresh"
          data-testid="diff-refresh"
          aria-label="Refresh working tree"
          title="Refresh working tree"
          disabled={refreshing}
          onClick={() => setRefreshKey((key) => key + 1)}
        >
          <RefreshCw className={refreshing ? 'nx-spin' : ''} size={15} aria-hidden="true" />
        </button>
      )}
      {/* The pre-promotion manager entry appears only after this read-only Git
          context has independently confirmed a repository; a non-Git room
          stays on the ordinary channel path. */}
      {props.onManageWorktrees !== undefined && state?.selected != null && (
        <button
          type="button"
          className="nx-wt-entry"
          data-testid="worktree-entry"
          onClick={props.onManageWorktrees}
        >
          <GitBranch size={14} aria-hidden="true" />
          Worktrees…
        </button>
      )}

      <section className="nx-git-history" aria-label="Git revision">
        <button
          ref={historyToggleRef}
          type="button"
          className="nx-git-history-toggle"
          aria-expanded={historyOpen}
          data-testid="git-history-toggle"
          onClick={() => setHistoryOpen((open) => !open)}
        >
          <ChevronRight size={14} aria-hidden="true" className={historyOpen ? 'is-open' : ''} />
          <span>{liveMode ? 'Working tree / HEAD' : selectedMeta ? commitLabel(selectedMeta) : shortHash(selectedCommit)}</span>
          <small>History</small>
        </button>
        {historyOpen && (
          <div ref={historyPopoverRef} className="nx-git-history-list" data-testid="git-history-list">
            <button
              type="button"
              className={`nx-git-history-row ${liveMode ? 'is-active' : ''}`}
              aria-current={liveMode ? 'true' : undefined}
              onClick={() => { setSelectedCommit(undefined); setPickedPath(undefined); }}
            >
              <strong>Working tree / HEAD</strong><small>Live</small>
            </button>
            {historyError && (
              <div className="nx-git-history-error" role="alert" data-testid="git-history-error">
                <p className="nx-diff-note is-error">Couldn’t read commit history.</p>
                <button type="button" onClick={() => loadHistory(0, true)}>Retry</button>
              </div>
            )}
            {history !== undefined && !history.repository && (
              <p className="nx-diff-note" data-testid="git-history-no-repo">No Git repository at this location.</p>
            )}
            {history?.repository === true && history.commits.length === 0 && (
              <p className="nx-diff-note" data-testid="git-history-empty">No commits yet.</p>
            )}
            {history?.commits.map((commit) => (
              <button
                key={commit.hash}
                type="button"
                className={`nx-git-history-row ${selectedCommit === commit.hash ? 'is-active' : ''}`}
                aria-current={selectedCommit === commit.hash ? 'true' : undefined}
                data-testid="git-history-commit"
                onClick={() => {
                  setCommitState(undefined);
                  setCommitBusy(true);
                  setSelectedCommit(commit.hash);
                  setPickedPath(undefined);
                }}
              >
                <span className="nx-git-history-subject">{commit.subject || '(no subject)'}</span>
                <code>{shortHash(commit.hash)}</code>
                <small>{commit.author} · {new Date(commit.authored_ts).toLocaleString()}</small>
                {commit.refs.length > 0 && <span className="nx-git-refs">{commit.refs.join(' · ')}</span>}
              </button>
            ))}
            {historyBusy && <p className="nx-diff-note" data-testid="git-history-loading">Loading history…</p>}
            {history?.next_cursor !== null && history?.next_cursor !== undefined && !historyBusy && (
              <button
                type="button"
                className="nx-git-history-more"
                data-testid="git-history-more"
                onClick={() => loadHistory(history.next_cursor!, false)}
              >
                Load more
              </button>
            )}
          </div>
        )}
      </section>

      {!liveMode && selectedMeta !== undefined && (
        <div className="nx-git-commit-meta" data-testid="git-commit-meta">
          <strong>{selectedMeta.subject || '(no subject)'}</strong>
          <span><code>{selectedMeta.hash}</code> · {selectedMeta.author}</span>
          {selectedMeta.refs.length > 0 && <span>{selectedMeta.refs.join(' · ')}</span>}
          {commitState !== undefined && (
            <small>{commitState.comparison === 'root' ? 'Root commit compared with the empty tree' : 'Compared with first parent'}</small>
          )}
        </div>
      )}

      {!liveMode && commitBusy && <EmptyState testid="git-commit-loading">Reading commit…</EmptyState>}
      {!liveMode && commitError && <EmptyState testid="git-commit-error">Couldn’t read this commit.</EmptyState>}

      {!commitBusy && !commitError && files.length === 0 && !focusMissing && (
        <EmptyState testid={liveMode ? 'diff-clean' : 'git-commit-empty'}>
          {liveMode
            ? 'Working tree clean — no uncommitted changes.'
            : 'This commit has no changes against its comparison parent.'}
        </EmptyState>
      )}
      {!commitBusy && !commitError && files.length > 0 && (
        <ul className="nx-diff-files" data-testid="diff-files">
          {files.map((file) => (
            <li key={file.path}>
              <button
                className={`nx-diff-file ${file === active && !focusMissing ? 'is-active' : ''}`}
                onClick={() => setPickedPath(file.path)}
              >
                <span
                  className={`nx-diff-status is-${file.status}`}
                  title={file.old_path === undefined ? file.status : `${file.status} from ${file.old_path}`}
                >
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
        active !== undefined && (active.binary ? (
          <p className="nx-diff-note" data-testid="git-binary-note">Binary file changed; no text patch is available.</p>
        ) : (
          <>
            <DiffViewer diff={{ path: active.path, unified: active.diff }} />
            {active.truncated && <p className="nx-diff-note">Patch truncated at the server output limit.</p>}
          </>
        ))
      )}
      {commitState?.files_truncated === true && (
        <p className="nx-diff-note">File list truncated at the server output limit.</p>
      )}
    </div>
  );
}
// harn:end diff-panel-floats-refresh-and-overlays-history

// ── Preview tab: a bounded gallery of durable produced artifacts, message
//    attachments, and embedded run images, with an accessible image lightbox ──

const MAX_PREVIEW_ITEMS = 24;

type PreviewKind = 'raster' | 'document' | 'inert';

interface PreviewItem {
  key: string;
  kind: PreviewKind;
  name: string;
  mediaType: string;
  sourceMsgId: number;
  /** Served, inert URL for attachments/artifacts; absent for embedded run images. */
  href?: string;
  /** Attachment retrieval inputs; bearer auth never enters a presentable URL. */
  attachment?: { room: string; id: string; mime: string };
  /** data: URI for an embedded run image; absent otherwise. */
  dataUri?: string;
  size?: number;
}

/** Mirror the server's inert-serving classification: only raster images render;
 *  pdf/text are document cards; everything else (svg, html, binaries) is an inert
 *  download, never rendered inline. */
function previewKind(mediaType: string): PreviewKind {
  if (isImageAttachment(mediaType)) return 'raster';
  if (mediaType === 'application/pdf' || (mediaType.startsWith('text/') && mediaType !== 'text/html')) return 'document';
  return 'inert';
}

/** The room's durable produced-artifact feed, refetched whenever a run finalizes
 *  (a finalize may have snapshotted new files). */
function useArtifacts(room: string, token: () => string): ArtifactFeed {
  const messages = useClientStore((state) => roomSlice(state, room).messages);
  const [feed, setFeed] = useState<ArtifactFeed>({ artifacts: [], errors: [] });
  const finalizedRuns = useMemo(
    () => sortedMessages(messages).filter((m) => m.kind === 'run' && m.run !== undefined && m.run.status !== 'running').length,
    [messages],
  );
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchArtifacts(room, { token: token() });
        if (!cancelled) setFeed(next);
      } catch {
        // feed unavailable — keep the last good feed
      }
    })();
    return () => { cancelled = true; };
  }, [room, token, finalizedRuns]);
  return feed;
}

function PreviewTab(props: { room: string; token: () => string }) {
  const { images } = useRunImages(props.room, props.token);
  const { artifacts, errors } = useArtifacts(props.room, props.token);
  const messages = useClientStore((state) => roomSlice(state, props.room).messages);
  const [active, setActive] = useState<string | null>(null);
  const { room, token } = props;

  const items = useMemo(() => {
    const out: PreviewItem[] = [];
    // Durable artifacts are primary; embedded images from a covered turn are hidden.
    const artifactMsgIds = new Set(artifacts.map((a) => a.source_message_id));
    for (const a of artifacts) {
      out.push({
        key: `artifact:${a.id}`, kind: previewKind(a.media_type), name: a.name,
        mediaType: a.media_type, sourceMsgId: a.source_message_id,
        href: artifactUrl(room, a.id, token()), size: a.size,
      });
    }
    for (const message of sortedMessages(messages)) {
      for (const att of message.attachments ?? []) {
        out.push({
          key: `attachment:${att.id}`, kind: previewKind(att.mime), name: att.name,
          mediaType: att.mime, sourceMsgId: message.id,
          attachment: { room, id: att.id, mime: att.mime }, size: att.size,
        });
      }
    }
    for (const image of images) {
      if (artifactMsgIds.has(image.msgId)) continue;
      out.push({
        // Classify embedded run images by media_type like everything else, so a
        // non-raster embedded image is an inert card and never reaches an <img>.
        key: `run:${String(image.msgId)}:${image.data_b64.slice(0, 24)}`, kind: previewKind(image.media_type),
        name: `Turn #${String(image.msgId)} image`, mediaType: image.media_type,
        sourceMsgId: image.msgId, dataUri: `data:${image.media_type};base64,${image.data_b64}`,
      });
    }
    out.sort((a, b) => b.sourceMsgId - a.sourceMsgId);
    const seen = new Set<string>();
    return out.filter((item) => (seen.has(item.key) ? false : (seen.add(item.key), true))).slice(0, MAX_PREVIEW_ITEMS);
  }, [artifacts, images, messages, room, token]);

  const hasErrors = errors.length > 0;
  if (items.length === 0 && !hasErrors) {
    return <EmptyState testid="preview-empty">Nothing to preview yet — files agents produce appear here.</EmptyState>;
  }
  return (
    <div className="nx-preview" data-testid="preview-gallery">
      {hasErrors && (
        <p className="nx-preview-error" role="status" data-testid="preview-error">
          Some files an agent produced couldn’t be stored.
        </p>
      )}
      {items.length > 0 && (
        <ul className="nx-preview-grid">
          {items.map((item) => (
            <li key={item.key}>
              <PreviewEntry
                item={item}
                token={token}
                active={active === item.key}
                onOpen={() => setActive(item.key)}
                onClose={() => setActive(null)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PreviewEntry(props: {
  item: PreviewItem;
  token: () => string;
  active: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const attachment = props.item.attachment;
  if (attachment !== undefined) return <AttachmentPreviewEntry {...props} attachment={attachment} />;
  const href = props.item.href ?? props.item.dataUri;
  return (
    <>
      {props.item.kind === 'raster'
        ? href !== undefined && <PreviewThumb item={props.item} src={href} onOpen={props.onOpen} />
        : <PreviewCard item={props.item} href={href} />}
      {props.active && href !== undefined && <PreviewLightbox item={props.item} src={href} onClose={props.onClose} />}
    </>
  );
}

function AttachmentPreviewEntry(props: {
  item: PreviewItem;
  attachment: NonNullable<PreviewItem['attachment']>;
  token: () => string;
  active: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const { attachment, item } = props;
  const token = props.token();
  const loaded = useAttachmentObjectUrl(
    attachment.room,
    attachment.id,
    attachment.mime,
    token,
    item.kind === 'raster',
  );
  const download = useAttachmentDownload(
    attachment.room,
    attachment.id,
    attachment.mime,
    token,
    item.name,
  );
  return (
    <>
      {item.kind === 'raster'
        ? loaded !== undefined && <PreviewThumb item={item} src={loaded} onOpen={props.onOpen} />
        : <PreviewCard item={item} busy={download.busy} onDownload={() => { void download.download(); }} />}
      {props.active && loaded !== undefined && <PreviewLightbox item={item} src={loaded} onClose={props.onClose} />}
    </>
  );
}

function PreviewThumb(props: { item: PreviewItem; src: string; onOpen: () => void }) {
  return (
    <button type="button" className="nx-preview-thumb" data-testid="preview-thumb" onClick={props.onOpen}>
      <img src={props.src} alt={props.item.name} loading="lazy" />
      <span className="nx-preview-thumb-source">#{props.item.sourceMsgId}</span>
    </button>
  );
}

function PreviewCard(props: {
  item: PreviewItem;
  href?: string;
  busy?: boolean;
  onDownload?: () => void;
}) {
  const inert = props.item.kind === 'inert';
  return (
    <div className="nx-preview-card" data-testid={inert ? 'preview-inert' : 'preview-doc'}>
      <FileText className="nx-preview-card-icon" aria-hidden="true" size={18} strokeWidth={1.75} />
      <span className="nx-preview-card-name" title={props.item.name}>{props.item.name}</span>
      <span className="nx-preview-card-meta">
        {inert ? 'Download' : 'Document'} · #{props.item.sourceMsgId}
        {props.item.size !== undefined ? ` · ${formatAttachmentSize(props.item.size)}` : ''}
      </span>
      {props.onDownload !== undefined
        ? <button type="button" className="nx-btn is-quiet nx-preview-card-action" disabled={props.busy} onClick={props.onDownload}>
            {props.busy ? 'Preparing…' : 'Download'}
          </button>
        : props.href === undefined
          ? <span className="nx-btn is-quiet nx-preview-card-action" aria-disabled="true">Download</span>
          : <a className="nx-btn is-quiet nx-preview-card-action" href={props.href} download={props.item.name}>Download</a>}
    </div>
  );
}

function PreviewLightbox(props: { item: PreviewItem; src: string; onClose: () => void }) {
  return (
    <Modal label={`Preview: ${props.item.name}`} onClose={props.onClose} testid="preview-lightbox" wide>
      <div className="nx-lightbox">
        <div className="nx-lightbox-head">
          <span className="nx-lightbox-name" title={props.item.name}>{props.item.name}</span>
          <span className="nx-lightbox-source">from <a href={`#${String(props.item.sourceMsgId)}`}>#{props.item.sourceMsgId}</a></span>
          <IconButton icon={X} label="Close preview" size="sm" variant="quiet" data-testid="preview-lightbox-close" onClick={props.onClose} />
        </div>
        <div className="nx-lightbox-stage">
          <img src={props.src} alt={props.item.name} />
        </div>
        <div className="nx-lightbox-actions">
          <a className="nx-btn is-secondary" href={props.src} target="_blank" rel="noreferrer">Open</a>
          <a className="nx-btn is-primary" href={props.src} download={props.item.name}>Download</a>
        </div>
      </div>
    </Modal>
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
