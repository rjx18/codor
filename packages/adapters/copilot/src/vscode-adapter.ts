import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  PolicySchema,
  type AdapterTurnHooks,
  type HarnessAdapter,
  type ModelCatalog,
  type Session,
  type SessionRef,
  type SpawnOpts,
  type WireEvent,
} from '@codor/protocol';

const MAX_DISCOVERY_BYTES = 4096;
const MAX_HISTORY_CHARS = 256 * 1024;
const MAX_HISTORY_ITEMS = 40;
const MAX_CHECKPOINT_CHARS = 128 * 1024;
const MAX_CHECKPOINT_RESPONSE_CHARS = 512 * 1024;
const DEFAULT_DISCOVERY = join(homedir(), '.codor', 'copilot-vscode-bridge.json');

interface DiscoveryRecord {
  protocol_version: 1;
  pid: number;
  port: number;
  token: string;
  started_at: string;
}

interface BridgeEvent {
  type: string;
  index?: number;
  revision?: number;
  turn_id?: string;
  text_delta?: string;
  part?: unknown;
  result?: unknown;
  response?: unknown[];
  message?: string;
  recoverable?: boolean;
  assistant_text?: string;
}

// harn:assume vscode-copilot-recoverable-native-failure-preserves-context ref=vscode-copilot-session-checkpoint
interface VscodeSession extends Session {
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  active_turn_id?: string;
  active_request?: boolean;
  retired?: boolean;
  bridge_generation?: string;
  failure_checkpoint?: {
    prompt: string;
    response: string;
    native_response: unknown[];
    bridge_generation: string;
  };
}
// harn:end vscode-copilot-recoverable-native-failure-preserves-context

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseDiscovery(path: string): DiscoveryRecord | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_DISCOVERY_BYTES) {
      return undefined;
    }
    if (
      process.platform !== 'win32'
      && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))
    ) return undefined;
    const source = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (
      source.protocol_version !== 1
      || typeof source.pid !== 'number'
      || !Number.isInteger(source.pid)
      || source.pid <= 0
      || typeof source.port !== 'number'
      || !Number.isInteger(source.port)
      || source.port < 1
      || source.port > 65535
      || typeof source.token !== 'string'
      || !/^[0-9a-f]{64}$/.test(source.token)
      || typeof source.started_at !== 'string'
      || source.started_at === ''
    ) return undefined;
    process.kill(source.pid, 0);
    return source as unknown as DiscoveryRecord;
  } catch {
    return undefined;
  }
}

function discoveryGeneration(value: DiscoveryRecord): string {
  return `${String(value.pid)}:${value.started_at}:${value.token}`;
}

// harn:assume vscode-copilot-bridge-is-manual-local-and-credential-private ref=vscode-copilot-discovery-client
export function vscodeCopilotBridgeAvailable(
  path = process.env.CODOR_VSCODE_COPILOT_BRIDGE ?? DEFAULT_DISCOVERY,
): boolean {
  return parseDiscovery(path) !== undefined;
}

class BridgeClient {
  constructor(private readonly discoveryPath: string) {}

  private record(): DiscoveryRecord {
    const value = parseDiscovery(this.discoveryPath);
    if (value === undefined) {
      throw new Error('VS Code Copilot bridge is unavailable; install or reload the companion extension');
    }
    return value;
  }

  generation(): string {
    return discoveryGeneration(this.record());
  }

  sameGeneration(generation: string | undefined): boolean {
    if (generation === undefined) return false;
    const current = parseDiscovery(this.discoveryPath);
    return current !== undefined && discoveryGeneration(current) === generation;
  }

  async request(path: string, init: RequestInit = {}, expectedGeneration?: string): Promise<Response> {
    const value = this.record();
    if (expectedGeneration !== undefined && discoveryGeneration(value) !== expectedGeneration) {
      throw new Error('VS Code Copilot bridge generation changed; reload the companion extension');
    }
    const response = await fetch(`http://127.0.0.1:${value.port}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${value.token}`,
        ...(init.body !== undefined && { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.signal !== undefined
        ? { signal: init.signal }
        : path === '/v1/turn'
          ? {}
          : { signal: AbortSignal.timeout(30_000) }),
    });
    if (!response.ok) {
      const message = (await response.text()).slice(0, 1000);
      throw new Error(`VS Code Copilot bridge returned ${response.status}${message ? `: ${message}` : ''}`);
    }
    return response;
  }
}
// harn:end vscode-copilot-bridge-is-manual-local-and-credential-private

function responseText(parts: unknown[] | undefined): string {
  if (parts === undefined) return '';
  return parts.map((part) => {
    if (typeof part === 'string') return part;
    const source = record(part);
    if (typeof source?.value === 'string') return source.value;
    if (typeof source?.text === 'string') return source.text;
    return typeof record(source?.markdown)?.value === 'string'
      ? record(source?.markdown)!.value as string
      : '';
  }).join('');
}

function boundedCheckpointText(value: string): string {
  return value.length <= MAX_CHECKPOINT_CHARS ? value : value.slice(-MAX_CHECKPOINT_CHARS);
}

function boundedNativeResponse(parts: unknown[] | undefined): unknown[] {
  if (parts === undefined) return [];
  const selected: unknown[] = [];
  let used = 0;
  for (const part of parts) {
    let encoded: string;
    try {
      encoded = JSON.stringify(part);
    } catch {
      break;
    }
    if (used + encoded.length > MAX_CHECKPOINT_RESPONSE_CHARS) break;
    selected.push(part);
    used += encoded.length;
  }
  return selected;
}

function boundedHistory(
  history: VscodeSession['history'],
): Array<{ role: 'user' | 'assistant'; text: string }> {
  const selected: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  let used = 0;
  for (const item of [...(history ?? [])].reverse()) {
    if (selected.length >= MAX_HISTORY_ITEMS || used + item.text.length > MAX_HISTORY_CHARS) break;
    selected.unshift(item);
    used += item.text.length;
  }
  return selected;
}

function displayText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const source = record(value);
  if (typeof source?.value === 'string') return source.value;
  if (typeof source?.text === 'string') return source.text;
  return undefined;
}

function nativePath(value: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  if (typeof value === 'string' && (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value))) {
    return value;
  }
  const source = record(value);
  if (source === undefined) return undefined;
  for (const key of ['fsPath', 'path']) {
    if (typeof source[key] === 'string' && source[key] !== '') return source[key] as string;
  }
  for (const nested of Object.values(source)) {
    const found = nativePath(nested, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function* ndjson(response: Response): AsyncIterable<BridgeEvent> {
  if (response.body === null) throw new Error('VS Code Copilot bridge returned no stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  for (;;) {
    const next = await reader.read();
    pending += decoder.decode(next.value, { stream: !next.done });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() !== '') yield JSON.parse(line) as BridgeEvent;
    }
    if (next.done) break;
  }
  if (pending.trim() !== '') yield JSON.parse(pending) as BridgeEvent;
}

// harn:assume vscode-copilot-native-agent-auto-approves-and-streams-evidence ref=vscode-copilot-adapter-runtime
export class CopilotVscodeAdapter implements HarnessAdapter {
  readonly id = 'copilot-vscode';
  readonly capabilities = {
    resume: false,
    discover: false,
    interactiveAttach: false,
    ask: false,
    approvals: 'runtime',
    extensions: false,
    thinking: false,
    live_inbox: false,
    policies: {
      'read-only': null,
      'workspace-write': null,
      'full-access': null,
    },
  } as const;

  private readonly client: BridgeClient;

  constructor(
    private readonly discoveryPath =
      process.env.CODOR_VSCODE_COPILOT_BRIDGE ?? DEFAULT_DISCOVERY,
  ) {
    this.client = new BridgeClient(discoveryPath);
  }

  spawn(opts: SpawnOpts): Session {
    if (opts.thinking !== undefined) {
      throw new Error("adapter 'copilot-vscode' does not support thinking levels");
    }
    if (opts.policy !== undefined && !PolicySchema.safeParse(opts.policy).success) {
      throw new Error(`unknown policy '${opts.policy}'`);
    }
    return {
      harness: this.id,
      session_ref: randomUUID(),
      cwd: opts.cwd,
      model: opts.model,
      policy: opts.policy,
      history: [],
      bridge_generation: this.client.generation(),
    } as VscodeSession;
  }

  /** A non-resumable native chat never has an attachable persisted session. */
  attach(_sessionRef: SessionRef): Session {
    throw new Error("adapter 'copilot-vscode' does not support native session attach");
  }

  /** Used only by the daemon's explicit adapter-id-gated revive branch. */
  canReviveSession(session: Session): boolean {
    const runtime = session as VscodeSession;
    return runtime.harness === this.id
      && runtime.retired !== true
      && this.client.sameGeneration(runtime.bridge_generation);
  }

  // harn:assume vscode-copilot-native-agent-auto-approves-and-streams-evidence ref=vscode-copilot-model-catalog
  async listModels(): Promise<ModelCatalog> {
    const response = await this.client.request('/v1/models');
    const value = await response.json() as { models?: Array<{ id?: unknown }> };
    const models = (value.models ?? [])
      .flatMap((model) => typeof model.id === 'string' && model.id !== '' ? [model.id] : []);
    return { models: [...new Set(models)], source: 'discovered' };
  }
  // harn:end vscode-copilot-native-agent-auto-approves-and-streams-evidence

  async *deliver(
    session: Session,
    payload: string,
    hooks: AdapterTurnHooks = {},
  ): AsyncIterable<WireEvent> {
    const runtime = session as VscodeSession;
    if (runtime.retired === true) {
      yield {
        type: 'run.completed',
        status: 'failed',
        error: 'VS Code Copilot session was retired by an explicit context reset',
      };
      return;
    }
    if (runtime.active_request === true || runtime.active_turn_id !== undefined) {
      yield {
        type: 'run.completed',
        status: 'failed',
        error: 'VS Code Copilot session already has an active turn in flight',
      };
      return;
    }
    runtime.active_request = true;
    let finalText = '';
    let partialText = '';
    let finished = false;
    let terminalStatus: 'completed' | 'failed' | undefined;
    const toolCalls = new Set<number>();
    const toolResults = new Set<number>();
    const fileChanges = new Set<number>();
    try {
      // harn:assume vscode-copilot-recoverable-native-failure-preserves-context ref=vscode-copilot-session-checkpoint
      // A checkpoint is a one-shot continuation input. Consume it only after
      // revalidating the exact session generation, and clear it on every path
      // so a failed request cannot replay a native tool or prompt forever.
      const checkpoint = runtime.failure_checkpoint;
      if (checkpoint !== undefined) {
        runtime.failure_checkpoint = undefined;
        if (
          runtime.bridge_generation !== checkpoint.bridge_generation
          || !this.client.sameGeneration(checkpoint.bridge_generation)
        ) {
          throw new Error(
            'VS Code Copilot recoverable context was lost with its bridge generation; '
            + 'reload the companion extension before continuing',
          );
        }
        runtime.history = boundedHistory([
          ...(runtime.history ?? []),
          { role: 'user', text: checkpoint.prompt },
          { role: 'assistant', text: checkpoint.response },
        ]);
      }
      // harn:end vscode-copilot-recoverable-native-failure-preserves-context
      const response = await this.client.request('/v1/turn', {
        method: 'POST',
        body: JSON.stringify({
          prompt: payload,
          ...(session.model !== undefined && { model: session.model }),
          history: boundedHistory(runtime.history),
        }),
      }, runtime.bridge_generation);
      for await (const event of ndjson(response)) {
        if (event.type === 'started' && typeof event.turn_id === 'string') {
          runtime.active_turn_id = event.turn_id;
          hooks.onStarted?.({});
          if (session.session_ref !== undefined) hooks.onSessionRef?.(session.session_ref);
        } else if (event.type === 'part' && typeof event.text_delta === 'string') {
          partialText = boundedCheckpointText(partialText + event.text_delta);
          yield { type: 'run.item', item_type: 'text_delta', payload: { text: event.text_delta } };
        } else if (event.type === 'part' && typeof event.index === 'number') {
          const part = record(event.part);
          if (part === undefined) continue;
          const kind = typeof part?.kind === 'string' ? part.kind : '';
          if (kind === 'toolInvocation') {
            const callId = `${runtime.active_turn_id ?? 'vscode'}:${event.index}`;
            const tool = typeof part.toolId === 'string' ? part.toolId : 'native-tool';
            if (!toolCalls.has(event.index)) {
              toolCalls.add(event.index);
              yield {
                type: 'run.item',
                item_type: 'tool_call',
                payload: {
                  call_id: callId,
                  tool,
                  title: displayText(part.invocationMessage) ?? tool,
                },
              };
            }
            const state = JSON.stringify(part.state ?? '').toLowerCase();
            if (
              !toolResults.has(event.index)
              && (state.includes('completed') || state.includes('error') || state.includes('failed'))
            ) {
              toolResults.add(event.index);
              yield {
                type: 'run.item',
                item_type: 'tool_result',
                payload: {
                  call_id: callId,
                  status: state.includes('error') || state.includes('failed') ? 'error' : 'ok',
                  ...(displayText(part.pastTenseMessage) !== undefined && {
                    output_text: displayText(part.pastTenseMessage),
                  }),
                },
              };
            }
          } else if (
            !fileChanges.has(event.index)
            && (kind.toLowerCase().includes('textedit') || kind.toLowerCase().includes('notebookedit'))
          ) {
            const path = nativePath(part);
            if (path !== undefined) {
              fileChanges.add(event.index);
              yield {
                type: 'run.item',
                item_type: 'file_change',
                payload: { path, change: 'modified' },
              };
            }
          }
        } else if (event.type === 'confirmation') {
          throw new Error(
            'VS Code Copilot bridge emitted an unsupported approval event; reload the companion extension',
          );
        } else if (event.type === 'done') {
          finalText = responseText(event.response);
          const result = record(event.result);
          const failed = result?.errorDetails !== undefined || result?.error !== undefined;
          terminalStatus = failed ? 'failed' : 'completed';
          yield {
            type: 'run.completed',
            status: failed ? 'failed' : 'completed',
            ...(finalText !== '' && { final_text: finalText }),
            ...(failed && { error: 'VS Code Copilot reported a failed native turn' }),
          };
          finished = true;
        } else if (event.type === 'error') {
          // harn:assume vscode-copilot-recoverable-native-failure-preserves-context ref=vscode-copilot-session-checkpoint
          const recoverable = event.recoverable === true
            && runtime.bridge_generation !== undefined
            && this.client.sameGeneration(runtime.bridge_generation);
          if (recoverable) {
            const response = event.response;
            runtime.failure_checkpoint = {
              prompt: payload,
              response: boundedCheckpointText(
                event.assistant_text
                  ?? (partialText !== '' ? partialText : responseText(response)),
              ),
              native_response: boundedNativeResponse(response),
              bridge_generation: runtime.bridge_generation!,
            };
          }
          yield {
            type: 'run.completed',
            status: 'failed',
            error: event.message?.slice(0, 1000) || 'VS Code Copilot turn failed',
            ...(recoverable && { recoverable: true }),
          };
          terminalStatus = 'failed';
          finished = true;
          // harn:end vscode-copilot-recoverable-native-failure-preserves-context
        }
      }
      if (!finished) {
        yield {
          type: 'run.completed',
          status: 'failed',
          error: 'VS Code Copilot bridge ended without a terminal result',
        };
      } else if (terminalStatus === 'completed' && finalText !== '') {
        runtime.history = boundedHistory([
          ...(runtime.history ?? []),
          { role: 'user', text: payload },
          { role: 'assistant', text: finalText },
        ]);
      }
    } catch (error) {
      yield {
        type: 'run.completed',
        status: 'failed',
        error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
      };
    } finally {
      runtime.active_request = false;
      runtime.active_turn_id = undefined;
    }
  }

  /** Native approval never crosses the bridge; this method exists for the common adapter contract. */
  respondInteraction(_session: Session, _interactionId: string, _answer: unknown): Promise<void> {
    return Promise.reject(new Error('copilot-vscode native approvals are handled inside the VS Code bridge'));
  }

  interrupt(session: Session): void {
    const turnId = (session as VscodeSession).active_turn_id;
    if (turnId === undefined) return;
    void this.client.request(`/v1/turn/${encodeURIComponent(turnId)}/cancel`, {
      method: 'POST',
      body: '{}',
    }).catch(() => undefined);
  }

  // harn:assume member-context-reset-is-authorized-atomic-and-lazy ref=copilot-vscode-session-reset
  /** Retire only this adapter's local conversation; the shared bridge is foreign. */
  async resetSession(session: Session | undefined): Promise<void> {
    if (session === undefined) return;
    const runtime = session as VscodeSession;
    if (runtime.harness !== this.id || runtime.retired === true) return;
    if (runtime.active_request === true || runtime.active_turn_id !== undefined) {
      throw new Error('cannot clear VS Code Copilot context while an active turn is in-flight');
    }
    runtime.history = [];
    runtime.failure_checkpoint = undefined;
    runtime.retired = true;
  }
  // harn:end member-context-reset-is-authorized-atomic-and-lazy

  discoverSessions(): SessionRef[] {
    return [];
  }
}
// harn:end vscode-copilot-native-agent-auto-approves-and-streams-evidence
