# Relay Protocol

The wire contract for Codor's **blind relay** — the Cloudflare Worker that lets a
browser at `codor.app` reach a NAT'd, self-hosted switchboard without either side
opening a port, while the relay forwards only ciphertext and routing metadata. It
holds no keys and can decrypt nothing.

This document is the authoritative spec for a fresh client implementation (e.g. an
iOS port). Every constant, label, and byte layout below is load-bearing; the
canonical source is `@codor/tunnel` (shared browser/Node crypto + framing),
`relay-worker/` (the Worker + Durable Objects), and `packages/switchboard/src/relay/`
(the host side). Two vocabularies are mirrored and MUST stay identical:
`relay-worker/src/control.ts` ⇔ `packages/tunnel/src/control.ts` (close codes,
keepalive strings, control `type`s) and `packages/tunnel/src/codes.ts` ⇔
`packages/switchboard/src/crypto/pairing.ts` (code alphabet + helpers).

```
┌──────────────┐   wss (TLS)   ┌──────────────────────────────┐   wss (TLS)   ┌───────────────────┐
│ browser /    │◄─────────────►│  Cloudflare Worker (router)   │◄─────────────►│ codor switchboard │
│ iOS client   │               │   ├─ PairingRoom  DO (≤10 min)│  (outbound)   │  (user machine)   │
│  codor.app   │               │   └─ SessionRelay DO (durable)│               │                   │
└──────────────┘               └──────────────────────────────┘               └───────────────────┘
        └──────────── end-to-end encryption; the relay sees ciphertext + routing only ─────────────┘
```

Roles are fixed: the **switchboard is the host**, the **connecting client is the
claimant** (pairing) / **initiator** (session). The client always initiates.

---

## 1. Transport conventions

- All relay traffic is WebSocket over TLS. **Binary** messages are opaque forwarded
  payloads — the relay never parses past the routing prefix (§4). **Text** messages
  are JSON control frames, relay-generated or (pairing only) host signals.
- `sessionId` is 32 random bytes rendered as **64 lowercase hex** chars
  (`/^[0-9a-f]{64}$/`). Possession of it is the sole (DoS-only) capability for a
  session; all content security is in the E2E layer.
- A **nameplate** is 2 chars from the 32-symbol alphabet `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`
  (no `0/1/I/O`). The **secret** is 6 chars from the same alphabet. Together they form
  the 8-char pairing code (§6), displayed `XXXX-XXXX`.
- `lv(x)` = a `u16` **big-endian** length prefix followed by `x` (throws above
  `0xffff`). It is the transcript-framing primitive shared by pairing and session
  key derivation.
- Length-prefixed integers on the wire are big-endian unless stated otherwise; AEAD
  nonce counters are the one deliberate exception (little-endian, §5.3).

---

## 2. Worker routes (`relay-worker/src/index.ts`)

The Worker has zero third-party dependencies and logs only invocation metadata
(method, path, status) — never frame or body bytes.

| Method | Path | Success | Errors |
|---|---|---|---|
| `GET`  | `/healthz` | `200 "ok"` | — |
| `POST` | `/v1/pair/rooms` | `200 {"nameplate":"7Q"}` | `503 {"error":"exhausted"}` |
| `GET`  | `/v1/pair/{nameplate}/ws?role=host\|claim` | `101` (upgrade → PairingRoom) | `400 "invalid nameplate"`, `400 "missing or invalid role"` |
| `GET`  | `/v1/session/{sessionId}/ws?role=host\|client` | `101` (upgrade → SessionRelay) | `400 "invalid session id"`, `400 "missing or invalid role"` |
| (else) | — | — | `404 "not found"` |

- The Worker routes a pairing WS to `PairingRoom` via `idFromName(nameplate)` and a
  session WS to `SessionRelay` via `idFromName(sessionId)`.
- **Room reservation** (`POST /v1/pair/rooms`): the Worker draws up to
  `MAX_RESERVE_ATTEMPTS = 5` **distinct** random nameplates (a repeat draw does not
  consume an attempt), calling each candidate room's internal `/reserve`. First free
  room → `{nameplate}`; all busy → `503 {"error":"exhausted"}`. Random nameplate
  chars come from `byte & 31` over the alphabet.

---

## 3. PairingRoom Durable Object (`relay-worker/src/pairing-room.ts`)

A short-lived rendezvous for exactly one pairing. SQLite-backed; storage is tiny:
`{reserved, attempts, churn, created_at}`. Constants: `TEN_MINUTES_MS`,
`MAX_ATTEMPTS = 3`, `MAX_CHURN = 10`.

- **`/reserve`** (internal): if already reserved → `409 {"error":"busy"}`; else store
  `{reserved:true, attempts:0, churn:0, created_at}`, arm an alarm at
  `now + 10 min`, return `200 "ok"`. **The 10-minute lifetime is enforced only here.**
- **Sockets** use the Hibernation API with a `{role}` attachment. One **host** socket:
  a new host supersedes the old (close `4001 "superseded"`). At most one **claimant**;
  a second while occupied → close `4002 "busy"`. Each claimant admission increments
  `churn`; `churn > 10` → `burn('churn')` and the new socket closes `4000 "burned"`.
- **Binary** from either role → forwarded verbatim to the other role. No peer present →
  the sender gets text `{"type":"no-peer"}`.
- **Text accepted from the host only**:
  - `{"type":"fail"}` → close claimant(s) `4003 "rejected"`, `attempts++`; at
    `attempts >= 3` → `burn('attempts')`.
  - `{"type":"success"}` → `burn('paired')`.
- **Relay-generated text**: `{"type":"peer-joined","role":…}`,
  `{"type":"peer-left","role":…}`, and best-effort `{"type":"burned","reason":…}` with
  `reason ∈ {expired, attempts, paired, churn}` before closing.
- **Burn** = notify all sockets, close them (`1000` when `reason==='paired'`, else
  `4000`), `deleteAll()`, `deleteAlarm()`. The alarm fires `burn('expired')`. After a
  burn the nameplate is reusable (a fresh `/reserve`).

Close codes (`relay-worker/src/control.ts`): `PAIRED 1000`, `BURN 4000`,
`SUPERSEDED 4001`, `BUSY 4002`, `REJECTED 4003`, `FULL 4004`.

---

## 4. SessionRelay Durable Object (`relay-worker/src/session-relay.ts`)

The durable, keyless rendezvous for a paired session. SQLite storage is just
`{next_conn_id}`. No alarm, no expiry — it evicts naturally when all sockets close.

- **Host socket**: newest wins; a superseded host is closed `4001` and excluded from
  delivery immediately (only an `OPEN` host receives).
- **Client sockets**: on accept, assign `connId = next_conn_id` (starting at **1**,
  persisted and monotonic, never reused within the DO's life); cap `MAX_CLIENTS = 16`,
  overflow → close `4004 "full"`. Attachment `{role, connId}`.
- **Routing** (4-byte big-endian `connId` prefix, `CONN_ID_BYTES = 4`):
  - client → host: the relay prepends the client's `connId`: `connId(u32 BE) ‖ payload`.
  - host → client: the host prepends the target `connId`; the relay reads the first 4
    bytes (`getUint32(0, false)`), strips them, and routes to that client. Unknown
    target → host gets `{"type":"unknown-conn","conn":N}`.
- **Text notices** (`control.ts`): to clients `{"type":"host-connected"}` /
  `{"type":"host-disconnected"}` (the latter only if no other host is `OPEN`); to the
  host `{"type":"client-connected","conn":N}` / `{"type":"client-disconnected","conn":N}`,
  and each existing client is re-announced to a freshly connected host.

### 4.1 Keepalive (billing-critical)

Both DOs arm `setWebSocketAutoResponse(new WebSocketRequestResponsePair("codor-ping","codor-pong"))`
(`RELAY_KEEPALIVE_PING` / `RELAY_KEEPALIVE_PONG`). An endpoint sends the text frame
`"codor-ping"` when idle and the DO answers `"codor-pong"` **without waking** — so
keepalive costs no DO invocations. The sender-side cadence lives in
`packages/tunnel/src/keepalive.ts`: `RELAY_KEEPALIVE_INTERVAL_MS = 30_000` (probe on
arm, then every 30 s while idle) and the link is declared dead after **2** consecutive
unanswered intervals (~60 s). App-level heartbeat frames are forbidden — keepalive
lives only at this layer.

---

## 5. Pairing crypto (`@codor/tunnel/src/pake.ts`)

A **CPace-style balanced PAKE over ristretto255** (revised 2026-07-27; interop with
other CPace implementations is a non-goal). Primitives: ristretto255 + `hashToCurve`
and SHA-512 from `@noble/curves`; HMAC-SHA-256, HKDF-SHA-256, SHA-256 from
`@noble/hashes`; XChaCha20-Poly1305 from `@noble/ciphers`.

String constants: `CPACE_DST = "codor-relay/v1/cpace"`, `ISK_LABEL = "codor-relay/v1/isk"`,
`CONFIRM_CLAIMANT = "confirm-claimant"`, `CONFIRM_HOST = "confirm-host"`,
`PAIR_H2C_INFO = "codor-relay/v1/pair/h2c"`, `PAIR_C2H_INFO = "codor-relay/v1/pair/c2h"`.
Sizes: `SID_LENGTH 16`, `POINT_LENGTH 32`, `TAG_LENGTH 32`, `MSG_A_LENGTH 48`.

### 5.1 PAKE exchange

1. Host picks `sid` = 16 random bytes. Both sides derive the generator via **RFC 9380
   ristretto255 hash-to-curve** (noble `ristretto255_hasher.hashToCurve`, which runs
   `expand_message_xmd` over SHA-512 driven by the DST) — *not* a hand-rolled
   "SHA-512 then map":

   ```
   g = hashToCurve( lv(secret) ‖ lv("nameplate:" + nameplate) ‖ lv(sid),  DST = CPACE_DST )
   ```

   Note the literal `"nameplate:"` prefix on the nameplate field. `g` never transmits.
2. Host: random scalar `ya` (64 uniform bytes reduced mod L, rejecting 0), `Ya = g·ya`.
   Sends **`MSG_A = sid(16) ‖ Ya(32)`** = 48 bytes.
   Claimant: derives the same `g`, random `yb`, `Yb = g·yb`, `K = Ya·yb`. Both sides
   reject a `K` that is the identity element or fails ristretto decoding (→ failed
   attempt).
3. `ISK = SHA-512( lv(ISK_LABEL) ‖ lv(sid) ‖ lv(K) ‖ lv(Ya) ‖ lv(Yb) )[0..32]`.
4. Confirmation (binary frames): claimant sends **`MSG_B = Yb(32)`**, then a separate
   32-byte `tagC = HMAC-SHA256(ISK, "confirm-claimant")`. Host verifies `tagC`
   (constant-time); bad → host emits room text `{"type":"fail"}` (attempt counted) and
   resets its PAKE state for a fresh claimant. Good → host replies
   `tagH = HMAC-SHA256(ISK, "confirm-host")`; the claimant verifies it and aborts on
   mismatch (a fake host cannot produce it). A failed confirmation is terminal: the
   detecting side drops its derived-key references and refuses to create a channel.
   (The current build drops references rather than securely wiping the key bytes;
   secure wiping is a tracked future hardening item.)

### 5.2 Pairing channel keys

```
h2c = HKDF-SHA256( ikm = ISK, salt = sid, info = "codor-relay/v1/pair/h2c" )   // 32 B
c2h = HKDF-SHA256( ikm = ISK, salt = sid, info = "codor-relay/v1/pair/c2h" )   // 32 B
```

(salt is `sid`, **not** empty.) The host channel sends on `h2c` / receives on `c2h`;
the claimant is the mirror. Channels are memoized so nonce counters never restart.

### 5.3 AEAD framing (`@codor/tunnel/src/aead.ts`)

Every subsequent binary channel message is one XChaCha20-Poly1305 ciphertext.
`AEAD_KEY_LENGTH 32`, `AEAD_NONCE_LENGTH 24`, `AEAD_TAG_LENGTH 16`. The **nonce** is a
`u64` **little-endian** counter in the first 8 bytes followed by 16 zero bytes; AAD is
empty. Each direction has an independent counter starting at 0, advancing by 1 per
message, never wrapping (overflow throws). This same construction is reused by the
session layer (§6).

### 5.4 Pairing-channel envelope (`pairing-channel.ts`)

JSON plaintexts sealed by the channel, in order:

1. host → claimant `{"type":"hello", "switchboard":PublicIdentity, "session_id":<64-hex>,
   "host_static_pub":<b64 X25519, 32 B>, "pairing_token":<token>,
   "relay_url":<the switchboard's configured URL, as-is — default `https://relay.codor.app`>,
   "protocol":1}` (`protocol !== 1` is rejected). `relay_url` is delivered verbatim
   (an `http(s)://` origin, **not** pre-normalized to `ws(s)`); normalizing the scheme
   to `ws(s)://` for the session socket is the **receiver's** duty, exactly as the
   browser client does.
2. claimant → host `{"type":"enroll", "request":PairingRequest, "client_static_pub":<b64, 32 B>,
   "pairing_token":<echo>}`.
3. host verifies the echoed token, enrolls, and replies `{"type":"enrolled", "result":PairingResult}`.
4. claimant persists everything (§7) and replies `{"type":"done"}`; the host sends room
   text `{"type":"success"}` → burn. Both proceed to a session.

The static X25519 keys (`host_static_pub` / `client_static_pub`) are **dedicated tunnel
keys**, generated once per side (host at first relay enable; client at pairing),
distinct from the sodium identity keys.

---

## 6. Session handshake (`@codor/tunnel/src/handshake.ts`)

A **KK-style** Noise-like handshake, one per client connection; the client is the
initiator. Both static keys are known to their owners; the client is identified by
`kid = SHA-256(client_static_pub)[0..8]` (**first 8 bytes**). Labels:
`KK_LABEL = "codor-relay/v1/kk"`, HKDF-Expand infos `"confirm"` / `"c2h"` / `"h2c"`,
confirmation-tag HMAC labels `"host"` / `"client"`. Sizes: `KID_LENGTH 8`,
`KEY_LENGTH 32`, `TAG_LENGTH 32`, `MSG1_LENGTH 40`, `MSG2_LENGTH 64`.

- **msg1** client → host: `kid(8) ‖ Ec_pub(32)` = 40 bytes (`Ec` is a fresh X25519
  ephemeral).
- The host resolves `client_static_pub` from `kid` (unknown/revoked → ignore, optionally
  close the conn), generates ephemeral `Eh`, and both sides compute the four DH values
  in this exact concatenation order (naming: first letter = client side, second = host):

  ```
  dhEE = X25519(client_ephemeral, host_ephemeral)
  dhES = X25519(client_ephemeral, host_static)
  dhSE = X25519(client_static,    host_ephemeral)
  dhSS = X25519(client_static,    host_static)
  ```

- Key schedule:

  ```
  transcript = SHA-256( lv(KK_LABEL) ‖ lv(sessionId) ‖ lv(kid)
                        ‖ lv(Ec_pub) ‖ lv(Eh_pub) ‖ lv(Sc_pub) ‖ lv(Sh_pub) )
  master     = HKDF-Extract( salt = transcript, ikm = dhEE ‖ dhES ‖ dhSE ‖ dhSS )
  confirm    = HKDF-Expand( master, "confirm", 32 )
  c2h        = HKDF-Expand( master, "c2h", 32 )
  h2c        = HKDF-Expand( master, "h2c", 32 )
  ```

- **msg2** host → client: `Eh_pub(32) ‖ HMAC(confirm, "host")(32)` = 64 bytes. The client
  verifies the tag (an impostor host lacks `S_h` and cannot compute `dhES`).
- **msg3** client → host: `HMAC(confirm, "client")(32)` = 32 bytes. The host verifies (an
  impostor client lacks `S_c` and cannot compute `dhSE`). Only then does either side send
  app data. A failed tag is terminal: the detecting side drops its derived-key
  references and refuses to create a channel (references dropped, not securely wiped).
- After the handshake, framing is XChaCha20-Poly1305 with the §5.3 per-direction
  little-endian counter nonces. Forward secrecy is per connection via `dhEE`; the fresh
  ephemerals + transcript binding make cross-connection replay impossible.

---

## 7. Stream mux (`@codor/tunnel/src/frames.ts`, `mux.ts`)

Inside the session AEAD, a decrypted binary message is a **packet** — one or more
length-prefixed frames — that carries a multiplexed stream protocol.

```
packet = ( u32-BE frameLength ‖ frame )+
frame  = type(1) ‖ streamId(u32 BE) ‖ payload          // FRAME_HEADER = 5
```

Frame types (`FrameType`): `OPEN 0x01`, `DATA 0x02`, `END 0x03`, `RESET 0x04`,
`WINDOW 0x05`, `HTTP_HEAD 0x07`. (`0x06` is intentionally unused.)

- **OPEN** payload = `kind(1) ‖ …`. `StreamKind`: `APP_WS 0x01` (then
  `tokenLen(u16 BE) ‖ token`), `HTTP 0x02` (kind byte only).
- **DATA** = bytes. **END** = empty payload, half-closes the sender's direction
  (deferred until its send queue drains). **RESET** = `reasonLen(u16 BE) ‖ reason`.
  **WINDOW** = `u32 BE` credit granted. **HTTP_HEAD** = UTF-8 JSON (not flow-controlled).
- **Stream ids**: the client opens **odd** ids from 1, the host opens **even** ids from 2
  (`nextId += 2`); stream 0 is reserved.
- **Coalescing**: a sender buffers frames and flushes at `COALESCE_FLUSH_BYTES = 64 KiB`
  or `COALESCE_FLUSH_MS = 16 ms`, whichever first. `MAX_FRAME_PAYLOAD = 64 KiB`,
  `MAX_COALESCED_PACKET = 256 KiB` (≪ the DO's 1 MiB message cap after AEAD overhead).
- **Flow control**: each direction of each stream starts with `DEFAULT_WINDOW = 512 KiB`
  (`APP_WS_WINDOW = 4 MiB` for app-WS streams); DATA consumes credit, the receiver
  returns `WINDOW` as it drains, the sender stalls at 0. DATA is fragmented at
  `min(available, sendWindow, MAX_FRAME_PAYLOAD)`.

### 7.1 Loopback bridging (host side, `packages/switchboard/src/relay/link.ts`)

- **App-WS stream** (`OPEN` kind `0x01`, one per browser tab): the host opens a loopback
  `ws://127.0.0.1:<port>/ws?token=<token>` and pipes DATA ⇄ WS messages, preserving the
  entire existing auth + protocol stack unchanged. The app-WS byte stream is itself
  length-delimited (`u32-BE length ‖ bytes`) and reassembled, because DATA fragments at
  the window / 64 KiB boundary.
- **HTTP stream** (`OPEN` kind `0x02`): client sends `OPEN`, `HTTP_HEAD` (request
  `{method, target, headers?}`), `DATA*` body, `END`; the host performs a loopback
  `fetch("http://127.0.0.1:<port>" + target, …)` and streams back `HTTP_HEAD`
  (`{status, headers}`), `DATA*` in `HTTP_CHUNK = 64 KiB` chunks, `END`. Header
  allowlist: `content-type`, `accept`, `authorization`, `content-length`, and any
  `x-codor-*`. Request or response bodies above `MAX_HTTP_RESPONSE = 32 MiB` → `RESET`.
- Reconnect backoff: `min(60_000, 1000 · 2^attempt) + jitter`.

---

## 8. Universal pairing code — one code, both doors

A single `XXXX-XXXX` code pairs a browser through **either** door: the blind relay
(hosted `codor.app`) or a direct/local origin (LAN/Tailscale). One code, one grant,
one burn.

**Mint** (`RelayPairingHost.pair`, `packages/switchboard/src/relay/pairing-host.ts`):

1. Generate the 6-char `secret`; reserve a relay room to get the `nameplate`.
2. `code = composeCode(nameplate, secret)`.
3. `offer = PairingService.issueForCode(code, endpoint)` — registers the code as a
   **local** pairing grant and mints its `pairing_token`.
4. Dial `…/v1/pair/{nameplate}/ws?role=host` and run the pairing session carrying that
   same `pairing_token`.
5. Return `{ …offer, doors: "both" }`.

Degradation is triggered specifically by **room-reservation failure**: if reserving a
relay room throws (relay unreachable), the mint falls back to `PairingService.issue`
(`doors: "local"`) so the printed code still pairs on the LAN/Tailscale rather than
failing. A failure *after* a successful reservation (e.g. the host's dial of the room
socket fails later) still returns `doors: "both"` with a code whose relay room is dead;
that case is not caught at mint time — the runtime recovery journey is the backstop, and
the browser's pairing-time classifier turns a dead room into "get a fresh code" rather
than a false "re-pair".

**Both doors consume the one grant** (`PairingService`,
`packages/switchboard/src/crypto/pairing.ts`): `issueForCode` stores
`{token_hash, code_hash, endpoint, expires_at}` (10-minute TTL) in `pairing-tokens.json`.

- **Relay door**: the pairing session's enroll calls `complete(token, request)` — burns
  the grant by `token_hash`.
- **Local door**: the browser POSTs the whole code to `/api/pairing/exchange`; the
  switchboard matches it by `code_hash` (constant-time), rotates the token, clears
  `code_hash`, then `complete(token, request)` burns it.

Both paths act on the same entry, so consuming either door invalidates the other.
`complete` enrolls **before** burning, so a malformed request leaves the grant intact
for a retry at either door.

**Client normalization** (`@codor/tunnel/src/codes.ts`, mirrored in the switchboard):
`PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"`, `NAMEPLATE_LENGTH 2`,
`SECRET_LENGTH 6`, `CODE_LENGTH 8`. `normalizeCode` uppercases, accepts `XXXXXXXX` or
`XXXX-XXXX`, strips the dash; `splitCode` takes chars 1–2 as the nameplate and 3–8 as the
secret. The browser's relay door is `pairThroughRelay` (normalize → split → PAKE →
connect `role=claim`); the local door is `exchangeBrowserPairingCode` (POST the whole
code).

---

## 9. Persistence

### 9.1 Switchboard — `<dataDir>/crypto/relay.json` (mode `0600`)

```ts
RelayRecord {
  version: 1
  enabled: boolean
  relay_url: string                              // default https://relay.codor.app
  session_id: string                             // 64-hex (32 bytes); '' until first enable
  host_static: { pub: string; priv: string }     // base64 X25519 keypair
  devices: RelayDeviceRecord[]
}
RelayDeviceRecord {
  device_id: string
  kid: string                                     // hex( SHA-256(client_static_pub)[0..8] )
  client_static_pub: string                       // base64 X25519
  label?: string
  enrolled_at: string                             // ISO 8601
}
```

`session_id` + `host_static` are generated once on first `enable()`; `rotate()` replaces
`session_id` (all paired devices must re-pair). Grants live separately in
`<dataDir>/crypto/pairing-tokens.json` as `{version:1, tokens:[{token_hash, code_hash?,
endpoint, expires_at}]}`.

### 9.2 Browser / client — IndexedDB `codor-crypto-v1`, store `state`

A string-keyed key-value store. The relay tunnel record is under key `"relay"`:

```ts
StoredRelayRecord {
  relay_url: string
  session_id: string                             // 64-hex
  client_static: { pub: string; priv: string }   // base64url (the browser's own keys)
  host_static_pub: string                        // standard padded Base64 (as delivered by the host)
}
```

Note the **mixed encodings**: the browser's own tunnel keys are base64url, but
`host_static_pub` is stored verbatim as the host delivered it — standard padded
Base64. A port MUST accept both encodings for the shipped data rather than assuming one.

Other global (active-cache) keys: `"identity"`, `"peer:switchboard"`,
`"access:switchboard"`, and `room:<room>` (`{room, generation, key}`).

**Multi-computer index** (hosted app, `runtime/relay-store.ts`): key `"relay-index"`
holds `RelayIndex { version:2, computers: {id, label, paired_at, gen}[], active_id? }`.
Each paired computer's key material lives in an immutable **generation** under the key
prefix `computer:<id>:<gen>:<class>` (classes: `relay`, `peer:switchboard`,
`access:switchboard`, `room:<room>`). The index `{id, gen}` is the sole truth; the
global keys above are a derived cache re-hydrated from the active generation on every
boot. Index mutations and the boot hydrate serialize through a Web Lock named
`codor-relay-store` when the Web Locks API is available (pass-through otherwise) so
multiple tabs cannot race the read-modify-write. **Every relay pairing writes the
index — including the first computer.** Only a **direct** (non-relay) pairing keeps no
index and uses the global keys directly.

---

## 10. Deployment notes (canonical hostname vs. ECH)

The Worker is reachable at two hostnames that terminate at the same Worker and Durable
Objects — the vanity `relay.codor.app` and the `workers.dev` alias
(`codor-relay.<subdomain>.workers.dev`, pinned with `"workers_dev": true` in
`wrangler.jsonc`). They are **not** interchangeable for every client, because of
Encrypted Client Hello (ECH):

- A **browser page load** to `https://relay.codor.app` uses ECH, so its SNI is hidden
  and the origin loads even on SNI-filtering networks. But a **browser WebSocket
  upgrade does not get ECH** — `wss://relay.codor.app` is reset mid-handshake on those
  same networks, *despite* a working `/healthz`. The failure is invisible to a plain
  reachability check.
- A **non-browser TLS client** (Node switchboard host, or a native iOS client) exposes
  SNI on every connection and is reset by an SNI filter on the vanity name.

Therefore the **shipping relay URL is the `workers.dev` alias**, which is not
SNI-filtered: it is what `codor.app` bakes in (`VITE_CODOR_RELAY_URL`) and what the
switchboard host dials (`CODOR_TUNNEL_URL`). A port SHOULD default to the alias for its
session socket, and any reachability probe MUST exercise a real `wss://` upgrade from an
unfiltered network — a `GET /healthz` (or any page load) can pass while the WebSocket
upgrade is silently reset.
