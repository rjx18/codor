import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  VoiceTranscribeError,
  type VoiceProvider,
  type VoiceTranscribeInput,
  type VoiceTranscribeResult,
} from '@codor/protocol';

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

// harn:assume codex-voice-upload-is-24khz-mono-pcm16-wav ref=codex-transcribe-wav-format
const TARGET_SAMPLE_RATE = 24_000;
const MIN_DURATION_SECONDS = 1;

const clampInt16 = (value: number): number =>
  Math.max(-32_768, Math.min(32_767, Math.round(value)));

/** Parse a RIFF/WAVE PCM16 payload into interleaved samples plus its format. */
function parseWav(bytes: Uint8Array): { sampleRate: number; channels: number; samples: Int16Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new VoiceTranscribeError('input', 'Codex voice transcription expects a RIFF/WAVE audio payload.');
  }
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | undefined;
  let data: Uint8Array | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      data = bytes.subarray(body, Math.min(bytes.length, body + size));
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data) {
    throw new VoiceTranscribeError('input', 'Codex voice transcription expects a WAV file with fmt and data chunks.');
  }
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16 || fmt.channels < 1) {
    throw new VoiceTranscribeError('input', 'Codex voice transcription expects uncompressed PCM16 WAV audio.');
  }
  const frameView = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = Math.floor(data.length / 2);
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i += 1) samples[i] = frameView.getInt16(i * 2, true);
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples };
}

/** Downmix interleaved PCM16 to mono and linearly resample to 24 kHz. */
function toMono24k(samples: Int16Array, sampleRate: number, channels: number): Int16Array {
  const frames = Math.floor(samples.length / channels);
  const mono = new Float64Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += samples[f * channels + c];
    mono[f] = sum / channels;
  }
  if (sampleRate === TARGET_SAMPLE_RATE) {
    const same = new Int16Array(frames);
    for (let i = 0; i < frames; i += 1) same[i] = clampInt16(mono[i]);
    return same;
  }
  const outLength = Math.max(1, Math.round((frames * TARGET_SAMPLE_RATE) / sampleRate));
  const out = new Int16Array(outLength);
  const step = frames <= 1 ? 0 : (frames - 1) / Math.max(1, outLength - 1);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * step;
    const low = Math.floor(pos);
    const high = Math.min(frames - 1, low + 1);
    const frac = pos - low;
    out[i] = clampInt16(mono[low] * (1 - frac) + mono[high] * frac);
  }
  return out;
}

/** Encode mono PCM16 samples as a canonical 24 kHz RIFF/WAVE payload. */
function encodeWav(samples: Int16Array): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const tag = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audioFormat: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true); // byte rate = rate * blockAlign
  view.setUint16(32, 2, true); // block align = channels * bytesPerSample
  view.setUint16(34, 16, true); // bits per sample
  tag(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) view.setInt16(44 + i * 2, samples[i], true);
  return new Uint8Array(buffer);
}

/**
 * Normalize any PCM16 WAV to exactly one 24 kHz mono PCM16 payload and reject
 * audio shorter than {@link MIN_DURATION_SECONDS} before it wastes a paid call.
 * Audio already at 24 kHz mono passes through with an unchanged sample stream.
 */
export function ensureCodexWav(bytes: Uint8Array): Uint8Array {
  const { sampleRate, channels, samples } = parseWav(bytes);
  const frames = Math.floor(samples.length / channels);
  const duration = frames / sampleRate;
  if (duration < MIN_DURATION_SECONDS) {
    throw new VoiceTranscribeError(
      'input',
      `Codex voice transcription needs at least ${String(MIN_DURATION_SECONDS)}s of audio (got ${duration.toFixed(2)}s).`,
    );
  }
  return encodeWav(toMono24k(samples, sampleRate, channels));
}
// harn:end codex-voice-upload-is-24khz-mono-pcm16-wav

// harn:assume codex-voice-transcription-reuses-signed-in-codex-identity ref=codex-transcribe-credentials
type CodexAuth =
  | { mode: 'chatgpt'; accessToken: string; accountId: string }
  | { mode: 'api-key' }
  | { mode: 'personal-access-token' }
  | { mode: 'missing' };

function defaultCredentialsPath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
}

/** ChatGPT-login access tokens are JWTs; anything else is not a login token. */
const isJwt = (token: string): boolean => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token);

/**
 * Read codex's own auth.json at request time (same shape as the limits probe)
 * and classify the sign-in mode. Credential material never leaves this process.
 */
async function readCodexAuth(path: string): Promise<CodexAuth> {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = record(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return { mode: 'missing' };
  }
  if (!parsed) return { mode: 'missing' };
  const tokens = record(parsed.tokens);
  const accessToken = str(tokens?.access_token ?? parsed.access_token);
  const accountId = str(tokens?.account_id ?? parsed.account_id);
  if (accessToken && !isJwt(accessToken)) return { mode: 'personal-access-token' };
  if (accessToken && accountId) return { mode: 'chatgpt', accessToken, accountId };
  if (str(parsed.OPENAI_API_KEY)) return { mode: 'api-key' };
  return { mode: 'missing' };
}

/**
 * Whether codex dictation is usable right now, from the same credentials read —
 * `available` only for a ChatGPT login. `reason` reuses the auth-matrix wording
 * and never carries a path or token, so it is safe to project to a browser.
 */
export async function codexVoiceStatus(
  options: { credentialsPath?: string } = {},
): Promise<{ available: boolean; reason?: string }> {
  const auth = await readCodexAuth(options.credentialsPath ?? defaultCredentialsPath());
  return auth.mode === 'chatgpt'
    ? { available: true }
    : { available: false, reason: chatgptAuthRejection(auth.mode) };
}
// harn:end codex-voice-transcription-reuses-signed-in-codex-identity

// harn:assume codex-voice-transcription-requires-chatgpt-login ref=codex-transcribe-auth-matrix
/** The single source of the mode-specific rejection wording (throw and status share it). */
function chatgptAuthRejection(mode: 'api-key' | 'personal-access-token' | 'missing'): string {
  switch (mode) {
    case 'api-key':
      return 'Codex voice transcription requires a ChatGPT login, not an API key. Run `codex login` to sign in with ChatGPT.';
    case 'personal-access-token':
      return 'Codex voice transcription requires an interactive ChatGPT login, not a personal access token. Run `codex login`.';
    case 'missing':
      return 'Codex voice transcription needs a signed-in ChatGPT account. Run `codex login` first.';
  }
}

/** Gate the auth mode: only a ChatGPT login proceeds; every other mode is a fix. */
function authorizeChatgpt(auth: CodexAuth): { accessToken: string; accountId: string } {
  if (auth.mode === 'chatgpt') return { accessToken: auth.accessToken, accountId: auth.accountId };
  throw new VoiceTranscribeError('auth', chatgptAuthRejection(auth.mode));
}

/** Map a non-success upload: 401 is a clear re-auth (no v1 refresh); else keep the body. */
function throwTranscribeFailure(status: number, body: string): never {
  if (status === 401) {
    throw new VoiceTranscribeError(
      'upstream',
      'Codex voice transcription was rejected (401 Unauthorized). Re-authenticate with `codex login` and try again.',
    );
  }
  throw new VoiceTranscribeError('upstream', `Codex voice transcription failed (${String(status)}): ${body}`);
}
// harn:end codex-voice-transcription-requires-chatgpt-login

// harn:assume codex-voice-transcription-reuses-signed-in-codex-identity ref=codex-transcribe-request
export const CODEX_TRANSCRIBE_URL = 'https://chatgpt.com/backend-api/transcribe';
const CODEX_DESKTOP_VERSION = '0.5.0';
const CODEX_DESKTOP_USER_AGENT =
  `Codex Desktop/${CODEX_DESKTOP_VERSION} (Macintosh; Intel Mac OS X; ${process.arch})`;

export interface CodexTranscribeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type CodexTranscribeFetcher = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: FormData },
) => Promise<CodexTranscribeResponse>;

const defaultFetcher: CodexTranscribeFetcher = async (url, init) => {
  const response = await fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
    text: () => response.text(),
  };
};

/** POST the WAV as a single `file` part with the Codex Desktop identity headers. */
async function postCodexTranscribe(
  fetcher: CodexTranscribeFetcher,
  credential: { accessToken: string; accountId: string },
  wav: Uint8Array,
): Promise<CodexTranscribeResponse> {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'codex.wav');
  return fetcher(CODEX_TRANSCRIBE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credential.accessToken}`,
      'ChatGPT-Account-Id': credential.accountId,
      'OAI-Product-Sku': 'CODEX',
      originator: 'Codex Desktop',
      'User-Agent': CODEX_DESKTOP_USER_AGENT,
    },
    body: form,
  });
}
// harn:end codex-voice-transcription-reuses-signed-in-codex-identity

export interface CodexVoiceProviderOptions {
  /** Override the auth.json path (defaults to `CODEX_HOME`/`~/.codex`). */
  credentialsPath?: string;
  /** Inject the HTTP boundary; defaults to global `fetch`. */
  fetcher?: CodexTranscribeFetcher;
}

/**
 * Reference {@link VoiceProvider}: borrows the operator's signed-in codex
 * identity, host-side only, to transcribe a short utterance. Reads no
 * credentials into results, logs, or error messages, and never mints or
 * refreshes tokens.
 */
export class CodexVoiceProvider implements VoiceProvider {
  readonly id = 'codex';
  readonly label = 'Codex (ChatGPT login)';

  constructor(private readonly options: CodexVoiceProviderOptions = {}) {}

  async transcribe(input: VoiceTranscribeInput): Promise<VoiceTranscribeResult> {
    const wav = ensureCodexWav(input.audio);
    const credential = authorizeChatgpt(
      await readCodexAuth(this.options.credentialsPath ?? defaultCredentialsPath()),
    );
    const fetcher = this.options.fetcher ?? defaultFetcher;
    const response = await postCodexTranscribe(fetcher, credential, wav);
    if (!response.ok) {
      throwTranscribeFailure(response.status, await response.text().catch(() => ''));
    }
    const text = str(record(await response.json())?.text);
    if (text === undefined) {
      throw new VoiceTranscribeError('upstream', 'Codex voice transcription returned an empty transcript.');
    }
    return { text };
  }
}
