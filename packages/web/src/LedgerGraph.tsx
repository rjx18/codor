import type { Room } from '@wireroom/protocol';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import {
  ArrowLeft,
  Filter,
  Focus,
  LockKeyhole,
  Maximize2,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchLedgerGraph,
  fetchLedgerNote,
  fetchMemberDetails,
  fetchRooms,
  type LedgerGraph,
  type LedgerGraphNode,
  type LedgerNote,
} from './api.js';
import { RoomRail } from './shell.js';

const WIDTH = 1000;
const HEIGHT = 700;

interface LayoutNode extends LedgerGraphNode, SimulationNodeDatum {
  x: number;
  y: number;
}

type LayoutLink = SimulationLinkDatum<LayoutNode> & { source: string | LayoutNode; target: string | LayoutNode };

function displayName(name: string): string {
  return name.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
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
  simulation.stop();
  for (const node of nodes) {
    node.x = Math.max(70, Math.min(WIDTH - 70, node.x ?? WIDTH / 2));
    node.y = Math.max(50, Math.min(HEIGHT - 50, node.y ?? HEIGHT / 2));
  }
  return { nodes, links };
}

function linkedNodeId(value: string | LayoutNode): string {
  return typeof value === 'string' ? value : value.id;
}

// harn:assume graph-derived-from-vault-links-readonly ref=ledger-graph-web
export function LedgerGraphPage(props: { token: string }) {
  const requestedRoom = useMemo(() => new URLSearchParams(window.location.search).get('room') ?? '', []);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [owner, setOwner] = useState<{ handle: string; display_name: string }>();
  const [graph, setGraph] = useState<LedgerGraph>({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [type, setType] = useState<'all' | 'decision' | 'constraint' | 'contract'>('all');
  const [selected, setSelected] = useState<string>();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [overlayMode, setOverlayMode] = useState(() => window.matchMedia('(max-width: 1359px)').matches);
  const [note, setNote] = useState<LedgerNote>();
  const [noteFailed, setNoteFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState<{ x: number; y: number; panX: number; panY: number }>();
  const graphSurface = useRef<HTMLDivElement>(null);
  const inspector = useRef<HTMLElement>(null);
  const inspectorClose = useRef<HTMLButtonElement>(null);
  const inspectorTrigger = useRef<HTMLElement | SVGElement>();

  useEffect(() => {
    let current = true;
    void fetchRooms({ token: props.token })
      .then((items) => { if (current) setRooms(items); })
      .catch(() => { if (current) setRooms([]); });
    return () => { current = false; };
  }, [props.token]);

  const room = requestedRoom || rooms[0]?.id || '';
  const roomName = rooms.find((candidate) => candidate.id === room)?.name ?? room;

  useEffect(() => {
    if (room === '') return;
    let current = true;
    setLoading(true);
    setFailed(false);
    void fetchLedgerGraph(room, { token: props.token })
      .then((next) => {
        if (!current) return;
        setGraph(next);
        setSelected((selection) => next.nodes.some((node) => node.id === selection)
          ? selection
          : next.nodes[0]?.id);
      })
      .catch(() => { if (current) setFailed(true); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [props.token, room]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1359px)');
    const changed = (): void => {
      setOverlayMode(media.matches);
      if (!media.matches) setInspectorOpen(false);
    };
    changed();
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);

  useEffect(() => {
    const surface = graphSurface.current;
    if (!surface) return;
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      setZoom((value) => Math.max(0.6, Math.min(2.2, value * (event.deltaY > 0 ? 0.9 : 1.1))));
    };
    surface.addEventListener('wheel', wheel, { passive: false });
    return () => surface.removeEventListener('wheel', wheel);
  }, []);

  useEffect(() => {
    if (room === '') return;
    let current = true;
    void fetchMemberDetails(room, { token: props.token })
      .then((items) => {
        if (!current) return;
        const member = items.find((item) => item.member.kind === 'human' && item.member.role === 'owner')?.member;
        setOwner(member ? { handle: member.handle, display_name: member.display_name } : undefined);
      })
      .catch(() => { if (current) setOwner(undefined); });
    return () => { current = false; };
  }, [props.token, room]);

  useEffect(() => {
    if (!selected || room === '') {
      setNote(undefined);
      return;
    }
    let current = true;
    setNote(undefined);
    setNoteFailed(false);
    void fetchLedgerNote(room, selected, { token: props.token })
      .then((next) => { if (current) setNote(next); })
      .catch(() => { if (current) setNoteFailed(true); });
    return () => { current = false; };
  }, [props.token, room, selected]);

  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const visible = useMemo(() => new Set(layout.nodes
    .filter((node) => type === 'all' || node.type === type)
    .filter((node) => node.name.includes(query.trim().toLowerCase()) || displayName(node.name).toLowerCase().includes(query.trim().toLowerCase()))
    .map((node) => node.id)), [layout.nodes, query, type]);
  const selectedNode = graph.nodes.find((node) => node.id === selected);
  const links = graph.edges.filter((edge) => edge.source === selected).map((edge) => edge.target);
  const backlinks = graph.edges.filter((edge) => edge.target === selected).map((edge) => edge.source);

  const closeInspector = useCallback((): void => {
    setInspectorOpen(false);
    requestAnimationFrame(() => inspectorTrigger.current?.focus());
  }, []);

  useEffect(() => {
    if (!overlayMode || !inspectorOpen) return;
    requestAnimationFrame(() => inspectorClose.current?.focus());
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeInspector();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(inspector.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
  }, [closeInspector, inspectorOpen, overlayMode]);

  const selectNode = (id: string, trigger?: HTMLElement | SVGElement): void => {
    setSelected(id);
    if (overlayMode) {
      if (trigger) inspectorTrigger.current = trigger;
      setInspectorOpen(true);
    }
    setQuery('');
    setType('all');
  };

  return (
    <div data-testid="ledger-graph-page" className="wr-canvas wr-ledger-grid">
      <RoomRail
        rooms={rooms}
        currentRoom={room}
        currentUnread={0}
        currentHeld={0}
        connected={!failed}
        token={props.token}
        owner={owner}
        canCreateRoom={false}
      />
      <main className="wr-ledger-main">
        <header className="wr-ledger-header">
          <a href={`/?${new URLSearchParams({ room }).toString()}`} className="wr-icon-button" aria-label="Back to room" title="Back to room">
            <ArrowLeft aria-hidden="true" size={18} />
          </a>
          <div className="wr-ledger-title">
            <strong>Ledger</strong>
            <span>{roomName || 'Room'} <LockKeyhole aria-hidden="true" size={13} /> Encrypted</span>
          </div>
          <label className="wr-ledger-search">
            <Search aria-hidden="true" size={16} />
            <span className="sr-only">Search notes</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes" />
            {query !== '' && <button type="button" aria-label="Clear note search" onClick={() => setQuery('')}><X size={14} /></button>}
          </label>
          <label className="wr-ledger-filter">
            <Filter aria-hidden="true" size={16} />
            <span className="sr-only">Filter note type</span>
            <select value={type} onChange={(event) => setType(event.target.value as typeof type)}>
              <option value="all">All notes</option>
              <option value="decision">Decisions</option>
              <option value="constraint">Constraints</option>
              <option value="contract">Contracts</option>
            </select>
          </label>
          <button type="button" className="wr-icon-button" aria-label="Reset graph view" title="Reset graph view" onClick={() => { setPan({ x: 0, y: 0 }); setZoom(1); }}>
            <Focus aria-hidden="true" size={17} />
          </button>
          <button type="button" className="wr-icon-button" aria-label="Enter fullscreen" title="Fullscreen" onClick={() => { void graphSurface.current?.requestFullscreen(); }}>
            <Maximize2 aria-hidden="true" size={17} />
          </button>
        </header>
        <div
          ref={graphSurface}
          data-testid="ledger-graph-surface"
          className="wr-ledger-surface"
          onPointerDown={(event) => {
            if ((event.target as Element).closest('g[role="button"]')) return;
            setDrag({ x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y });
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!drag) return;
            setPan({ x: drag.panX + event.clientX - drag.x, y: drag.panY + event.clientY - drag.y });
          }}
          onPointerUp={() => setDrag(undefined)}
          onPointerCancel={() => setDrag(undefined)}
          onLostPointerCapture={() => setDrag(undefined)}
        >
          {loading ? <p role="status" className="wr-ledger-state">Loading ledger</p> : failed ? (
            <p role="alert" className="wr-ledger-state">Ledger graph unavailable</p>
          ) : graph.nodes.length === 0 ? (
            <p role="status" className="wr-ledger-state">No ledger notes yet</p>
          ) : (
            <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`Read-only ledger graph for ${roomName || room}`}>
              <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
                {layout.links.map((link) => {
                  const source = link.source as LayoutNode;
                  const target = link.target as LayoutNode;
                  const sourceId = linkedNodeId(source);
                  const targetId = linkedNodeId(target);
                  if (!visible.has(sourceId) || !visible.has(targetId)) return null;
                  return <line key={`${sourceId}:${targetId}`} x1={source.x ?? 0} y1={source.y ?? 0} x2={target.x ?? 0} y2={target.y ?? 0} />;
                })}
                {layout.nodes.map((node) => visible.has(node.id) && (
                  <g
                    key={node.id}
                    data-testid={`ledger-node-${node.id}`}
                    className={node.id === selected ? 'is-selected' : ''}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open note ${displayName(node.name)}`}
                    transform={`translate(${node.x ?? 0} ${node.y ?? 0})`}
                    onClick={(event) => { event.stopPropagation(); selectNode(node.id, event.currentTarget); }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        selectNode(node.id, event.currentTarget);
                      }
                    }}
                  >
                    <circle r={node.id === selected ? 9 : 6} />
                    <text x={14} y={5}>{displayName(node.name)}</text>
                  </g>
                ))}
              </g>
            </svg>
          )}
          <div className="wr-ledger-legend" aria-label="Graph legend">
            <span><i /> Note</span>
            <span><i className="is-selected" /> Selected</span>
          </div>
        </div>
      </main>
      {overlayMode && inspectorOpen && (
        <button type="button" className="wr-ledger-inspector-scrim" aria-label="Dismiss note inspector" onClick={closeInspector} />
      )}
      <aside
        ref={inspector}
        data-testid="ledger-inspector"
        className={`wr-ledger-inspector ${inspectorOpen ? 'is-open' : ''}`}
        aria-label="Selected ledger note"
        role={overlayMode ? 'dialog' : undefined}
        aria-modal={overlayMode ? true : undefined}
      >
        <div className="wr-ledger-inspector-top">
          <div className="wr-ledger-readonly"><LockKeyhole aria-hidden="true" size={13} /> Read-only</div>
          <button ref={inspectorClose} type="button" className="wr-icon-button wr-ledger-inspector-close" aria-label="Close note inspector" onClick={closeInspector}>
            <X aria-hidden="true" size={17} />
          </button>
        </div>
        {selectedNode ? (
          <>
            <h1>{displayName(selectedNode.name)}</h1>
            <p>{roomName} / {selectedNode.relative_path}</p>
            <section>
              <h2>Backlinks <span>{backlinks.length}</span></h2>
              {backlinks.length === 0 ? <p>None</p> : backlinks.map((id) => <button key={id} type="button" onClick={() => selectNode(id)}>{displayName(id)}</button>)}
            </section>
            <section>
              <h2>Links <span>{links.length}</span></h2>
              {links.length === 0 ? <p>None</p> : links.map((id) => <button key={id} type="button" onClick={() => selectNode(id)}>{displayName(id)}</button>)}
            </section>
            <section className="wr-ledger-preview">
              <h2>Preview</h2>
              {noteFailed ? <p role="alert">Note unavailable</p> : note ? <pre>{note.body}</pre> : <p role="status">Loading note</p>}
            </section>
          </>
        ) : <p className="wr-ledger-state">Select a note</p>}
      </aside>
    </div>
  );
}
// harn:end graph-derived-from-vault-links-readonly
