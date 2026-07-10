# Business model

Open source that pays for itself by selling **convenience and capacity — never content, never
lock-in**. The prior art is proven: Tailscale sells a coordination plane that never sees your
packets; Obsidian sells Sync for a free local app; Bitwarden sells hosting for an open server.
Wireroom sells the blind plumbing around a private product.

## The rule that makes it work

Every hosted component is **content-blind** (handles ciphertext and minimal routing metadata
only) and **self-hostable** (the paid service runs the same open-source code you could run
yourself). The moat is polish, uptime, and zero-setup — not captivity. If a feature only works
because our server can read something, the feature is wrong.

## Division of labor: cloud vs. box

| | Wireroom Relay (ours, paid) | Switchboard (yours, free) |
| --- | --- | --- |
| **Does** | envelope routing (sealed deliveries between boxes/devices), push sending, rendezvous/NAT traversal, offline mailbox, browser gateway, hosted platform integrations | execution (harness sessions), the *semantic* router (mentions, refs, deliveries), storage (messages, run blobs), the ledger vault, keys |
| **Holds** | platform credentials that are ours to hold: APNs/FCM keys, Slack/Telegram app secrets, TURN certs, billing identity | everything with content: history, transcripts, ledger, room keys — and your harness auth (Claude/Codex credentials never leave the box; we never proxy model traffic) |
| **Sees** | ciphertext + the metadata table below | plaintext (it's your machine) |

The one subtlety that makes the privacy promise hold: **routing means two different things.**
Parsing `@codex`, resolving `#refs`, attaching ledger notes — that requires plaintext, so it
happens at the sending switchboard, which legitimately has it. What the cloud routes is the
*output* of that: sealed envelopes addressed to opaque device/box ids. The relay is a mail
sorter that cannot open the mail.

## The hosted service: Wireroom Relay

One subscription, five capabilities — the first four content-blind, all of them open-source
code operated by us:

1. **Push gateway.** Sealed-payload APNs/FCM forwarding (PRIVACY §tier 2). This one is
   *structurally* hosted for most users: push for the App Store build of the iOS/watch app can
   only be signed with the publisher's APNs key, so anyone not compiling the app from source
   needs this gateway. Real ongoing cost, real fair thing to charge for.
2. **Rendezvous & NAT relay.** A TURN-style ciphertext pipe for when tailnet and DHT
   hole-punching can't connect two parties (hotel wifi, corporate networks, browser clients).
   Encrypted end-to-end; the relay patches wires it cannot listen to.
3. **Encrypted mailbox.** Store-and-forward of sealed payloads with TTL, so an offline device
   catches up without the home switchboard retransmitting. (Deferred from the free v1 core —
   returns here, ciphertext-only.)
4. **Browser gateway.** Reach your room from any browser at a stable URL: the gateway relays an
   E2E-encrypted WebSocket between browser and home switchboard, and decryption happens
   in-page — keys arrive via pairing/URL fragment and never touch the server. Partyline's
   "permanent web home," minus the readable copy. (On your own tailnet you don't need this:
   `tailscale serve` / an app connector reaches the switchboard directly.)
5. **Hosted integrations.** Bridges need public endpoints and platform app credentials — a
   Slack app, a Telegram bot, OAuth flows. We run them so users don't have to. The honest
   asterisk: a bridge handles bridged-room content in plaintext by definition (that's what
   bridging *is* — PRIVACY §bridged rooms), so a hosted bridge extends the same disclosed,
   per-room, owner-opted exception to our infrastructure. Self-hosting the bridge with your own
   bot tokens remains fully supported for those who want the integration without us in it.

### What the relay sees (and is paid to see)

| Sees | Never sees |
| --- | --- |
| device push tokens | message bodies |
| connection timing and volume | member names / handles |
| opaque room + org ids | run events, code, diffs |
| device/org public keys | ledger notes |

This table is the sales page, verbatim. The relay code stays open source so the claim is
auditable, and a self-hosted relay is always a supported configuration.

## Tiers

- **Free (self-host):** the entire core, forever — switchboard, adapters, web, CLI, skill, P2P,
  E2EE, ledger, bridges. MIT. Run your own relay if you want push/mailbox. Nothing crippled.
- **Pro (individual):** Wireroom Relay bundle — push, rendezvous, mailbox, browser gateway —
  plus the App Store apps at no extra charge. Order of $5–10/mo; it replaces "run a VPS +
  manage APNs keys."
- **Team:** per-seat. Relay capacity for the org, metadata-only admin dashboard (uptime, usage,
  device inventory — no content), SSO/IdP bridging for enrollment (identity is not content),
  priority support.
- **Enterprise:** self-hosted relay with a commercial license + support contract, compliance
  documentation, security review access.

**Apps:** the iOS + Watch apps are the other natural revenue line — paid on the App Store (or
free with Relay subscription unlock), while the source stays in the repo so building your own
remains free. Paying for a signed, notarized, push-capable binary is a convenience purchase,
consistent with the rule.

## What we will not sell

- Plaintext anything, ever, at any tier. No "compliance archive" of message content, no
  server-side search, no analytics on bodies.
- Features deliberately withheld from self-hosters to force the subscription. The delta is
  operations, not capability.
- Attention: no ads, no telemetry beyond opt-in crash reports.

## Sequencing

Monetization work starts **after** M5's open-source launch — credibility first. The relay is
built in M4 regardless (push needs it); turning it into a billed service is mostly accounts-
for-billing (billing identity is the one place an email exists, and it maps to keys, not to
content), quotas, and a sales page that is mostly the table above.
