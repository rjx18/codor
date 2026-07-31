import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RelayStore } from '@codor/switchboard';

import { runCli, startCodor } from './index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pair-univ-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const listen = (server: ReturnType<typeof createServer>): Promise<number> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
const close = (server: ReturnType<typeof createServer>): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

describe('universal mint through the real CLI composition', () => {
  it('threads the caller endpoint through startCodor so a relay-enabled offer keeps the switchboard origin', async () => {
    // Mock relay: only the room-reservation REST call matters; the WS dial that
    // follows fails harmlessly (the session shuts itself down on close).
    let reserved = false;
    const relay = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/pair/rooms') {
        reserved = true;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ nameplate: 'AA' }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    const relayPort = await listen(relay);

    // Pre-enable the relay in the data dir so the REAL startCodor composition
    // takes the universal path and points at the mock reserve server.
    new RelayStore(dir).enable(`ws://127.0.0.1:${relayPort}`);

    const codor = await startCodor({ token: 't', dataDir: dir, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${codor.server.port}`;
    try {
      const res = await fetch(`${base}/api/pairing/offers`, {
        method: 'POST',
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: base }),
      });
      expect(res.status).toBe(200);
      const offer = (await res.json()) as { endpoint: string; doors: string };
      expect(reserved).toBe(true); // the real relay mint ran through up.ts
      expect(offer.doors).toBe('both');
      // The F1 fix: up.ts's pair closure forwards the endpoint, so the offer's
      // endpoint (and thus Settings' QR/link and the browser's ?endpoint=) is the
      // switchboard origin — NOT the relay URL.
      expect(offer.endpoint).toBe(base);
      expect(new URL('/pair', offer.endpoint).origin).toBe(base);
    } finally {
      await codor.close();
      await close(relay);
    }
  });
});

describe('codor relay pair honesty + codor pair delegation', () => {
  it('labels a degraded (local-only) relay pair code honestly', async () => {
    const httpd = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/relay/pair') {
        res.end(JSON.stringify({ code: 'AB23-CD45', expires_at: 'soon', doors: 'local' }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    const port = await listen(httpd);
    const out: string[] = [];
    try {
      await runCli(
        ['node', 'codor', '--url', `http://127.0.0.1:${port}`, '--token', 't', 'relay', 'pair'],
        { stdout: (line) => out.push(line) },
      );
      const line = out.join('\n');
      expect(line).toContain('local-only pairing code');
      expect(line).toContain('AB23-CD45');
      expect(line).not.toMatch(/^pairing code /m); // not mislabeled as a full tunnel code
    } finally {
      await close(httpd);
    }
  });

  it('delegates codor pair to the daemon universal mint when the relay is enabled', async () => {
    const canned = {
      endpoint: 'https://sw.test',
      pairing_token: 'tok',
      pairing_code: 'AB23-CD45',
      expires_at: 'later',
      switchboard_sign_pub: 'sp',
      doors: 'both',
    };
    let offersHit = false;
    const httpd = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/api/relay/status')) return void res.end(JSON.stringify({ enabled: true }));
      if (req.url?.startsWith('/api/pairing/offers')) {
        offersHit = true;
        return void res.end(JSON.stringify(canned));
      }
      res.statusCode = 404;
      res.end('{}');
    });
    const port = await listen(httpd);
    const out: string[] = [];
    try {
      await runCli(
        ['node', 'codor', '--data-dir', dir, '--url', `http://127.0.0.1:${port}`, '--token', 't', 'pair', '--no-qr'],
        { stdout: (line) => out.push(line) },
      );
      expect(offersHit).toBe(true); // routed through the daemon, not in-process issue()
      expect(out).toContain('code: AB23-CD45');
      expect(out.some((line) => line.startsWith('https://sw.test/pair'))).toBe(true);
    } finally {
      await close(httpd);
    }
  });

  it('sends a JSON body with codor relay pair (fastify 400s a bodyless JSON POST)', async () => {
    let body: string | undefined;
    const httpd = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/relay/pair') {
        let chunks = '';
        req.on('data', (chunk: Buffer) => { chunks += chunk.toString(); });
        req.on('end', () => {
          body = chunks;
          res.end(JSON.stringify({ code: 'AB23-CD45', expires_at: 'soon', doors: 'both' }));
        });
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    const port = await listen(httpd);
    const out: string[] = [];
    try {
      await runCli(
        ['node', 'codor', '--url', `http://127.0.0.1:${port}`, '--token', 't', 'relay', 'pair'],
        { stdout: (line) => out.push(line) },
      );
      // The empty string is exactly what fastify rejects with 400 Bad Request.
      expect(body).toBeDefined();
      expect(body!.length).toBeGreaterThan(0);
      expect(() => JSON.parse(body!)).not.toThrow();
      expect(out.join('\n')).toContain('AB23-CD45');
    } finally {
      await close(httpd);
    }
  });

  it('renders the setup pairing card on a TTY with the doors it opens', async () => {
    const canned = {
      endpoint: 'https://sw.test',
      pairing_token: 'tok',
      pairing_code: 'AB23-CD45',
      expires_at: 'later',
      switchboard_sign_pub: 'sp',
      doors: 'both',
    };
    const httpd = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/api/relay/status')) return void res.end(JSON.stringify({ enabled: true }));
      if (req.url?.startsWith('/api/pairing/offers')) return void res.end(JSON.stringify(canned));
      res.statusCode = 404;
      res.end('{}');
    });
    const port = await listen(httpd);
    const out: string[] = [];
    try {
      await runCli(
        ['node', 'codor', '--data-dir', dir, '--url', `http://127.0.0.1:${port}`, '--token', 't', 'pair', '--no-qr'],
        { stdout: (line) => out.push(line), isTTY: true },
      );
      const rendered = out.join('\n');
      expect(rendered).toContain('╭'); // the setup card's border
      expect(rendered).toContain('AB23-CD45');
      expect(rendered).toContain('This code works at codor.app and on your network.');
      expect(rendered).not.toContain('code: AB23-CD45'); // card replaces the plain lines
    } finally {
      await close(httpd);
    }
  });
});

describe('F4: token resolution for installed deployments', () => {
  const seededHome = (token?: string): string => {
    const home = mkdtempSync(join(tmpdir(), 'op-home-'));
    if (token !== undefined) {
      mkdirSync(join(home, '.config', 'codor'), { recursive: true });
      writeFileSync(join(home, '.config', 'codor', 'token'), `${token}\n`, { mode: 0o600 });
    }
    return home;
  };

  it('reads the installed token file to delegate when the shell has no token (env-empty + file-present)', async () => {
    const canned = {
      endpoint: 'https://sw.test',
      pairing_token: 'tok',
      pairing_code: 'AB23-CD45',
      expires_at: 'later',
      switchboard_sign_pub: 'sp',
      doors: 'both',
    };
    let authSeen: string | undefined;
    let offersHit = false;
    const httpd = createServer((req, res) => {
      authSeen = req.headers.authorization;
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/api/relay/status')) return void res.end(JSON.stringify({ enabled: true }));
      if (req.url?.startsWith('/api/pairing/offers')) {
        offersHit = true;
        return void res.end(JSON.stringify(canned));
      }
      res.statusCode = 404;
      res.end('{}');
    });
    const port = await listen(httpd);
    const home = seededHome('file-token');
    const out: string[] = [];
    try {
      await runCli(
        ['node', 'codor', '--data-dir', dir, '--url', `http://127.0.0.1:${port}`, 'pair', '--no-qr'],
        { stdout: (line) => out.push(line), env: { HOME: home, PATH: process.env.PATH } },
      );
      expect(offersHit).toBe(true);
      expect(authSeen).toBe('Bearer file-token'); // token came from the installed file
      expect(out).toContain('code: AB23-CD45');
    } finally {
      await close(httpd);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('falls back to today\'s in-process local issue when neither shell nor token file has a token', async () => {
    const home = seededHome(); // no token file
    const out: string[] = [];
    try {
      // No token anywhere → the relay probe never fires (token check throws first)
      // → local in-process code, exactly as before F4.
      await runCli(
        ['node', 'codor', '--data-dir', dir, 'pair', '--no-qr'],
        { stdout: (line) => out.push(line), env: { HOME: home, PATH: process.env.PATH } },
      );
      expect(out.some((line) => line.startsWith('code: '))).toBe(true);
      expect(out.some((line) => line.includes('/pair?'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('prefers an explicit --token over the installed token file', async () => {
    let authSeen: string | undefined;
    const httpd = createServer((req, res) => {
      authSeen = req.headers.authorization;
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/api/relay/status')) return void res.end(JSON.stringify({ enabled: false }));
      res.statusCode = 404;
      res.end('{}');
    });
    const port = await listen(httpd);
    const home = seededHome('file-token');
    const out: string[] = [];
    try {
      await runCli(
        ['node', 'codor', '--data-dir', dir, '--url', `http://127.0.0.1:${port}`, '--token', 'explicit', 'pair', '--no-qr'],
        { stdout: (line) => out.push(line), env: { HOME: home, PATH: process.env.PATH } },
      );
      expect(authSeen).toBe('Bearer explicit'); // explicit --token beats the file
    } finally {
      await close(httpd);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('N3: never sends the installed token file to a remote --url', async () => {
    const home = seededHome('file-token');
    try {
      // Explicit remote --url + token file present + no --token/env: the file is a
      // LOCAL-service credential, so it must NOT be resolved — the command fails
      // tokenless rather than leaking the installed bearer to an arbitrary origin.
      await expect(
        runCli(['node', 'codor', '--url', 'https://elsewhere.example', 'relay', 'status'], {
          stdout: () => {},
          stderr: () => {},
          env: { HOME: home, PATH: process.env.PATH },
        }),
      ).rejects.toThrow(/token/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('S2: treats bracketed IPv6 loopback (http://[::1]) as local and resolves the token file', async () => {
    const home = seededHome('file-token');
    try {
      // [::1] is loopback → the file token IS resolved, so the command gets PAST the
      // token check and fails on the connection (port 1) — NOT with a token error.
      // (Without bracket-normalization, [::1] would look remote → tokenless.)
      let err: unknown;
      await runCli(['node', 'codor', '--url', 'http://[::1]:1', 'relay', 'status'], {
        stdout: () => {},
        stderr: () => {},
        env: { HOME: home, PATH: process.env.PATH },
      }).catch((error) => {
        err = error;
      });
      expect(err).toBeDefined();
      expect(String(err)).not.toMatch(/token/i); // token resolved (local) → connection error, not token-required
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('N2: relay-pair codes carry the daemon endpoint, not the relay URL', () => {
  it('mints an offer whose local-door endpoint is the switchboard origin', async () => {
    const relay = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/pair/rooms') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ nameplate: 'AA' }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    const relayPort = await listen(relay);
    new RelayStore(dir).enable(`ws://127.0.0.1:${relayPort}`);
    const codor = await startCodor({ token: 't', dataDir: dir, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${codor.server.port}`;
    try {
      const pairRes = await fetch(`${base}/api/relay/pair`, {
        method: 'POST',
        headers: { authorization: 'Bearer t' },
      });
      expect(pairRes.status).toBe(200);
      const { code, doors } = (await pairRes.json()) as { code: string; doors: string };
      expect(doors).toBe('both');
      // The same code exchanges at the LOCAL door and resolves to the DAEMON
      // origin — not the relay Worker URL — so the pairing page actually exists.
      const exRes = await fetch(`${base}/api/pairing/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      expect(exRes.status).toBe(200);
      const payload = (await exRes.json()) as { endpoint: string };
      expect(payload.endpoint).toBe(base);
      expect(payload.endpoint).not.toContain(String(relayPort)); // never the relay URL
    } finally {
      await codor.close();
      await close(relay);
    }
  });
});
