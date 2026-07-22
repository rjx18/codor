import type { RunItemDiff } from '@codor/protocol';
import { X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { diffStat } from '@runtime/run-presenter.js';

import { Modal } from '../primitives/primitives.js';
import { DiffViewer } from './DiffViewer.js';

/** Preserve event order while presenting repeated edits to one path as one file. */
export function mergeStoredDiffs(diffs: readonly RunItemDiff[]): RunItemDiff[] {
  const byPath = new Map<string, RunItemDiff>();
  for (const diff of diffs) {
    const prior = byPath.get(diff.path);
    byPath.set(diff.path, prior === undefined
      ? { ...diff }
      : { ...prior, ...diff, unified: [prior.unified, diff.unified].filter(Boolean).join('\n') });
  }
  return [...byPath.values()];
}

export function RunDiffDialog(props: {
  diffs: readonly RunItemDiff[];
  initialPath?: string;
  onClose: () => void;
}) {
  const files = useMemo(() => mergeStoredDiffs(props.diffs), [props.diffs]);
  const initial = files.some((file) => file.path === props.initialPath)
    ? props.initialPath
    : files[0]?.path;
  const [selectedPath, setSelectedPath] = useState(initial);
  const selected = files.find((file) => file.path === selectedPath) ?? files[0];

  return (
    <Modal label="Stored run diff" onClose={props.onClose} testid="historical-diff-dialog" wide structured>
      <header className="nx-dialog-head">
        <div>
          <h2 className="nx-dialog-title">Stored run diff</h2>
          <p className="nx-dialog-sub">Saved with this run. Current files are not read.</p>
        </div>
        <button className="nx-dialog-close" type="button" aria-label="Close stored diff" onClick={props.onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="nx-dialog-body nx-run-diff-body">
        {files.length === 0 ? (
          <p className="nx-diff-note" data-testid="stored-diff-empty">
            No stored diff evidence is available for this run.
          </p>
        ) : (
          <>
            <nav className="nx-run-diff-files" aria-label="Stored diff files">
              {files.map((file) => {
                const stat = diffStat(file.unified);
                return (
                  <button
                    key={file.path}
                    type="button"
                    className="nx-run-diff-file"
                    aria-current={file.path === selected?.path ? 'true' : undefined}
                    onClick={() => setSelectedPath(file.path)}
                  >
                    <span className="nx-diff-path">{file.path}</span>
                    <span className="nx-diff-stat">
                      <em className="is-add">+{stat.added}</em>{' '}
                      <em className="is-del">−{stat.removed}</em>
                    </span>
                  </button>
                );
              })}
            </nav>
            <section className="nx-run-diff-content" aria-label={selected?.path ?? 'Stored patch'}>
              {selected !== undefined && selected.unified !== '' ? (
                <DiffViewer diff={selected} />
              ) : (
                <p className="nx-diff-note" data-testid="stored-diff-patch-empty">
                  No stored patch content was recorded for {selected?.path}.
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
