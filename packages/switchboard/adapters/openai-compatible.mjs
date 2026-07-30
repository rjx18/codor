import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const MAX_ERROR_BYTES = 8 * 1024;
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

const PROVIDERS = Object.freeze({
  ollama: Object.freeze({
    endpoint: 'http://127.0.0.1:11434/v1',
    label: 'Ollama',
  }),
  nvidia: Object.freeze({
    endpoint: 'https://integrate.api.nvidia.com/v1',
    label: 'NVIDIA NIM',
    models: Object.freeze([
      'meta/llama-4-maverick-17b-128e-instruct',
      'meta/llama-3.3-70b-instruct',
    ]),
  }),
});

function boundedText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  const bytes = Buffer.from(text);
  return bytes.byteLength <= MAX_ERROR_BYTES
    ? text
    : `${bytes.subarray(0, MAX_ERROR_BYTES).toString('utf8')}\n[truncated]`;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function modelIds(payload) {
  const data = Array.isArray(record(payload)?.data) ? record(payload).data : [];
  return data
    .map((entry) => record(entry)?.id)
    .filter((id) => typeof id === 'string' && id !== '' && !/embed/i.test(id));
}

function responseText(payload) {
  const choice = Array.isArray(record(payload)?.choices) ? record(payload).choices[0] : undefined;
  const message = record(record(choice)?.message);
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => record(part)?.text)
    .filter((text) => typeof text === 'string')
    .join('');
}

function responseUsage(payload) {
  const usage = record(record(payload)?.usage);
  if (usage === undefined) return undefined;
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  return typeof input === 'number' && typeof output === 'number'
    ? { input_tokens: input, output_tokens: output }
    : undefined;
}

function keychainSecret(service, account, execFile = execFileSync) {
  if (service === '') {
    throw new Error(
      'NVIDIA credential is not configured. Set CODOR_NVIDIA_KEYCHAIN_SERVICE ' +
      'to a dedicated Keychain service after rotating the exposed legacy key.',
    );
  }
  const args = ['find-generic-password', '-s', service];
  if (account !== '') args.push('-a', account);
  args.push('-w');
  try {
    const secret = execFile('/usr/bin/security', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
    if (secret === '') throw new Error('empty credential');
    return secret;
  } catch {
    throw new Error(
      `NVIDIA credential was not available from Keychain service '${service}'` +
      (account === '' ? '' : ` for account '${account}'`),
    );
  }
}

function nvidiaApiKey(env, execFile) {
  return keychainSecret(
    env.CODOR_NVIDIA_KEYCHAIN_SERVICE?.trim() ?? '',
    env.CODOR_NVIDIA_KEYCHAIN_ACCOUNT?.trim() ?? '',
    execFile,
  );
}

async function jsonRequest(fetcher, url, init) {
  const response = await fetcher(url, init);
  const text = await response.text();
  let payload;
  try {
    payload = text === '' ? {} : JSON.parse(text);
  } catch {
    throw new Error(`provider returned invalid JSON (${response.status}): ${boundedText(text)}`);
  }
  if (!response.ok) {
    const error = record(record(payload)?.error);
    const detail = error?.message ?? record(payload)?.message ?? payload;
    throw new Error(`provider request failed (${response.status}): ${boundedText(detail)}`);
  }
  return payload;
}

export function createOpenAICompatibleAdapter(options) {
  const provider = PROVIDERS[options.id];
  if (provider === undefined) {
    throw new Error(`unsupported OpenAI-compatible provider '${options.id}'`);
  }
  const fetcher = options.fetcher ?? globalThis.fetch;
  const env = options.env ?? process.env;
  const execFile = options.execFile ?? execFileSync;
  const controllers = new WeakMap();

  return {
    id: options.id,
    capabilities: {
      // The provider is stateless; Codor's routed channel context is the durable
      // resume surface, so a member can be reconstructed after a daemon restart.
      resume: true,
      discover: false,
      interactiveAttach: false,
      ask: false,
      approvals: 'spawn-time',
      extensions: false,
      thinking: false,
      live_inbox: false,
      // Chat-completion providers receive no filesystem tools. All three labels
      // therefore map to the same honest native capability: chat-only.
      policies: {
        'read-only': 'chat-only',
        'workspace-write': null,
        'full-access': null,
      },
    },

    spawn(spawnOptions) {
      return {
        harness: options.id,
        session_ref: randomUUID(),
        cwd: spawnOptions.cwd,
        model: spawnOptions.model,
        policy: 'read-only',
      };
    },

    attach(sessionRef) {
      return {
        harness: options.id,
        session_ref: sessionRef,
        cwd: process.cwd(),
        policy: 'read-only',
      };
    },

    async listModels() {
      if (provider.models !== undefined) {
        return { models: [...provider.models], source: 'curated' };
      }
      const payload = await jsonRequest(fetcher, `${provider.endpoint}/models`, {
        headers: { accept: 'application/json' },
      });
      return { models: modelIds(payload), source: 'discovered' };
    },

    async *deliver(session, prompt, hooks = {}) {
      if (session.model === undefined || session.model.trim() === '') {
        yield {
          type: 'run.completed',
          status: 'failed',
          error: `Choose an exact ${provider.label} model before sending a turn.`,
        };
        return;
      }

      const controller = new AbortController();
      controllers.set(session, controller);
      const timeout = setTimeout(() => controller.abort('timeout'), TURN_TIMEOUT_MS);
      hooks.onStarted?.({});
      if (session.session_ref !== undefined) hooks.onSessionRef?.(session.session_ref);

      try {
        const headers = {
          accept: 'application/json',
          'content-type': 'application/json',
        };
        if (options.id === 'nvidia') {
          headers.authorization = `Bearer ${nvidiaApiKey(env, execFile)}`;
        }
        const payload = await jsonRequest(fetcher, `${provider.endpoint}/chat/completions`, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: session.model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
          }),
        });
        const text = responseText(payload);
        if (text !== '') {
          yield { type: 'run.item', item_type: 'text_delta', payload: { text } };
        }
        const usage = responseUsage(payload);
        yield {
          type: 'run.completed',
          status: 'completed',
          model: typeof payload.model === 'string' ? payload.model : session.model,
          ...(text !== '' && { final_text: text }),
          ...(usage !== undefined && { usage }),
        };
      } catch (error) {
        const interrupted = controller.signal.aborted;
        yield {
          type: 'run.completed',
          status: interrupted ? 'interrupted' : 'failed',
          ...(!interrupted && {
            error: error instanceof Error ? error.message : 'OpenAI-compatible provider failed',
          }),
        };
      } finally {
        clearTimeout(timeout);
        controllers.delete(session);
      }
    },

    async respondInteraction() {
      throw new Error(`${provider.label} chat completion has no interaction response channel`);
    },

    interrupt(session) {
      controllers.get(session)?.abort('operator interrupt');
    },

    discoverSessions() {
      return [];
    },
  };
}

export function createAdapter({ id }) {
  return createOpenAICompatibleAdapter({ id });
}
