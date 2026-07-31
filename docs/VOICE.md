# Voice providers

Web dictation turns a short utterance in the composer into text, transcribed **host-side** so
provider credentials never reach the browser. The speech-to-text backend is a swappable
`VoiceProvider`: the operator picks one, a browser request can never redirect audio elsewhere.
The reference provider, `codex`, reuses the operator's existing ChatGPT login. See PRIVACY §voice
for the data-flow and retention disclosure.

## The provider contract

<!-- harn:assume voice-transcription-provider-contract ref=voice-provider-extension-doc -->

Implement the `VoiceProvider` exported by `@codor/protocol`:

```ts
interface VoiceTranscribeInput {
  audio: Uint8Array;   // the codex provider expects a PCM16 RIFF/WAVE payload
  mimeType: string;    // e.g. 'audio/wav'
  sampleRate?: number;
  channels?: number;
}
interface VoiceTranscribeResult { text: string }

interface VoiceProvider {
  id: string;          // bounded lowercase slug — VoiceProviderIdSchema
  label: string;
  transcribe(input: VoiceTranscribeInput): Promise<VoiceTranscribeResult>;
}
```

- **Failures reject, never resolve.** Throw, preserving any non-success response body in the
  message; a transcript is never encoded alongside an error.
- **Typed failures.** Reject with `VoiceTranscribeError` carrying a bounded `code`
  (`'input' | 'auth' | 'upstream'`). The endpoint maps `input` → HTTP 400 and `auth`/`upstream`
  → 502, without string-matching your message. An unclassified throw is treated as `upstream`.
- **Credentials stay host-side.** Read them in the switchboard process; never echo token or
  credential material into results, logs, or error messages.

### Endpoint and catalog

The switchboard exposes two authed routes (bearer, global capability):

- `POST /api/voice/transcribe` (`post`): raw audio bytes in, `{ text }` out. Bounded — 8 MB cap
  (declared length **and** streamed bytes), one transcription in flight per server (a concurrent
  request gets `429`), a request timeout (`504`), and audio held in process memory only, never
  written to disk. Disabled → `404`; selected provider unavailable → `503`.
- `GET /api/voice/providers` (`read`): `{ enabled, selected, providers }`, where each provider is
  **safe public metadata only** — `{ id, label, available, reason? }`. No credential or launch
  material crosses this boundary.

<!-- harn:end voice-transcription-provider-contract -->

## Adding a provider

Providers are a curated named catalog, not a client- or PATH-driven list. Add a
`VoiceProviderDefinition` to `packages/switchboard/src/voice-providers.ts` — a deliberate code edit:

```ts
interface VoiceProviderDefinition {
  id: string;
  label: string;
  status(): Promise<{ available: boolean; reason?: string }>;  // request-time detection
  create(): VoiceProvider;                                     // built only when a turn runs
}
```

`status()` reports availability at request time (presence of usable credentials — never invoke a
binary or mint a token) and supplies the `reason` a browser sees when unavailable. `create()`
builds the live provider only when a transcription actually runs.

## Privacy expectations for a provider

- Project **only** safe metadata (`id`/`label`/`available`/`reason`) — never paths, tokens, or
  command material.
- Treat the audio as memory-only; do not persist it host-side.
- Keep credentials inside the switchboard process. If your backend retains uploaded audio, say so
  (PRIVACY §voice names the codex retention explicitly).

## The codex reference provider

`codex` reuses the operator's signed-in codex identity, host-side:

- **Credentials.** Read at request time from `auth.json` under `CODEX_HOME` (default `~/.codex`) —
  the same reader as the codex usage probe. Only a **ChatGPT login** may transcribe; an API-key
  login, a personal access token, or a signed-out/unreadable file each gets a distinct, actionable
  rejection (`code: 'auth'`). An HTTP `401` says re-authenticate with `codex login` (`code:
  'upstream'`); v1 performs **no** OAuth refresh (documented follow-up).
- **Audio.** Exactly one 24 kHz mono PCM16 WAV. Other PCM rates/channel counts are downmixed and
  linearly resampled in pure TypeScript (no ffmpeg); audio shorter than ~1 s is rejected before
  upload (`code: 'input'`).
- **Upload.** A single `multipart/form-data` `file` part to `chatgpt.com/backend-api/transcribe`
  with the Codex Desktop identity headers. **OpenAI retains the uploaded audio ~30 days
  server-side.**

## Configuration

```
codor up --voice-provider <id>   # default 'codex'; 'none' disables dictation
```

The active provider is operator configuration only — the browser never names or overrides it.
`none` disables the endpoint (`404`) and hides the composer mic entirely.

## v1 limits

- No OAuth token refresh — a `401` surfaces a re-authenticate error (follow-up).
- No streaming partial transcripts; one utterance in, one transcript out.
- Web browser capture only (native Apple dictation is a separate on-device path, PRIVACY §voice).
