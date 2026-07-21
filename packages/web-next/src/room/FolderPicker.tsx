/**
 * Inline remote directory picker.
 *
 * v2 replaces the "Browse" button with the browser always open, so choosing a
 * folder is one interaction rather than two. Both dialogs use it, so the host
 * chip, breadcrumb and selection semantics cannot drift apart.
 *
 * Browsing does not commit. Every navigation used to call `onChange`, so opening
 * the picker to look around silently changed the channel's folder with no way
 * back out; the selection moves only when a row is chosen.
 */
import { ArrowUp, ChevronRight, CornerLeftUp, Folder, Monitor, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { fetchLocalDirectories, type LocalDirectoryListing } from '@runtime/api.js';

export function FolderPicker(props: {
  token: () => string;
  value: string;
  onChange: (path: string) => void;
  idPrefix: string;
}) {
  const [listing, setListing] = useState<LocalDirectoryListing>();
  const [failed, setFailed] = useState(false);
  const [hidden, setHidden] = useState(false);

  /**
   * `retryAtRoot` exists because the starting path is not always listable. The
   * spawn dialog opens at the INHERITED working directory, which can sit outside
   * whatever the daemon is willing to browse — that returned 403 and left the
   * picker dead, with no way to navigate anywhere. Falling back to the default
   * root keeps the control usable and preserves the typed path as the selection.
   */
  const load = (path?: string, showHidden = hidden, retryAtRoot = false): void => {
    void fetchLocalDirectories(path, showHidden, { token: props.token() })
      .then((next) => { setListing(next); setFailed(false); })
      .catch(() => {
        if (retryAtRoot && path !== undefined) load(undefined, showHidden, false);
        else setFailed(true);
      });
  };

  useEffect(() => {
    load(props.value === '' ? undefined : props.value, hidden, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed) {
    // An error used to replace the whole control, stranding the operator with no
    // retry and no way to type a path they already knew.
    return (
      <div className="nx-picker" data-testid={`${props.idPrefix}-folder-picker`}>
        <div className="nx-picker-foot">
          <span className="nx-note is-error">Couldn’t list folders on this device.</span>
          <button type="button" className="nx-tile is-compact"
            data-testid={`${props.idPrefix}-folder-retry`}
            onClick={() => { setFailed(false); load(undefined, hidden, false); }}>
            Retry
          </button>
        </div>
        <input
          className="nx-input"
          value={props.value}
          onChange={(e) => { props.onChange(e.target.value); }}
          placeholder="or type a path"
          aria-label="Folder path"
          data-testid={`${props.idPrefix}-folder-typed`}
        />
      </div>
    );
  }
  if (listing === undefined) return <p className="nx-note">Loading folders…</p>;

  const segments = listing.path.split('/').filter((part) => part !== '');
  const crumbs = segments.map((name, index) => ({
    name,
    path: `/${segments.slice(0, index + 1).join('/')}`,
  }));
  // The reference shows a machine name here. No hostname is exposed by the
  // directory API or the protocol, so this states what is true rather than
  // inventing one; surfacing the real host needs a protocol change.
  const host = 'this device';

  return (
    <div className="nx-picker" data-testid={`${props.idPrefix}-folder-picker`}>
      <div className="nx-picker-bar">
        <span className="nx-host" title={String(host)}>
          <Monitor size={12} aria-hidden="true" />
          {String(host)}
        </span>
        <nav className="nx-crumbs" aria-label="Folder path">
          <button type="button" data-testid={`${props.idPrefix}-crumb-root`}
            onClick={() => { load('/'); }}>~</button>
          {crumbs.map((crumb, i) => (
            <button
              key={crumb.path}
              type="button"
              className={i === crumbs.length - 1 ? 'is-current' : undefined}
              data-testid={`${props.idPrefix}-crumb-${crumb.name}`}
              onClick={() => { load(crumb.path); }}
            >
              {crumb.name}
            </button>
          ))}
        </nav>
        <span className="nx-picker-tools">
          {listing.parent !== null && (
            <button type="button" aria-label="Up one folder" data-testid={`${props.idPrefix}-folder-up`}
              onClick={() => { load(listing.parent ?? undefined); }}>
              <ArrowUp size={14} aria-hidden="true" />
            </button>
          )}
          <button type="button" aria-label="Refresh" data-testid={`${props.idPrefix}-folder-refresh`}
            onClick={() => { load(listing.path); }}>
            <RotateCw size={14} aria-hidden="true" />
          </button>
        </span>
      </div>

      <ul className="nx-picker-list">
        {listing.parent !== null && (
          <li>
            <button type="button" className="nx-picker-row is-up"
              data-testid={`${props.idPrefix}-folder-parent`}
              onClick={() => { load(listing.parent ?? undefined); }}>
              <CornerLeftUp size={14} aria-hidden="true" />
              <span className="nx-mono">..</span>
            </button>
          </li>
        )}
        {listing.dirs.length === 0 && <li className="nx-note">no subfolders</li>}
        {listing.dirs.map((dir) => (
          <li key={dir.path}>
            {/* Two distinct affordances, both keyboard- and touch-reachable:
                the row selects, the chevron opens. Double-click carried the
                "open" meaning before, which no keyboard user can reach and
                touch fires unreliably. */}
            <span className="nx-picker-pair">
              <button
                type="button"
                className="nx-picker-row"
                aria-pressed={props.value === dir.path}
                data-testid={`${props.idPrefix}-folder-${dir.name}`}
                onClick={() => { props.onChange(dir.path); }}
              >
                <Folder size={14} aria-hidden="true" />
                <span className="nx-mono">{dir.name}</span>
                <span className="nx-check" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="nx-picker-open"
                aria-label={`Open ${dir.name}`}
                data-testid={`${props.idPrefix}-open-${dir.name}`}
                onClick={() => { load(dir.path); }}
              >
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </span>
          </li>
        ))}
      </ul>

      <div className="nx-picker-foot">
        <label className="nx-hidden-toggle">
          {/* Without this ~/.config and every other dotfile directory is unreachable. */}
          <input
            type="checkbox"
            checked={hidden}
            data-testid={`${props.idPrefix}-folder-hidden`}
            onChange={(e) => { setHidden(e.target.checked); load(listing.path, e.target.checked); }}
          />
          Hidden
        </label>
        <span className="nx-picker-selected">
          {props.value === ''
            ? <span data-testid={`${props.idPrefix}-folder-selected`}>No folder selected</span>
            : <>Selected <code data-testid={`${props.idPrefix}-folder-selected`}>{props.value}</code></>}
        </span>
      </div>

      {/* A path outside the browsable tree — a mount, a symlink target — is
          otherwise unreachable, because browsing is the only way in. */}
      <input
        className="nx-input"
        value={props.value}
        onChange={(e) => { props.onChange(e.target.value); }}
        placeholder="or type a path"
        aria-label="Folder path"
        data-testid={`${props.idPrefix}-folder-typed`}
      />
    </div>
  );
}
