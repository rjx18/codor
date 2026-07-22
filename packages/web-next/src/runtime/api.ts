import type {
  AdapterCapabilities,
  CreateRoomRequest,
  Member,
  Message,
  ProducedArtifact,
  ProducedArtifactError,
  Room,
  WireEvent,
} from '@codor/protocol';

import { openForBrowser, persistBrowserRoomKey } from './crypto.js';

export interface ApiOptions {
  token: string;
  origin?: string;
}

// harn:assume agent-selection-shows-detected-acp-and-advanced-custom ref=acp-provider-catalog-client
export interface AdapterRegistration {
  /** Selector id: a native adapter id, `acp:<provider>` for a named provider, or `acp`. */
  id: string;
  /** Runtime harness id; named provider and generic ACP entries run on `acp`. */
  harness?: string;
  /** Human label for named provider entries. */
  label?: string;
  /** Daemon-host installation state. Omitted only by older compatible servers. */
  installed?: boolean;
  /** Generic transports that need per-agent provider configuration (the custom ACP tile). */
  configurable?: boolean;
  /** Present on ACP entries — named providers and the generic custom tile. */
  transport?: 'acp';
  /** True only for the generic custom ACP tile — the sole Advanced-disclosure entry. */
  advanced?: boolean;
  /** Safe curated provider id for named entries; the API never sends its executable or argv. */
  acp_provider?: string;
  /** Documentation link surfaced beside a named provider tile. */
  help_url?: string;
  /** A currently-installed native adapter that shadows this named provider from primary selection. */
  shadowed_by_native?: string;
  capabilities: AdapterCapabilities;
  /** Models the harness itself reported. The web never hardcodes a model id. */
  models?: string[];
  models_source?: 'discovered' | 'curated';
}
// harn:end agent-selection-shows-detected-acp-and-advanced-custom

export interface MemberDetail {
  member: Member;
  queued_count: number;
  spend: {
    turns: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    estimated_cost_usd?: number;
    uncosted_tokens?: number;
  };
}

export interface MessageHistoryPage {
  messages: Message[];
  has_more: boolean;
}

export interface LocalDirectoryListing {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
}

export interface LedgerNote {
  name: string;
  body: string;
  content: string;
  relative_path: string;
  type?: 'decision' | 'constraint' | 'contract';
}

export interface LedgerGraphNode {
  id: string;
  name: string;
  type?: 'decision' | 'constraint' | 'contract';
  relative_path: string;
}

export interface LedgerGraphEdge {
  source: string;
  target: string;
}

export interface LedgerGraph {
  nodes: LedgerGraphNode[];
  edges: LedgerGraphEdge[];
}

export interface DeviceSummary {
  device_id: string;
  label?: string;
  paired_at: string;
  push_enabled: boolean;
}

export interface PushConfig {
  enabled: boolean;
  vapid_public_key?: string;
}

export interface PairingOffer {
  endpoint: string;
  pairing_token: string;
  pairing_code: string;
  expires_at: string;
  switchboard_sign_pub: string;
}

// harn:assume starting-agent-name-derives-one-valid-identity-v6 ref=actionable-rest-errors
async function requestError(response: Response): Promise<Error> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim() !== '') return new Error(body.error);
  } catch {
    // The status fallback remains useful for non-JSON proxies and older servers.
  }
  return new Error(`request failed: ${String(response.status)}`);
}
// harn:end starting-agent-name-derives-one-valid-identity-v6

async function fetchJson<T>(path: string, options: ApiOptions): Promise<T> {
  const origin = options.origin ?? window.location.origin;
  const res = await fetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${options.token}` },
  });
  if (!res.ok) throw await requestError(res);
  return (await res.json()) as T;
}

async function sendJson<T>(
  path: string,
  method: 'POST' | 'DELETE',
  body: unknown,
  options: ApiOptions,
): Promise<T> {
  const origin = options.origin ?? window.location.origin;
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${options.token}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw await requestError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// harn:assume model-catalogs-reach-a-browser-that-arrives-early ref=adapter-catalog-client-refresh
export interface AdapterListing {
  adapters: AdapterRegistration[];
  /** A harness that can report its models still hasn't. Ask again. */
  discovering: boolean;
}

export async function fetchAdapters(options: ApiOptions): Promise<AdapterListing> {
  const body = await fetchJson<{
    adapters: AdapterRegistration[];
    discovering?: boolean;
  }>('/api/adapters', options);
  return { adapters: body.adapters, discovering: body.discovering === true };
}

// harn:assume adapter-refresh-is-authorized-and-incremental ref=adapter-refresh-client
export async function refreshAdapters(options: ApiOptions): Promise<AdapterListing> {
  return sendJson<AdapterListing>('/api/adapters/refresh', 'POST', undefined, options);
}
// harn:end adapter-refresh-is-authorized-and-incremental

export type UsageRefreshOutcome = 'refreshed' | 'cooldown' | 'coalesced' | 'failed';

/** Trigger the daemon's account-usage probe. Updated gauges arrive as member
 *  frames; the response reports a distinguishable outcome (a provider failure is
 *  `failed`, not a silent success). Never returns credentials. */
export async function refreshUsage(options: ApiOptions): Promise<{ outcome: UsageRefreshOutcome }> {
  return sendJson<{ outcome: UsageRefreshOutcome }>('/api/usage/refresh', 'POST', undefined, options);
}
// harn:end model-catalogs-reach-a-browser-that-arrives-early

export async function fetchRooms(options: ApiOptions): Promise<Room[]> {
  const body = await fetchJson<{ rooms: Room[] }>('/api/rooms', options);
  return body.rooms;
}

// harn:assume web-room-rail-creates-owner-room ref=authenticated-room-create-client
// harn:assume channel-accent-projects-accessibly-across-themes ref=authoritative-channel-client
export async function createRoom(
  input: CreateRoomRequest,
  options: ApiOptions,
): Promise<Room> {
  const created = await sendJson<{
    room: Room;
    room_key?: { room: string; generation: number; sealed_key: string };
  }>('/api/rooms', 'POST', input, options);
  if (created.room_key !== undefined) {
    if (created.room_key.room !== created.room.id) {
      throw new Error('created channel key does not match the created channel');
    }
    const roomKey = await openForBrowser(created.room_key.sealed_key);
    await persistBrowserRoomKey(
      created.room_key.room,
      created.room_key.generation,
      roomKey,
    );
  }
  return created.room;
}
// harn:end channel-accent-projects-accessibly-across-themes
// harn:end web-room-rail-creates-owner-room

export async function fetchLocalDirectories(
  path: string | undefined,
  hidden: boolean,
  options: ApiOptions,
): Promise<LocalDirectoryListing> {
  const query = new URLSearchParams();
  if (path !== undefined) query.set('path', path);
  if (hidden) query.set('hidden', '1');
  const suffix = query.size === 0 ? '' : `?${query.toString()}`;
  return fetchJson<LocalDirectoryListing>(`/api/local/dirs${suffix}`, options);
}

export async function fetchDevices(options: ApiOptions): Promise<DeviceSummary[]> {
  return (await fetchJson<{ devices: DeviceSummary[] }>('/api/devices', options)).devices;
}

// harn:assume pairing-code-enrollment-surfaces ref=pairing-code-client-api
export async function mintPairingOffer(
  endpoint: string,
  options: ApiOptions,
): Promise<PairingOffer> {
  return sendJson<PairingOffer>('/api/pairing/offers', 'POST', { endpoint }, options);
}
// harn:end pairing-code-enrollment-surfaces

export async function fetchPushConfig(options: ApiOptions): Promise<PushConfig> {
  return fetchJson<PushConfig>('/api/push/config', options);
}

export async function registerPushSubscription(
  deviceId: string,
  subscription: PushSubscriptionJSON,
  options: ApiOptions,
): Promise<void> {
  await sendJson(
    `/api/devices/${encodeURIComponent(deviceId)}/push-subscription`,
    'POST',
    { subscription },
    options,
  );
}

export async function revokeDevice(deviceId: string, options: ApiOptions): Promise<void> {
  await sendJson(`/api/devices/${encodeURIComponent(deviceId)}`, 'DELETE', undefined, options);
}

export async function fetchMemberDetails(
  room: string,
  options: ApiOptions,
): Promise<MemberDetail[]> {
  const body = await fetchJson<{ members: MemberDetail[] }>(
    `/api/rooms/${encodeURIComponent(room)}/members`,
    options,
  );
  return body.members;
}

export async function fetchMessageHistory(
  room: string,
  page: { before?: number; limit?: number },
  options: ApiOptions,
): Promise<MessageHistoryPage> {
  const query = new URLSearchParams();
  if (page.before !== undefined) query.set('before', String(page.before));
  if (page.limit !== undefined) query.set('limit', String(page.limit));
  return fetchJson<MessageHistoryPage>(
    `/api/rooms/${encodeURIComponent(room)}/messages?${query.toString()}`,
    options,
  );
}

export async function searchMessages(
  room: string,
  query: string,
  options: ApiOptions,
): Promise<Message[]> {
  const params = new URLSearchParams({ q: query });
  const body = await fetchJson<{ messages: Message[] }>(
    `/api/rooms/${encodeURIComponent(room)}/search?${params.toString()}`,
    options,
  );
  return body.messages;
}

/** Run event blobs are ONLY fetched through the server's redacted endpoint. */
export async function fetchRunEvents(
  room: string,
  msgId: number,
  options: ApiOptions,
): Promise<WireEvent[]> {
  const body = await fetchJson<{ events: WireEvent[] }>(
    `/api/rooms/${encodeURIComponent(room)}/runs/${msgId}`,
    options,
  );
  return body.events;
}

export interface ArtifactFeed {
  artifacts: ProducedArtifact[];
  /** One path-free failure state per run whose snapshot could not be stored. */
  errors: ProducedArtifactError[];
}

/** Durable produced-artifact feed for a room. Bytes are fetched separately
 *  through {@link artifactUrl}; this returns only opaque metadata (never a path)
 *  plus any per-run storage-failure states. */
export async function fetchArtifacts(
  room: string,
  options: ApiOptions,
): Promise<ArtifactFeed> {
  const body = await fetchJson<{ artifacts: ProducedArtifact[]; errors?: ProducedArtifactError[] }>(
    `/api/rooms/${encodeURIComponent(room)}/artifacts`,
    options,
  );
  return { artifacts: body.artifacts, errors: body.errors ?? [] };
}

/** Served URL for a produced artifact. The token rides the query string because
 *  an <img>/<a> cannot send an Authorization header (the server accepts either).
 *  The server renders raster media inline and everything else as an inert
 *  nosniff download, so this URL is safe to hand an <img> or download <a>. */
export const artifactUrl = (room: string, id: string, token: string): string =>
  `/api/rooms/${encodeURIComponent(room)}/artifacts/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;

export async function fetchLedgerNote(
  room: string,
  name: string,
  options: ApiOptions,
): Promise<LedgerNote> {
  const body = await fetchJson<{ note: LedgerNote }>(
    `/api/rooms/${encodeURIComponent(room)}/ledger/${encodeURIComponent(name)}`,
    options,
  );
  return body.note;
}

export async function fetchLedgerGraph(
  room: string,
  options: ApiOptions,
): Promise<LedgerGraph> {
  const body = await fetchJson<{ graph: LedgerGraph }>(
    `/api/rooms/${encodeURIComponent(room)}/ledger`,
    options,
  );
  return body.graph;
}
