import type { RunItemDiff } from '@codor/protocol';
import { useMemo } from 'react';

/** Syntax-aware unified-diff rendering shared by live working-tree and stored-run views. */
export function DiffViewer(props: { diff: RunItemDiff }) {
  const lines = useMemo(() => props.diff.unified.split('\n'), [props.diff.unified]);
  return (
    <pre className="nx-diff-view" data-testid="diff-view">
      {lines.map((line, index) => {
        const kind = line.startsWith('@@')
          ? 'hunk'
          : line.startsWith('+++') || line.startsWith('---')
            ? 'meta'
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
