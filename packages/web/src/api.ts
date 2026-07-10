import type { WireEvent } from '@wireroom/protocol';

export interface ApiOptions {
  token: string;
  origin?: string;
}

/** Run event blobs are ONLY fetched through the server's redacted endpoint. */
export async function fetchRunEvents(
  room: string,
  msgId: number,
  options: ApiOptions,
): Promise<WireEvent[]> {
  const origin = options.origin ?? window.location.origin;
  const res = await fetch(`${origin}/api/rooms/${encodeURIComponent(room)}/runs/${msgId}`, {
    headers: { authorization: `Bearer ${options.token}` },
  });
  if (!res.ok) throw new Error(`blob fetch failed: ${res.status}`);
  const body = (await res.json()) as { events: WireEvent[] };
  return body.events;
}
