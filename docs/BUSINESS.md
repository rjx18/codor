# Business model

Open source that pays for itself by selling **convenience and capacity — never content, never
lock-in**. The prior art is proven: Tailscale sells a coordination plane that never sees your
packets; Obsidian sells Sync for a free local app; Bitwarden sells hosting for an open server.
Wireroom sells the blind plumbing around a private product.

## The rule that makes it work

Every hosted component is **content-blind** (handles ciphertext and minimal routing metadata
only). The moat is polish, uptime, and zero-setup — not captivity. If a feature only works
because our server can read something, the feature is wrong.

**The free/paid boundary is architectural, not artificial — the API-key/DB test:**

- Runs purely on your box with no third-party credentials → **free, open source**. That's the
  full solo product: rooms, all harness adapters, routing, custody, extensions, the ledger,
  web/PWA over tailnet or P2P, E2EE.
- Needs platform API keys (APNs, a Slack app, a Telegram bot, SSO) or hosted state (mailbox,
  org directory, stable public endpoints) → **paid**: push, rendezvous relay, browser
  gateway, encrypted mailbox, bridges/integrations, multi-member orgs.

Nothing local is ever crippled to force the upgrade; the paid features are the ones that
*inherently* require someone to run a server — and that someone is us. The local web UI's
settings page shows exactly this list with a "connect to Wireroom Relay" pairing flow, which is
the entire upsell.

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

## Pricing (decided 2026-07-10)

Three pillars, deliberately simple:

1. **Everything self-hostable is open source.** Switchboard, adapters, web/PWA, CLI, skill,
   protocol, relay — MIT, nothing crippled, forever. The one deliberate exception: the native
   apps (next pillar). The free path to every capability exists without them — the open PWA is
   the free phone client.
2. **The iPhone + Apple Watch apps are closed-source and a one-time purchase** on the App
   Store. They are first-party clients of the open protocol — anyone can build a competing
   client from PROTOCOL.md; ours is the polished one you pay once for. They live in a private
   repo, not here. Basic sealed push pings are **included with the app purchase** (App Store
   builds can only receive push through our APNs key anyway, and doorbell pings cost us close
   to nothing — a hidden subscription behind a paid app would be a bait-and-switch).
3. **The hosted relay is one cheap flat plan, ~$5/month**, for people who don't want to
   maintain anything: rendezvous/NAT relay, encrypted mailbox, browser gateway, hosted
   bridges (Slack/Telegram), and multi-member org enrollment (device-key directory + cross-user
   routing — the role *schema* is in the open protocol, the org *service* is paid). It replaces
   "rent a VPS, run a TURN server, manage bot tokens."

Later, only if demand proves it (explicitly not launch scope): team seats beyond the flat plan
(org relay capacity, metadata-only admin dashboard, SSO enrollment) and enterprise
self-hosted-relay licensing with support.

### The paseo parallel

Paseo runs the same access triad — hosted E2EE relay ("Paseo can't read your traffic") /
direct LAN / bring-your-own tunnel (Tailscale, Cloudflare) — which validates the topology.
The difference is the business: paseo is sponsorware (GitHub Sponsors) with everything open
(AGPL); Wireroom keeps the self-hostable stack open (MIT) and charges for the two things with
real marginal cost and real convenience value — the closed native apps (one-time) and the
relay ($5/mo) — so the project doesn't depend on donations.

## What we will not sell

- Plaintext anything, ever, at any tier. No "compliance archive" of message content, no
  server-side search, no analytics on bodies.
- Local features deliberately withheld to force the subscription. The paid line is drawn by
  the API-key/DB test above — operations and credentials, not capability on your own box.
- Attention: no ads, no telemetry beyond opt-in crash reports.

## The SaaS control plane (relay business only)

The paid relay splits into a stateless **data plane** (the open-source envelope routers — no
accounts, no database) and a small **control plane** that exists only because money and orgs
do. Stack, pinned:

- **Platform: Supabase** (managed Postgres + GoTrue auth + storage in one). This is fine
  precisely because *only we* run the control plane — relay self-hosters run the accountless
  data plane and never touch it — and Supabase is itself open source with a real eject path
  (it's plain Postgres underneath).
- **Sign-in:** GitHub + Google OAuth and email magic links via Supabase Auth — no passwords.
  Enterprise SSO/SAML later, only if demand. The native apps never show a login: they're paid
  up front and pair with your switchboard by QR — which also keeps us outside Apple's
  sign-in-with-Apple mandate (it only binds apps that offer third-party login).
- **Storage:** the Supabase Postgres holds control-plane metadata: accounts (email, OAuth
  ids), orgs (id, display name, member emails for invites), roles, device *public* keys, push
  tokens, plan/quota counters, bridge configs (bot tokens encrypted at rest); Supabase Storage
  holds the mailbox's sealed blobs with TTL cleanup. No message content, no room names, no
  ledger data — the data plane never writes here.
- **Billing:** **Stripe** (Checkout + Customer Portal + webhooks). Stripe holds the payment
  identity; our Postgres holds the mapping from account → org → device keys → quotas.
- **Web:** the commercial site (marketing + account/billing dashboard) is a **Next.js** app —
  the one place Next earns its keep (SEO, server-side Stripe/auth flows). The *product* web
  app stays a Vite SPA served by your own switchboard; it never talks to the control plane
  except the optional "connect to Wireroom Relay" pairing.

The privacy framing stays intact: the product requires no account ever; the paid relay adds a
billing account (an email) that maps to keys and quotas — never to content.

## Sequencing

Monetization work starts **after** M5's open-source launch — credibility first. The relay is
built in M3 regardless (web push needs it); turning it into a billed service is mostly
accounts-for-billing (billing identity is the one place an email exists, and it maps to keys,
not to content), quotas, and a sales page that is mostly the table above. The apps ship paid
from day one in M4 — that requires no billing infrastructure at all, Apple handles it.
