import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// harn:assume acp-v1-events-and-capabilities-are-negotiated ref=acp-fake-agent
const args = process.argv.slice(2);
const supportsResume = !args.includes('--no-resume');
const supportsLoad = !args.includes('--no-load');
const waitForCancel = args.includes('--wait');
const failPrompt = args.includes('--fail');
const noPermission = args.includes('--no-permission');
const limitStop = args.includes('--max-tokens')
  ? 'max_tokens'
  : args.includes('--max-turn-requests')
    ? 'max_turn_requests'
    : 'end_turn';
const logIndex = args.indexOf('--log');
const logPath = logIndex >= 0 ? args[logIndex + 1] : undefined;
const initialTurnsIndex = args.indexOf('--initial-turns');
const initialTurns = initialTurnsIndex >= 0 ? Number(args[initialTurnsIndex + 1]) : 0;
const sessionId = 'fake-acp-session';
let promptRequest;
let permissionRequestId = 900;
let completedTurns = Number.isSafeInteger(initialTurns) && initialTurns >= 0 ? initialTurns : 0;

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });
const error = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32603, message } });
const note = (update) => send({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId, update },
});
const log = (method) => {
  if (logPath) appendFileSync(logPath, `${method}\n`);
};

function finishPrompt(permission) {
  note({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: permission?.outcome === 'selected' ? 'approved' : 'cancelled' },
  });
  completedTurns += 1;
  const laterTurns = completedTurns - 1;
  result(promptRequest, {
    stopReason: limitStop,
    usage: {
      totalTokens: 20 + (13 * laterTurns),
      inputTokens: 10 + (6 * laterTurns),
      outputTokens: 5 + (4 * laterTurns),
      cachedReadTokens: 3 + (2 * laterTurns),
      cachedWriteTokens: 2 + laterTurns,
    },
  });
  promptRequest = undefined;
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method) log(message.method);
  if (message.method === 'initialize') {
    result(message.id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: supportsLoad,
        sessionCapabilities: supportsResume ? { resume: {} } : {},
      },
      agentInfo: { name: 'Hermetic ACP', version: '1.0.0' },
    });
  } else if (message.method === 'session/new') {
    result(message.id, { sessionId });
  } else if (message.method === 'session/resume') {
    supportsResume ? result(message.id, {}) : error(message.id, 'resume unsupported');
  } else if (message.method === 'session/load') {
    supportsLoad ? result(message.id, {}) : error(message.id, 'load unsupported');
  } else if (message.method === 'session/prompt') {
    if (failPrompt) {
      error(message.id, 'synthetic prompt failure');
      return;
    }
    promptRequest = message.id;
    if (waitForCancel) return;
    note({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'checking' },
    });
    note({
      sessionUpdate: 'plan',
      entries: [{ content: 'edit fixture', priority: 'high', status: 'in_progress' }],
    });
    note({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'Edit fixture',
      kind: 'edit',
      status: 'in_progress',
      rawInput: { path: 'fixture.txt' },
    });
    note({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'completed',
      content: [{ type: 'diff', path: 'fixture.txt', oldText: 'old\n', newText: 'new\n' }],
      rawOutput: { changed: true },
    });
    note({ sessionUpdate: 'usage_update', used: 12, size: 100 });
    if (noPermission) {
      finishPrompt({ outcome: 'selected' });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: permissionRequestId,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 'tool-2', title: 'Run tests', kind: 'execute' },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
  } else if (message.method === 'session/cancel') {
    if (promptRequest !== undefined) {
      result(promptRequest, { stopReason: 'cancelled' });
      promptRequest = undefined;
    }
  } else if (message.id === permissionRequestId) {
    finishPrompt(message.result?.outcome);
    permissionRequestId += 1;
  }
});
// harn:end acp-v1-events-and-capabilities-are-negotiated
