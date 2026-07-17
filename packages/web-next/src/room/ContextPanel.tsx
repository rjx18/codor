import type { AgentLimit, Member, RunItemDiff, WireEvent } from '@codor/protocol';
import { MoreVertical, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { fetchRunEvents, type AdapterRegistration, type MemberDetail } from '@legacy/api.js';
import { diffStat, presentRunEvents, type RunRow } from '@legacy/run-presenter.js';
import { sortedMessages, useRoomStore } from '@legacy/state.js';
import type { Connection } from '@legacy/ws.js';

import { clockTime, compactCount, memberAccent, usd } from '../primitives/identity.js';
import { Button, Chip, Eyebrow, IconButton, Modal, Segmented, StatusPill } from '../primitives/primitives.js';
import { useAdapters, useMemberDetails } from '../app/session.js';

type Tab = 'members' | 'diff' | 'preview';

export function ContextPanel(props: { room: string; token: () => string; connection: Connection }) {
  const [tab, setTab] = useState<Tab>('members');
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
      {tab === 'diff' && <DiffTab room={props.room} token={props.token} />}
      {tab === 'preview' && <PreviewTab room={props.room} token={props.token} />}
    </aside>
  );
}

// ── Members: owner first, then agents; cards carry account + spend; the six
// lifecycle actions live in a kebab dropdown with confirm flows. ────────────

function MembersTab(props: { room: string; token: () => string; connection: Connection }) {
  const members = useRoomStore((s) => s.members);
  const details = useMemberDetails(props.room, props.token);
  const adapters = useAdapters(props.token);
  const [spawning, setSpawning] = useState(false);

  const roster = useMemo(() => {
    // Extensions are transient run machinery — the roster lists durable members.
    const active = Object.values(members).filter(
      (m) => m.removed_ts === undefined && m.kind !== 'extension',
    );
    const humans = active.filter((m) => m.kind === 'human');
    const agents = active.filter((m) => m.kind !== 'human');
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
            connection={props.connection}
          />
        ))}
      </ul>
      {spawning && (
        <SpawnDialog
          adapters={adapters}
          onClose={() => setSpawning(false)}
          onSpawn={(spec) => {
            props.connection.act({ act: 'spawn', ...spec });
            setSpawning(false);
          }}
        />
      )}
    </div>
  );
}

function MemberCard(props: {
  member: Member;
  detail: MemberDetail | undefined;
  connection: Connection;
}) {
  const { member, detail } = props;
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
        {member.kind === 'agent' && (
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
          {spend !== undefined ? ` · ${usd(spend.cost_usd)} · ${spend.turns} turns` : ''}
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
        <Button variant="quiet" onClick={props.onClose}>Cancel</Button>
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

const THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'] as const;
const POLICIES = ['read-only', 'workspace-write', 'full-access'] as const;

function ConfigureDialog(props: {
  member: Member;
  onClose: () => void;
  onConfigure: (patch: {
    model?: string | null;
    thinking?: (typeof THINKING_LEVELS)[number] | null;
    policy?: (typeof POLICIES)[number];
  }) => void;
}) {
  const [model, setModel] = useState(props.member.model ?? '');
  const [thinking, setThinking] = useState(props.member.thinking ?? '');
  const [policy, setPolicy] = useState(props.member.policy ?? '');
  return (
    <Modal label={`Configure @${props.member.handle}`} onClose={props.onClose} testid="configure-dialog">
      <h2 className="nx-dialog-title">Configure @{props.member.handle}</h2>
      <label className="nx-field">
        Model (empty = harness default)
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="harness default" />
      </label>
      <label className="nx-field">
        Thinking
        <select value={thinking} onChange={(e) => setThinking(e.target.value)}>
          <option value="">harness default</option>
          {THINKING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      </label>
      <label className="nx-field">
        Policy
        <select value={policy} onChange={(e) => setPolicy(e.target.value)}>
          <option value="">leave as is</option>
          {POLICIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
      <div className="nx-dialog-actions">
        <Button variant="quiet" onClick={props.onClose}>Cancel</Button>
        <Button
          variant="primary"
          onClick={() => props.onConfigure({
            model: model.trim() === '' ? null : model.trim(),
            thinking: thinking === '' ? null : thinking as (typeof THINKING_LEVELS)[number],
            ...(policy !== '' && { policy: policy as (typeof POLICIES)[number] }),
          })}
        >
          Apply
        </Button>
      </div>
    </Modal>
  );
}

function SpawnDialog(props: {
  adapters: AdapterRegistration[];
  onClose: () => void;
  onSpawn: (spec: {
    harness: string; handle: string; cwd: string;
    model?: string; policy?: string; thinking?: (typeof THINKING_LEVELS)[number]; purpose?: string;
  }) => void;
}) {
  const [harness, setHarness] = useState(props.adapters[0]?.id ?? '');
  const [handle, setHandle] = useState('');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [policy, setPolicy] = useState('');
  const [thinking, setThinking] = useState('');
  const [purpose, setPurpose] = useState('');
  const chosen = props.adapters.find((a) => a.id === harness);
  const canSpawn = harness !== '' && handle.trim() !== '' && cwd.trim() !== '';

  return (
    <Modal label="Spawn agent" onClose={props.onClose} testid="spawn-dialog">
      <h2 className="nx-dialog-title">Spawn agent</h2>
      <label className="nx-field">
        Harness
        <select value={harness} onChange={(e) => { setHarness(e.target.value); setModel(''); }} data-testid="spawn-harness">
          {props.adapters.length === 0 && <option value="">discovering…</option>}
          {props.adapters.map((adapter) => <option key={adapter.id} value={adapter.id}>{adapter.id}</option>)}
        </select>
      </label>
      <label className="nx-field">
        Handle
        <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="e.g. scout" data-testid="spawn-handle" />
      </label>
      <label className="nx-field">
        Working directory
        <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/home/you/project" data-testid="spawn-cwd" />
      </label>
      <label className="nx-field">
        Model
        {chosen?.models !== undefined && chosen.models.length > 0 ? (
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">harness default</option>
            {chosen.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : (
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="harness default" />
        )}
      </label>
      <label className="nx-field">
        Policy
        <select value={policy} onChange={(e) => setPolicy(e.target.value)}>
          <option value="">harness default</option>
          {POLICIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
      <label className="nx-field">
        Thinking
        <select value={thinking} onChange={(e) => setThinking(e.target.value)}>
          <option value="">harness default</option>
          {THINKING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      </label>
      <label className="nx-field">
        Purpose (optional)
        <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="what this agent is for" />
      </label>
      <div className="nx-dialog-actions">
        <Button variant="quiet" onClick={props.onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={!canSpawn}
          data-testid="spawn-go"
          onClick={() => props.onSpawn({
            harness,
            handle: handle.trim(),
            cwd: cwd.trim(),
            ...(model !== '' && { model }),
            ...(policy !== '' && { policy }),
            ...(thinking !== '' && { thinking: thinking as (typeof THINKING_LEVELS)[number] }),
            ...(purpose.trim() !== '' && { purpose: purpose.trim() }),
          })}
        >
          Spawn
        </Button>
      </div>
    </Modal>
  );
}

// ── Diff tab: run evidence — file rows with ± counts → tinted diff viewer ──

interface EvidenceDiff {
  msgId: number;
  diff: RunItemDiff;
  added: number;
  removed: number;
}

function useRunEvidence(room: string, token: () => string): { diffs: EvidenceDiff[]; images: { msgId: number; media_type: string; data_b64: string }[] } {
  const messages = useRoomStore((s) => s.messages);
  const [evidence, setEvidence] = useState<{ diffs: EvidenceDiff[]; images: { msgId: number; media_type: string; data_b64: string }[] }>({ diffs: [], images: [] });
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
      const diffs: EvidenceDiff[] = [];
      const images: { msgId: number; media_type: string; data_b64: string }[] = [];
      for (const [msgId, rows] of [...rowsByMsg.current.entries()].sort(([a], [b]) => a - b)) {
        for (const row of rows) {
          if (row.diff?.unified !== undefined) {
            const { added, removed } = diffStat(row.diff.unified);
            diffs.push({ msgId, diff: row.diff, added, removed });
          }
          if (row.image !== undefined) images.push({ msgId, ...row.image });
        }
      }
      setEvidence({ diffs, images });
    })();
    return () => { cancelled = true; };
  }, [messages, room, token]);

  return evidence;
}

function DiffTab(props: { room: string; token: () => string }) {
  const { diffs } = useRunEvidence(props.room, props.token);
  const [selected, setSelected] = useState<number>();
  const active = selected !== undefined ? diffs[selected] : diffs.at(-1);

  if (diffs.length === 0) {
    return <EmptyState testid="diff-empty">No file changes yet — run evidence lands here.</EmptyState>;
  }
  return (
    <div className="nx-diff">
      <ul className="nx-diff-files" data-testid="diff-files">
        {diffs.map((entry, index) => (
          <li key={`${entry.msgId}-${index}`}>
            <button
              className={`nx-diff-file ${entry === active ? 'is-active' : ''}`}
              onClick={() => setSelected(index)}
            >
              <span className="nx-diff-path">{entry.diff.path}</span>
              <span className="nx-diff-stat">
                <em className="is-add">+{entry.added}</em> <em className="is-del">−{entry.removed}</em>
              </span>
              <a
                className="nx-diff-source"
                href={`#${entry.msgId}`}
                onClick={(e) => e.stopPropagation()}
              >
                #{entry.msgId}
              </a>
            </button>
          </li>
        ))}
      </ul>
      {active !== undefined && <DiffViewer diff={active.diff} />}
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
  const { images } = useRunEvidence(props.room, props.token);
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
