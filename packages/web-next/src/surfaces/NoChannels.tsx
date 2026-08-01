import { deriveAssignableHandle, deriveRoomId, type Room } from '@codor/protocol';
import { ArchiveRestore, ArrowRight, FolderPlus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { createRoom, fetchArchivedRooms, restoreRoom } from '@runtime/api.js';

import { Button, Code } from '../primitives/primitives.js';
import { Section } from '../room/AgentControls.js';
import { FolderPicker } from '../room/FolderPicker.js';
import {
  StartingParticipantControls,
  type StartingParticipantSelection,
} from '../room/StartingParticipant.js';
import { useAdapterCatalog } from '../app/session.js';
import { groupByProject } from '../room/project-groups.js';

export function suggestedChannelName(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, '');
  const name = normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  return name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A confirmed empty room list is an onboarding state, not a dead end. */
export function NoChannels(props: { token: string }) {
  const token = useCallback(() => props.token, [props.token]);
  const adapterCatalog = useAdapterCatalog(token);
  const adapters = adapterCatalog.installed;
  const advanced = adapterCatalog.advanced;
  const [name, setName] = useState('');
  const [project, setProject] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [cwd, setCwd] = useState('');
  const [ownerName, setOwnerName] = useState('You');
  const [startingParticipant, setStartingParticipant] = useState<StartingParticipantSelection>({
    mode: 'none',
    valid: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [archivedRooms, setArchivedRooms] = useState<Room[]>([]);
  const [restoreBusy, setRestoreBusy] = useState<string>();
  const [restoreError, setRestoreError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void fetchArchivedRooms({ token: props.token }).then(
      (rooms) => {
        if (!cancelled) setArchivedRooms(rooms);
      },
      (failure: unknown) => {
        if (!cancelled) setRestoreError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => { cancelled = true; };
  }, [props.token]);

  const ownerHandle = useMemo(
    () => deriveAssignableHandle(ownerName.trim()),
    [ownerName],
  );
  const canCreate = name.trim() !== '' && cwd.trim() !== '' && ownerHandle !== undefined && !busy
    && startingParticipant.valid;
  const archivedProjectGroups = groupByProject(archivedRooms);

  const chooseFolder = (path: string): void => {
    setCwd(path);
    if (nameEdited) return;
    const suggested = suggestedChannelName(path);
    if (suggested !== '') setName(suggested);
  };

  const submit = (): void => {
    if (!canCreate || ownerHandle === undefined) return;
    setBusy(true);
    setError(undefined);
    void createRoom({
      name: name.trim(),
      ...(project.trim() !== '' && { project: project.trim() }),
      owner: { handle: ownerHandle, display_name: ownerName.trim() },
      cwd: cwd.trim(),
      ...(startingParticipant.starting_agent !== undefined
        && { starting_agent: startingParticipant.starting_agent }),
      ...(startingParticipant.starting_session !== undefined
        && { starting_session: startingParticipant.starting_session }),
    }, { token: props.token }).then(
      (room) => { window.location.assign(`/?room=${encodeURIComponent(room.id)}`); },
      (failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
        setBusy(false);
      },
    );
  };

  return (
    <main className="nx-onboarding" data-testid="first-channel-onboarding">
      <header className="nx-onboarding-head">
        <span className="nx-onboarding-mark" aria-hidden="true" />
        <p className="nx-eyebrow">{archivedRooms.length > 0 ? 'Channels' : 'Paired successfully'}</p>
        <h1>{archivedRooms.length > 0 ? 'No active channels' : 'Create your first channel'}</h1>
        <p>
          {archivedRooms.length > 0
            ? 'Create a new channel or restore one of your archived channels below.'
            : 'Point Codor at a project, then bring in an agent now or add one later.'}
        </p>
      </header>

      <form className="nx-onboarding-card" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <Section n={1} title="Channel" headingLevel={2}>
          <label className="nx-field">
            <span className="nx-label">Channel name</span>
            <input
              required
              autoFocus
              value={name}
              placeholder="e.g. My project"
              data-testid="first-channel-name"
              onChange={(event) => {
                setName(event.target.value);
                setNameEdited(true);
              }}
            />
            {name.trim() !== '' && <span className="nx-field-note">id: <Code>{deriveRoomId(name)}</Code></span>}
          </label>

          <label className="nx-field">
            <span className="nx-label">Project <span className="nx-req">· optional</span></span>
            <input
              value={project}
              maxLength={80}
              placeholder="e.g. PersonalOS"
              data-testid="first-channel-project"
              onChange={(event) => setProject(event.target.value)}
            />
            <span className="nx-field-note">Channels with the same project appear together.</span>
          </label>

          <label className="nx-field">
            <span className="nx-label">Your name</span>
            <input
              required
              value={ownerName}
              data-testid="first-channel-owner"
              onChange={(event) => setOwnerName(event.target.value)}
            />
            {ownerHandle === undefined
              ? <span className="nx-field-note is-error">Choose a name that produces a usable handle.</span>
              : <span className="nx-field-note">you’ll join as <Code>@{ownerHandle}</Code></span>}
          </label>

          <div className="nx-field">
            <span className="nx-label">Project folder <span className="nx-req">· required</span></span>
            <FolderPicker token={() => props.token} value={cwd} onChange={chooseFolder} idPrefix="first" />
            {!nameEdited && cwd !== '' && (
              <span className="nx-field-note" data-testid="first-channel-folder-suggestion">
                Suggested the folder name above. Editing the name keeps your choice.
              </span>
            )}
          </div>
        </Section>

        <Section n={2} title="Starting participant" headingLevel={2}>
          <div className="nx-first-agent">
            <StartingParticipantControls
              adapters={adapters}
              advanced={advanced}
              cwd={cwd}
              owner={ownerHandle === undefined ? undefined : { handle: ownerHandle }}
              idPrefix="first"
              onChange={setStartingParticipant}
              onRefresh={adapterCatalog.refresh}
              refreshing={adapterCatalog.refreshing}
              refreshError={adapterCatalog.refreshError}
            />
          </div>
        </Section>

        {error !== undefined && <p className="nx-field-note is-error nx-first-error" role="alert">{error}</p>}
        <footer className="nx-onboarding-actions">
          <span><FolderPlus size={15} aria-hidden="true" /> Creates a private workspace on this host.</span>
          <Button type="submit" variant="primary" disabled={!canCreate} data-testid="first-channel-create">
            {busy ? 'Creating…' : <>Create channel <ArrowRight size={15} aria-hidden="true" /></>}
          </Button>
        </footer>
      </form>
      {archivedRooms.length > 0 && (
        <section className="nx-onboarding-archived" aria-labelledby="archived-channels-title">
          <div>
            <p className="nx-eyebrow">Preserved work</p>
            <h2 id="archived-channels-title">Archived channels</h2>
          </div>
          {archivedProjectGroups.map((group) => (
            <details className="nx-onboarding-project" key={group.project ?? '__ungrouped'}>
              <summary>
                {group.project ?? 'No project'}
                <span>{group.items.length}</span>
                {group.project !== undefined && <em>Fully archived</em>}
              </summary>
              <ul>
            {group.items.map((archived) => (
              <li key={archived.id}>
                <span>{archived.name}</span>
                <Button
                  variant="secondary"
                  disabled={restoreBusy !== undefined}
                  data-testid={`restore-empty-room-${archived.id}`}
                  onClick={() => {
                    setRestoreBusy(archived.id);
                    setRestoreError(undefined);
                    void restoreRoom(archived.id, { token: props.token }).then(
                      (restored) => {
                        window.location.assign(`/?room=${encodeURIComponent(restored.id)}`);
                      },
                      (failure: unknown) => {
                        setRestoreError(failure instanceof Error ? failure.message : String(failure));
                        setRestoreBusy(undefined);
                      },
                    );
                  }}
                >
                  <ArchiveRestore size={14} aria-hidden="true" />
                  {restoreBusy === archived.id ? 'Restoring…' : 'Restore'}
                </Button>
              </li>
            ))}
              </ul>
            </details>
          ))}
          {restoreError !== undefined && (
            <p className="nx-field-note is-error" role="alert">{restoreError}</p>
          )}
        </section>
      )}
    </main>
  );
}
