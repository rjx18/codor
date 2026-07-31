/// <reference types="@cloudflare/vitest-pool-workers" />
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('relay worker router', () => {
  it('serves /healthz with 200 "ok"', async () => {
    const res = await SELF.fetch('https://relay.example/healthz');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('returns 404 for unknown paths', async () => {
    const res = await SELF.fetch('https://relay.example/nope');
    expect(res.status).toBe(404);
  });

  it('returns 404 for a wrong method on /healthz', async () => {
    const res = await SELF.fetch('https://relay.example/healthz', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('rejects a pairing WS upgrade with a missing/invalid role (400)', async () => {
    const res = await SELF.fetch('https://relay.example/v1/pair/7Q/ws');
    expect(res.status).toBe(400);
  });

  it('rejects a malformed session id (400)', async () => {
    const res = await SELF.fetch('https://relay.example/v1/session/abc/ws?role=client');
    expect(res.status).toBe(400); // not 64 lowercase hex
  });
});
