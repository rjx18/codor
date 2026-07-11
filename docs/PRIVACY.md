# Privacy

The constraint that outranks features: **message content never exists in plaintext on
infrastructure you don't control.** Channels carry your source code, your strategies, your secrets'
shadows — treat every channel like a production credential.

## Where do messages live? (the question to get right)

**There is no server.** Messages are stored exactly once, in SQLite on the machine where the
switchboard runs — *your* machine, the same one that already holds every agent's full transcript
in plaintext under `~/.claude/projects` and `~/.codex/sessions`. Channel history adds no new trust:
it lives beside data of identical sensitivity, on disk you own, protected the same way — by
your OS's full-disk encryption.
Storing it locally is what makes `#N` references, history, and restart-resume possible. Phones,
watches, and browsers hold only caches (wiped on unpair); the push relay holds nothing at rest;
no cloud ever holds content, encrypted or not.

## Principles

1. **Local-first.** The switchboard on your machine is the sole source of truth. Delete the
   machine, the data is gone — that's correct behavior.
2. **Every remote component is optional *and* self-hostable.** The tool is fully functional with
   zero cloud parts. Each tier below is opt-in and additive.
3. **No accounts.** Identity is a device keypair created at pairing. There is nothing to sign up
   for, so there is nothing to subpoena, breach, or sunset.
4. **E2EE is not a tier — plaintext-off-box is.** Anything that leaves machines you own is
   encrypted to device keys, full stop. The tiers only change *routing*.
5. **Metadata is minimized where we control it** (random channel ids, no directory, padded pushes),
   and honestly documented where we don't (APNs sees timing/volume; the DHT sees topic
   announcements).

## Topology tiers

### Tier 0 — tailnet only (recommended default)

Switchboard binds its Tailscale IP; web/iPhone connect over WireGuard (`tailscale serve` gives
HTTPS + certs for free; a Tailscale app connector adds custom-domain access with ACL grants for
teams). No Codor-related traffic leaves the tailnet; transport encryption is WireGuard's. **Zero third-party infrastructure.** Limits: watch has no tailnet of its own (phone
relays via WatchConnectivity), and no push when the phone app is cold (see §push).

### Tier 1 — serverless P2P (the walkie tier)

For agents/switchboards on machines that can't share a tailnet: `hyperswarm`. A line's
`name:secret` hashes to a DHT topic; peers holding the secret discover each other and connect
**directly** over Noise-encrypted streams (NAT-holepunched). No server, no relay, no stored
ciphertext — the DHT sees only opaque topic hashes and IP-level metadata. This is walkie's
proven model, reused wholesale. Used for switchboard↔switchboard peering and any client that can
run the stack.

### Tier 2 — push relay (the only "cloud", and you can host it)

Apple push requires APNs — there is no self-hosted path to a cold iPhone/Watch. The relay is a
~200-line stateless service (pattern: Matrix's sygnal) that accepts an **already-encrypted**
payload from your switchboard and forwards it to APNs. On device, a Notification Service
Extension decrypts with a local channel key and renders. What each party sees:

| Party | Sees |
| --- | --- |
| Push relay (yours or community) | ciphertext, device push token, timing |
| Apple (APNs) | ciphertext, bundle id, device token, timing/volume |
| Neither | sender, channel name, message content, member names |

Payloads are padded to fixed size buckets. Nothing is stored: the relay holds messages in memory
only for the APNs round-trip. Self-hosting requires your own Apple developer key — documented
and supported. The hosted version of this same code is the commercial service (BUSINESS.md);
it is bit-for-bit the same open-source relay and still sees only the table row above. Offline mailbox (store-and-forward ciphertext with TTL) is
explicitly **out** of v1 — the switchboard is always-on by nature; push is a doorbell, and the
device fetches content over tier 0/1 when opened.

## Keys and pairing

- **Device keys:** every device generates an **Ed25519 signing pair** (the device identity —
  X25519 alone cannot sign) plus an X25519 encryption pair, bound together at pairing. Private
  keys live in Secure Enclave/Keychain (Apple) or the OS keystore. **Browsers, honestly: one
  crypto suite, libsodium everywhere** — `sodium-native` on Node, `libsodium-wrappers` in the
  page and service worker, keys in IndexedDB scoped by the origin sandbox. (Non-extractable
  WebCrypto keys cannot open libsodium sealed boxes, and inventing a second envelope format
  around `deriveBits` would mean hand-rolling crypto — rejected.) The IndexedDB caveat is
  documented; unpairing a browser purges IndexedDB, CacheStorage, localStorage, and any push
  subscription.
- **Connection auth:** peers and devices authenticate with a nonce-challenge signed by the
  Ed25519 identity (replay-bound to the session transcript) — possession of a channel key alone
  is never treated as identity. A paired browser signs a fresh, single-use switchboard challenge
  on each cold start and receives only a bounded in-memory device session; pairing never discloses
  the configured operator bearer. Restarting the switchboard invalidates those page sessions and
  the browser signs in again from its origin-scoped identity.
- **Pairing:** the web/switchboard shows a QR (switchboard endpoint + ephemeral pairing token +
  switchboard pubkey); the device scans, exchanges pubkeys over the resulting channel, done.
  Same UX as Paseo/claude-watch pairing, plus the key exchange.
- **Channel keys:** each line has a symmetric key, generated by the owning switchboard and sealed
  (libsodium `crypto_box_seal`) to each authorized device pubkey. Rotation on member-device
  revocation. v1 fan-out is sealed-box per device (channels have ~2–5 devices — MLS is
  over-engineering at this scale; revisit via OpenMLS only if team channels grow).
- **Revocation:** remove a device → invalidate its browser sessions and close its live sockets →
  rotate channel keys → old device can neither fetch current plaintext nor decrypt anything new. One
  command, documented, tested.
- **Crypto is never hand-rolled:** libsodium + hyperswarm's Noise. We write key *management*,
  not primitives.

## What is stored where

| Location | Data | Protection |
| --- | --- | --- |
| Switchboard host | full plaintext history (SQLite + run JSONL + ledger vault) | your disk + OS full-disk encryption (the supported at-rest story; app-level DB encryption is deferred — it would cover only the DB, not blobs/ledger, and mislead); filesystem perms |
| iPhone/Watch | decrypted cache of recent messages | OS sandbox + device encryption; wipe on unpair |
| Browser (web) | identity, sealed channel keys, and pairing marker in origin-scoped IndexedDB; current channel state and device access session in page memory; an operator bearer is stored only when explicitly supplied | origin sandbox; all Codor IndexedDB, CacheStorage, localStorage, service workers, and push state cleared on unpair |
| Push relay | nothing at rest | memory-only forwarding |
| DHT (tier 1) | topic hashes, peer IPs | inherent to P2P; documented |
| APNs | ciphertext in transit | E2EE payload, padded |

## Bridged channels: the one deliberate exception

A bridge (ARCHITECTURE §bridges) mirrors a channel into Slack/Telegram — which means that channel's
content flows to that platform's servers in whatever form the platform stores it. This is the
only path by which content legitimately leaves your machines readable, it exists only as an
explicit owner/admin opt-in per channel, and the channel wears a permanent "bridged" banner on every
surface. Everything in this document above applies to unbridged channels; nothing about a bridged
channel's exported copy is within our control. Don't bridge channels that discuss things Slack
shouldn't hold.

## Voice

Watch/phone dictation uses Apple speech recognition. Setting `voice: on-device only` (default)
restricts to `SFSpeechRecognizer.supportsOnDeviceRecognition` paths — audio never leaves the
device; where on-device isn't available the mic button says so rather than silently uploading.
The **web/PWA surface has no dictation feature**: browser speech APIs cannot guarantee
on-device processing, so voice is native-app-only rather than silently cloud-processed.

## Secrets hygiene inside channels

Agents echo environment details, file paths, occasionally token-shaped strings. Two mitigations,
both switchboard-side (before fan-out to surfaces/push): a redaction filter (regexes for common
credential shapes, opt-out per channel) and a hard rule inherited from our own ops practice —
harness prompts in skills/docs instruct agents to report secret *presence/length*, never values.
Defense in depth; the real boundary remains: channels are as sensitive as the code they discuss.

## Threat model

**Defended:**

- Cloud/network snooping — nothing readable leaves your machines (tier 0/1); tier 2 carries
  sealed, padded payloads.
- Push relay or APNs compromise — yields ciphertext + tokens + timing, no content, no names.
- Stolen paired device — device unlock guards the key; revocation rotates channel keys.
- Curious DHT observer — sees that *some* topic has peers; secrets make topics unguessable.
- A malicious *message* (prompt injection via channel content) — mitigated structurally: agents
  only ever receive messages they were explicitly addressed in (+ refs), never ambient channel scroll; opt-in brakes
  and the always-on spend meter bound and expose runaway chains; approvals/policy chips bound what a hijacked session can do.

**Not defended (declared honestly):**

- A compromised switchboard host — the agents run *there* with full permissions; Codor adds
  no attack surface an attacker on that box doesn't already own. Host security is out of scope.
- A malicious harness/adapter — adapters run in-process with the switchboard by design.
- Traffic analysis at the ISP/DHT level (tier 1) and timing/volume at APNs (tier 2).
- Members of the channel — anyone (human or agent) in a line reads the line. Don't invite what you
  don't trust; there are no per-message ACLs.
