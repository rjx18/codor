import type { AdapterCapabilities, Member, Message, Room, WireEvent } from '@wireroom/protocol';

export interface ApiOptions {
  token: string;
  origin?: string;
}

export interface AdapterRegistration {
  id: string;
  capabilities: AdapterCapabilities;
}

export interface MemberDetail {
  member: Member;
  queued_count: number;
  spend: {
    turns: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    uncosted_tokens?: number;
  };
}

export interface MessageHistoryPage {
  messages: Message[];
  has_more: boolean;
}

export interface LedgerNote {
  name: string;
  body: string;
  content: string;
  relative_path: string;
  type?: 'decision' | 'constraint' | 'contract';
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

async function fetchJson<T>(path: string, options: ApiOptions): Promise<T> {
  const origin = options.origin ?? window.location.origin;
  const res = await fetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${options.token}` },
  });
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
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
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function fetchAdapters(options: ApiOptions): Promise<AdapterRegistration[]> {
  const body = await fetchJson<{ adapters: AdapterRegistration[] }>('/api/adapters', options);
  return body.adapters;
}

export async function fetchRooms(options: ApiOptions): Promise<Room[]> {
  const body = await fetchJson<{ rooms: Room[] }>('/api/rooms', options);
  return body.rooms;
}

export async function fetchDevices(options: ApiOptions): Promise<DeviceSummary[]> {
  return (await fetchJson<{ devices: DeviceSummary[] }>('/api/devices', options)).devices;
}

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
