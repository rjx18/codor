# Wireroom Web Push relay

This service is a stateless, content-blind Web Push forwarder. Every request carries its full
`PushSubscription`; there is no subscription database, queue, mailbox, retry store, or message
crypto in the relay. It decodes the bounded `sealed` base64 field and passes those exact opaque
bytes to `web-push`. Sealing happens on the switchboard and decryption happens in the device
service worker.

## Configure

Set these environment variables:

| Variable | Meaning |
| --- | --- |
| `VAPID_SUBJECT` | A `mailto:` or HTTPS contact for the VAPID claim |
| `VAPID_PUBLIC_KEY` | URL-safe base64 VAPID public key |
| `VAPID_PRIVATE_KEY` | URL-safe base64 VAPID private key |
| `ALLOWED_SENDERS` | Comma-separated switchboard Ed25519 public keys |
| `OPEN_MODE` | Explicitly set `true` instead of an allowlist; strict in-memory rate limits apply |
| `HOST` | Listen address, default `0.0.0.0` |
| `PORT` | Listen port, default `8787` |
| `TRUST_PROXY` | Optional comma-separated proxy IPs/CIDRs allowed to supply the client address |

Startup fails closed unless `ALLOWED_SENDERS` is non-empty or `OPEN_MODE=true`. VAPID keys can be
generated once with `pnpm exec web-push generate-vapid-keys`; do not print or commit the private
key. Open mode is intended for controlled community deployments, not as the default.
When TLS terminates at a reverse proxy, set `TRUST_PROXY` to that proxy's exact address or
private CIDR. Do not use a universal trust value: trusting arbitrary forwarded addresses lets
callers evade the open-mode per-address limit. Without it, the direct socket address is used.

## Signed notify contract

`POST /notify` has JSON body:

```json
{
  "subscription": {
    "endpoint": "https://push-service.example/device-token",
    "expirationTime": null,
    "keys": { "p256dh": "...", "auth": "..." }
  },
  "sealed": "base64 ciphertext",
  "ttl": 45
}
```

It also requires `x-wireroom-sender`, `x-wireroom-timestamp` (Unix milliseconds), and
`x-wireroom-signature` headers. Sender and signature are URL-safe base64 Ed25519 values. The
signature input is the UTF-8 domain `wireroom-relay-notify-v1` plus a NUL byte, followed by the
compact JSON object exported by `canonicalNotifyBytes`: sender, timestamp, canonical
subscription (with `expirationTime` normalized to `null`), sealed string, and TTL. Timestamps
have a five-minute acceptance window.

A successful upstream send returns `202`. An expired browser subscription returns `410` with
`{"error":"subscription_expired"}` so the switchboard can remove it. The relay rejects malformed,
unauthorized, stale, or oversized requests before contacting the push service.

## Run and self-host

```bash
pnpm --filter @wireroom/relay build
node relay/dist/index.js
```

Build the container from the repository root so the pinned workspace lockfile is available:

```bash
docker build -f relay/Dockerfile -t wireroom-relay .
docker run --rm -p 8787:8787 --env-file /path/outside/the/repo/relay.env wireroom-relay
```

Terminate TLS at your reverse proxy and expose only `/health` and `/notify`. Restarting the
container loses no notification state because notification state is never held.
