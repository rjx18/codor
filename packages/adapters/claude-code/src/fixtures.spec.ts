import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// harn:assume claude-sdk-message-contract-preserves-normalized-runs ref=claude-sdk-message-regression
// These immutable historical captures contain the same message-object envelopes
// the Agent SDK yields. Runtime adapter tests use an injected Query factory; the
// captures remain transport-free evidence for translator and resume semantics.
// The stdin files below are historical protocol evidence only, not the active
// permission implementation.

type ClaudeEvent = {
  type: string;
  subtype?: string;
  session_id?: string;
  request_id?: string;
  request?: {
    subtype: string;
    tool_name?: string;
    input?: { questions?: { question: string; options: { label: string }[]; multiSelect?: boolean }[] };
    tool_use_id?: string;
    requires_user_interaction?: boolean;
    permission_suggestions?: unknown[];
    blocked_path?: string;
  };
  response?: {
    subtype: string;
    request_id: string;
    response?: { behavior?: string; message?: string; updatedInput?: { answers?: Record<string, string> } };
  };
  message?: { id?: string; content: ({ type: string; text?: string; name?: string } | string)[] };
  tools?: string[];
  result?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  permission_denials?: { tool_name: string }[];
};

function events(name: string): ClaudeEvent[] {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ClaudeEvent);
}

const init = (evs: ClaudeEvent[]) => evs.find((e) => e.type === 'system' && e.subtype === 'init');
const result = (evs: ClaudeEvent[]) => evs.find((e) => e.type === 'result');
const controlRequests = (evs: ClaudeEvent[]) => evs.filter((e) => e.type === 'control_request');
const finalText = (evs: ClaudeEvent[]) => result(evs)?.result;

describe('claude fixtures parse as JSONL with a single init', () => {
  for (const name of [
    'pong.jsonl',
    'resume.jsonl',
    'ask-user-question.jsonl',
    'permission-deny.jsonl',
    'hooks-subagent.jsonl',
    'kill-during-ask.jsonl',
    'kill-during-ask-resume.jsonl',
    'answered-then-kill.jsonl',
    'answered-then-kill-resume.jsonl',
  ]) {
    it(`${name} parses and contains exactly one system/init with a session_id`, () => {
      const evs = events(name);
      const inits = evs.filter((e) => e.type === 'system' && e.subtype === 'init');
      expect(inits).toHaveLength(1);
      expect(inits[0]!.session_id).toMatch(/^[0-9a-f-]{36}$/);
    });
  }

  it('init is NOT guaranteed to be the first event (user hooks precede it)', () => {
    expect(events('pong.jsonl')[0]!.type).toBe('system');
    expect(events('pong.jsonl')[0]!.subtype).toBe('hook_started');
  });
});

describe('pong turn', () => {
  const evs = events('pong.jsonl');

  it('result carries final text, dollar cost, usage, and the init session_id', () => {
    const res = result(evs)!;
    expect(res.subtype).toBe('success');
    expect(res.result).toBe('PONG');
    expect(res.total_cost_usd).toBeTypeOf('number');
    expect(res.usage?.input_tokens).toBeTypeOf('number');
    expect(res.session_id).toBe(init(evs)!.session_id);
  });

  it('assistant events wrap full API message envelopes', () => {
    const assistant = evs.filter((e) => e.type === 'assistant');
    expect(assistant.length).toBeGreaterThan(0);
    const texts = assistant.flatMap((e) =>
      e.message!.content.filter((b): b is { type: string; text?: string } => typeof b !== 'string'),
    );
    expect(texts.some((b) => b.type === 'text' && b.text === 'PONG')).toBe(true);
  });
});

describe('resume', () => {
  it('--resume KEEPS the same session_id and retains context', () => {
    const evs = events('resume.jsonl');
    expect(init(evs)!.session_id).toBe(init(events('pong.jsonl'))!.session_id);
    expect(finalText(evs)).toBe('PONG');
  });
});

describe('AskUserQuestion control protocol', () => {
  const evs = events('ask-user-question.jsonl');
  const stdin = events('ask-user-question.stdin.jsonl');
  const req = controlRequests(evs)[0]!;

  it('the ask arrives as a can_use_tool control_request with the question card', () => {
    expect(req.request!.subtype).toBe('can_use_tool');
    expect(req.request!.tool_name).toBe('AskUserQuestion');
    expect(req.request!.requires_user_interaction).toBe(true);
    expect(req.request!.tool_use_id).toMatch(/^toolu_/);
    const q = req.request!.input!.questions![0]!;
    expect(q.question).toBe('Which codeword?');
    expect(q.options.map((o) => o.label)).toEqual(['ALPHA', 'BETA']);
  });

  it('the answer is a control_response with updatedInput.answers keyed by question text', () => {
    const resp = stdin.find((e) => e.type === 'control_response')!;
    expect(resp.response!.subtype).toBe('success');
    expect(resp.response!.request_id).toBe(req.request_id);
    expect(resp.response!.response!.behavior).toBe('allow');
    expect(resp.response!.response!.updatedInput!.answers).toEqual({ 'Which codeword?': 'ALPHA' });
  });

  it('the answered ask unblocks the turn through to the final result', () => {
    expect(finalText(evs)).toBe('ALPHA');
  });
});

describe('permission request (runtime approval)', () => {
  const evs = events('permission-deny.jsonl');
  const stdin = events('permission-deny.stdin.jsonl');
  const req = controlRequests(evs)[0]!;

  it('the Bash attempt arrives as can_use_tool with suggestions and blocked_path', () => {
    expect(req.request!.subtype).toBe('can_use_tool');
    expect(req.request!.tool_name).toBe('Bash');
    expect(req.request!.permission_suggestions!.length).toBeGreaterThan(0);
    expect(req.request!.blocked_path).toContain('probe-permission.txt');
  });

  it('a deny response lets the turn complete and is recorded in permission_denials', () => {
    const resp = stdin.find((e) => e.type === 'control_response')!;
    expect(resp.response!.response!.behavior).toBe('deny');
    const res = result(evs)!;
    expect(res.result).toBe('DENIED');
    expect(res.permission_denials).toEqual([
      expect.objectContaining({ tool_name: 'Bash' }),
    ]);
  });
});

describe('subagent hooks (extensions source)', () => {
  const stream = events('hooks-subagent.jsonl');
  const log = events('hooks-log.jsonl') as unknown as Record<string, unknown>[];

  it('SubagentStart/SubagentStop hooks fire with agent id, type, and transcripts', () => {
    expect(log.map((h) => h.hook_event_name)).toEqual(['SubagentStart', 'SubagentStop']);
    const [start, stop] = log as [Record<string, unknown>, Record<string, unknown>];
    expect(start.agent_id).toBe(stop.agent_id);
    expect(start.agent_type).toBe('general-purpose');
    expect(stop.last_assistant_message).toBe('PONG');
    expect(stop.agent_transcript_path).toContain(`agent-${String(start.agent_id)}.jsonl`);
    expect(start.session_id).toBe(init(stream)!.session_id);
  });

  it('the parent stream shows the spawn (tool_use "Agent") but not subagent internals', () => {
    const blocks = stream
      .filter((e) => e.type === 'assistant')
      .flatMap((e) => e.message!.content)
      .filter((b): b is { type: string; name?: string } => typeof b !== 'string');
    expect(blocks.some((b) => b.type === 'tool_use' && b.name === 'Agent')).toBe(true);
  });
});

describe('crash boundary: killed while ask pending', () => {
  const killed = events('kill-during-ask.jsonl');
  const resumed = events('kill-during-ask-resume.jsonl');

  it('the killed stream ends at the unanswered control_request — no result event', () => {
    expect(killed.at(-1)!.type).toBe('control_request');
    expect(result(killed)).toBeUndefined();
    expect(events('kill-during-ask.stdin.jsonl')).toHaveLength(1); // only the user message
  });

  it('on resume the ask RE-RAISES with fresh native ids', () => {
    expect(init(resumed)!.session_id).toBe(init(killed)!.session_id);
    const [before] = controlRequests(killed);
    const [after] = controlRequests(resumed);
    expect(after!.request!.tool_name).toBe('AskUserQuestion');
    expect(after!.request!.input!.questions![0]!.question).toBe(
      before!.request!.input!.questions![0]!.question,
    );
    expect(after!.request_id).not.toBe(before!.request_id);
    expect(after!.request!.tool_use_id).not.toBe(before!.request!.tool_use_id);
  });

  it('answering the re-raised ask completes the turn', () => {
    expect(finalText(resumed)).toBe('GAMMA');
  });
});

describe('crash boundary: answered but not acked', () => {
  const killed = events('answered-then-kill.jsonl');
  const resumed = events('answered-then-kill-resume.jsonl');

  it('the answer written right before the kill did NOT survive — no result event', () => {
    const stdin = events('answered-then-kill.stdin.jsonl');
    expect(stdin.some((e) => e.type === 'control_response')).toBe(true); // we DID answer
    expect(result(killed)).toBeUndefined();
  });

  it('the ask re-raises on resume and REPLAYING the stored answer is idempotent', () => {
    expect(init(resumed)!.session_id).toBe(init(killed)!.session_id);
    const [before] = controlRequests(killed);
    const [after] = controlRequests(resumed);
    expect(after!.request_id).not.toBe(before!.request_id);
    const replay = events('answered-then-kill-resume.stdin.jsonl').find(
      (e) => e.type === 'control_response',
    )!;
    expect(replay.response!.response!.updatedInput!.answers).toEqual({
      'Which codeword?': 'EPSILON',
    });
    expect(finalText(resumed)).toBe('EPSILON');
  });
});
// harn:end claude-sdk-message-contract-preserves-normalized-runs
