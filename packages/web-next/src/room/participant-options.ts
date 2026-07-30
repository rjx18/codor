import type { AdapterRegistration } from '@runtime/api.js';

export type ParticipantMode =
  | 'new'
  | 'existing'
  | 'ollama'
  | 'nvidia'
  | 'codex-cloud'
  | 'other';

export type StartingParticipantMode = 'none' | ParticipantMode;
export type JoinHarnessChoice = 'codex' | 'claude-code' | 'other';
export type ConnectorMode = Extract<ParticipantMode, 'ollama' | 'nvidia'>;

export const PARTICIPANT_MODE_COPY: Record<
  Exclude<ParticipantMode, 'new' | 'existing'>,
  { title: string; status: string; body: string; detail: string }
> = {
  ollama: {
    title: 'Ollama local model',
    status: 'Connector unavailable',
    body: 'This Codor host is not currently running the Ollama bridge.',
    detail: 'Start Codor with its configured Ollama adapter. The bridge uses the local OpenAI-compatible endpoint at http://127.0.0.1:11434/v1 and needs no API key.',
  },
  nvidia: {
    title: 'NVIDIA-hosted model',
    status: 'Connector unavailable',
    body: 'This Codor host is not currently running the NVIDIA bridge.',
    detail: 'Start Codor with its configured NVIDIA adapter and a dedicated Keychain service. The browser never requests, reveals, or retains your API key.',
  },
  'codex-cloud': {
    title: 'Codex Cloud task',
    status: 'Not attachable yet',
    body: 'A Codex Cloud task is not the same thing as a local Codex CLI session UUID.',
    detail: 'The current Codex adapter can spawn or resume local CLI sessions. Codex Cloud needs a known environment plus verified task-output ingestion before it can safely join a channel.',
  },
  other: {
    title: 'Something else',
    status: 'Describe it',
    body: 'Name the provider or runtime you want to connect.',
    detail: 'If it exposes a compatible Agent Client Protocol command, use New agent → Advanced → Custom ACP command. Otherwise it needs a dedicated Codor adapter.',
  },
};

export function connectorHarnessFor(
  mode: ParticipantMode | StartingParticipantMode,
): ConnectorMode | undefined {
  return mode === 'ollama' || mode === 'nvidia' ? mode : undefined;
}

export function configuredConnector(
  mode: ParticipantMode | StartingParticipantMode,
  adapters: readonly AdapterRegistration[],
): AdapterRegistration | undefined {
  const harness = connectorHarnessFor(mode);
  return harness === undefined
    ? undefined
    : adapters.find((adapter) => adapter.id === harness && adapter.installed !== false);
}
