import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { ArrowLeft, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchLedgerGraph,
  fetchLedgerNote,
  type LedgerGraph,
  type LedgerGraphNode,
  type LedgerNote,
} from '@runtime/api.js';
import { currentBrowserAccessToken } from '@runtime/crypto.js';

import { Code, IconButton } from '../primitives/primitives.js';

const WIDTH = 1000;
const HEIGHT = 700;

type NodeType = NonNullable<LedgerGraphNode['type']> | 'note';

interface LayoutNode extends LedgerGraphNode, SimulationNodeDatum {
  x: number;
  y: number;
}
type LayoutLink = SimulationLinkDatum<LayoutNode>;

function nodeType(node: LedgerGraphNode): NodeType {
  return node.type ?? 'note';
}

function layoutGraph(graph: LedgerGraph): { nodes: LayoutNode[]; links: LayoutLink[] } {
  const nodes: LayoutNode[] = graph.nodes.map((node) => ({ ...node, x: Number.NaN, y: Number.NaN }));
  const links: LayoutLink[] = graph.edges.map((edge) => ({ ...edge }));
  const simulation = forceSimulation(nodes)
    .force('link', forceLink<LayoutNode, LayoutLink>(links).id((node) => node.id).distance(120).strength(0.35))
    .force('charge', forceManyBody().strength(-310))
    .force('center', forceCenter(WIDTH / 2, HEIGHT / 2))
    .force('collide', forceCollide<LayoutNode>().radius(58).strength(0.8))
    .stop();
  for (let tick = 0; tick < 280; tick++) simulation.tick();
  for (const node of nodes) {
    node.x = Math.max(70, Math.min(WIDTH - 70, node.x ?? WIDTH / 2));
    node.y = Math.max(50, Math.min(HEIGHT - 50, node.y ?? HEIGHT / 2));
  }
  return { nodes, links };
}

const TYPE_TINTS: Record<NodeType, string> = {
  decision: 'var(--c-agent)',
  constraint: 'var(--c-warn)',
  contract: 'var(--c-accent)',
  note: 'var(--c-mark-faint)',
};

export function LedgerPage(props: { room: string; token: string }) {
  // The ledger is always reached from a room, so its id is in the URL. Falling
  // back to the remembered room keeps a direct /ledger link working rather than
  // inventing a placeholder channel.
  const page = { room: props.room };
  const token = useMemo(() => () => currentBrowserAccessToken(props.token), [props.token]);
  const [graph, setGraph] = useState<LedgerGraph>();
  const [failed, setFailed] = useState(false);
  const [hidden, setHidden] = useState<Set<NodeType>>(new Set());
  const [selected, setSelected] = useState<LedgerGraphNode>();
  const [note, setNote] = useState<LedgerNote>();
  const [view, setView] = useState({ x: 0, y: 0, w: WIDTH, h: HEIGHT });
  const dragRef = useRef<{ startX: number; startY: number; view: typeof view }>();

  useEffect(() => {
    void fetchLedgerGraph(page.room, { token: token() })
      .then(setGraph)
      .catch(() => setFailed(true));
  }, [page.room, token]);

  useEffect(() => {
    if (selected === undefined) {
      setNote(undefined);
      return;
    }
    let current = true;
    void fetchLedgerNote(page.room, selected.name, { token: token() })
      .then((loaded) => { if (current) setNote(loaded); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [selected, page.room, token]);

  const laidOut = useMemo(() => (graph !== undefined ? layoutGraph(graph) : undefined), [graph]);
  const byId = useMemo(() => new Map((laidOut?.nodes ?? []).map((n) => [n.id, n])), [laidOut]);
  const presentTypes = useMemo(
    () => [...new Set((graph?.nodes ?? []).map(nodeType))],
    [graph],
  );

  const toggleType = (type: NodeType): void => {
    setHidden((prior) => {
      const next = new Set(prior);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const zoom = (factor: number, cx = view.x + view.w / 2, cy = view.y + view.h / 2): void => {
    setView((prior) => {
      const w = Math.min(WIDTH * 2, Math.max(WIDTH / 6, prior.w * factor));
      const h = w * (HEIGHT / WIDTH);
      return { x: cx - w / 2, y: cy - h / 2, w, h };
    });
  };

  return (
    <main className="nx-surface is-settings" aria-label="Ledger" data-testid="ledger-page">
      <div className="nx-ledger">
        <header className="nx-settings-head">
          <a className="nx-btn is-quiet nx-settings-back" href={`/?room=${encodeURIComponent(page.room)}`}>
            <ArrowLeft size={15} aria-hidden="true" /> Back to the channel
          </a>
          <h1>Ledger</h1>
          <p className="nx-settings-sub">
            Decisions, constraints, and contracts the agents committed to the vault — read-only.
          </p>
        </header>

        {failed && <p className="nx-field-note is-error">Couldn’t load this channel’s ledger.</p>}
        {graph !== undefined && graph.nodes.length === 0 && (
          <div className="nx-context-empty" data-testid="ledger-empty">
            <div className="nx-dotgrid" aria-hidden="true" />
            <p>No ledger notes yet — agents write them as they decide things.</p>
          </div>
        )}

        {laidOut !== undefined && laidOut.nodes.length > 0 && (
          <section className="nx-settings-card nx-ledger-card">
            <div className="nx-ledger-filters" data-testid="ledger-filters">
              {presentTypes.map((type) => (
                <button
                  key={type}
                  className={`nx-limit nx-ledger-filter ${hidden.has(type) ? 'is-off' : ''}`}
                  aria-pressed={!hidden.has(type)}
                  data-testid={`ledger-filter-${type}`}
                  onClick={() => toggleType(type)}
                >
                  <span className="nx-ledger-dot" style={{ background: TYPE_TINTS[type] }} />
                  {type}
                </button>
              ))}
              <span className="nx-composer-spacer" />
              <button className="nx-btn is-quiet" onClick={() => zoom(0.8)} aria-label="Zoom in">+</button>
              <button className="nx-btn is-quiet" onClick={() => zoom(1.25)} aria-label="Zoom out">−</button>
            </div>
            <svg
              className="nx-ledger-svg"
              data-testid="ledger-svg"
              viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
              role="img"
              aria-label="Ledger graph"
              onPointerDown={(event) => {
                (event.target as Element).setPointerCapture?.(event.pointerId);
                dragRef.current = { startX: event.clientX, startY: event.clientY, view };
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (!drag) return;
                const scale = view.w / (event.currentTarget.clientWidth || WIDTH);
                setView({
                  ...drag.view,
                  x: drag.view.x - (event.clientX - drag.startX) * scale,
                  y: drag.view.y - (event.clientY - drag.startY) * scale,
                });
              }}
              onPointerUp={() => { dragRef.current = undefined; }}
              onWheel={(event) => zoom(event.deltaY > 0 ? 1.1 : 0.9)}
            >
              {laidOut.links.map((link, index) => {
                const source = typeof link.source === 'object' ? link.source as LayoutNode : byId.get(String(link.source));
                const target = typeof link.target === 'object' ? link.target as LayoutNode : byId.get(String(link.target));
                if (!source || !target) return null;
                if (hidden.has(nodeType(source)) || hidden.has(nodeType(target))) return null;
                return (
                  <line
                    key={index}
                    x1={source.x}
                    y1={source.y}
                    x2={target.x}
                    y2={target.y}
                    className="nx-ledger-edge"
                  />
                );
              })}
              {laidOut.nodes.filter((node) => !hidden.has(nodeType(node))).map((node) => (
                <g
                  key={node.id}
                  className={`nx-ledger-node ${selected?.id === node.id ? 'is-selected' : ''}`}
                  transform={`translate(${node.x}, ${node.y})`}
                  data-testid={`ledger-node-${node.id}`}
                  onClick={() => setSelected(node)}
                >
                  <circle r="26" style={{ fill: TYPE_TINTS[nodeType(node)] }} />
                  <text y="42" textAnchor="middle">{node.name}</text>
                </g>
              ))}
            </svg>
          </section>
        )}

        {selected !== undefined && (
          <aside className="nx-settings-card nx-ledger-note" data-testid="ledger-note">
            <div className="nx-inspect-head">
              <h2 className="nx-dialog-title">{selected.name}</h2>
              <IconButton icon={X} label="Close note" size="sm" variant="quiet" onClick={() => setSelected(undefined)} />
            </div>
            <p className="nx-field-note"><Code>{selected.relative_path}</Code> · {nodeType(selected)}</p>
            {note !== undefined
              ? <pre className="nx-inspect-block nx-ledger-body">{note.content}</pre>
              : <p className="nx-field-note">Loading note…</p>}
          </aside>
        )}
      </div>
    </main>
  );
}
