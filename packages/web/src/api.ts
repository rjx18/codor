import type { AdapterCapabilities, Member, WireEvent } from '@wireroom/protocol';

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
  };
}

async function fetchJson<T>(path: string, options: ApiOptions): Promise<T> {
  const origin = options.origin ?? window.location.origin;
  const res = await fetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${options.token}` },
  });
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchAdapters(options: ApiOptions): Promise<AdapterRegistration[]> {
  const body = await fetchJson<{ adapters: AdapterRegistration[] }>('/api/adapters', options);
  return body.adapters;
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
