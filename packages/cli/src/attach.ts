import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import type { AttachLease, Member } from '@codor/protocol';

import type { ProtocolClient } from './connection.js';

export interface InteractiveCommand {
  command: string;
  args: string[];
}

export type InteractiveCommandResolver = (
  member: Member,
  env: NodeJS.ProcessEnv,
) => InteractiveCommand;

export type InteractiveSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

// harn:assume attach-custody-lease-tracks-child-pid ref=interactive-child-supervision
export const nativeResumeCommand: InteractiveCommandResolver = (member, env) => {
  if (!member.session_ref) throw new Error(`member @${member.handle} has no resumable session`);
  if (member.harness === 'claude-code') {
    return {
      command: env.CODOR_CLAUDE_COMMAND ?? 'claude',
      args: ['--resume', member.session_ref],
    };
  }
  if (member.harness === 'codex') {
    return {
      command: env.CODOR_CODEX_COMMAND ?? 'codex',
      args: ['resume', member.session_ref],
    };
  }
  if (member.harness === 'gemini') {
    return {
      command: env.CODOR_GEMINI_COMMAND ?? 'gemini',
      args: ['--resume', member.session_ref],
    };
  }
  if (member.harness === 'opencode') {
    return {
      command: env.CODOR_OPENCODE_COMMAND ?? 'opencode',
      args: ['--session', member.session_ref],
    };
  }
  if (member.harness === 'copilot') {
    return {
      command: env.CODOR_COPILOT_COMMAND ?? 'copilot',
      args: ['--resume', member.session_ref],
    };
  }
  if (member.harness === 'grok') {
    return {
      command: env.CODOR_GROK_COMMAND ?? 'grok',
      args: ['--resume', member.session_ref],
    };
  }
  throw new Error(`adapter '${member.harness ?? 'unknown'}' has no interactive resume command`);
};

async function nextAttachFrame(
  client: ProtocolClient,
  memberId: string,
  statuses: Set<'child_recorded' | 'completed' | 'uncertain'>,
) {
  for (;;) {
    const frame = await client.next(30_000);
    if (frame.type === 'error') throw new Error(frame.message);
    if (
      frame.type === 'attach_lease' &&
      frame.member.id === memberId &&
      statuses.has(frame.status as 'child_recorded' | 'completed' | 'uncertain')
    ) {
      return frame;
    }
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export async function superviseInteractiveAttach(input: {
  client: ProtocolClient;
  room: string;
  member: Member;
  lease: AttachLease;
  env?: NodeJS.ProcessEnv;
  commandResolver?: InteractiveCommandResolver;
  spawnChild?: InteractiveSpawner;
  heartbeatMs?: number;
}): Promise<{ status: 'completed' | 'uncertain'; code: number | null; signal: NodeJS.Signals | null }> {
  const resolveCommand = input.commandResolver ?? nativeResumeCommand;
  const spawnChild = input.spawnChild ?? spawn;
  const resume = resolveCommand(input.member, input.env ?? process.env);
  const child = spawnChild(resume.command, resume.args, {
    cwd: input.member.cwd ?? process.cwd(),
    stdio: 'inherit',
    detached: true,
  });
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let heartbeat: NodeJS.Timeout | undefined;
  const forwardInterrupt = (): void => signalProcessGroup(child, 'SIGINT');
  const forwardTerminate = (): void => signalProcessGroup(child, 'SIGTERM');
  let exit = { code: null as number | null, signal: null as NodeJS.Signals | null };
  let failure: unknown;

  try {
    await spawned;
    if (child.pid === undefined) throw new Error('interactive child started without a pid');
    input.client.send({
      type: 'act',
      room: input.room,
      act: {
        act: 'attach_child',
        lease_id: input.lease.id,
        child_pid: child.pid,
        process_group_id: child.pid,
      },
    });
    await nextAttachFrame(input.client, input.member.id, new Set(['child_recorded']));
    process.on('SIGINT', forwardInterrupt);
    process.on('SIGTERM', forwardTerminate);
    heartbeat = setInterval(() => {
      try {
        input.client.send({
          type: 'act',
          room: input.room,
          act: { act: 'attach_heartbeat', lease_id: input.lease.id },
        });
      } catch {
        // Lease expiry is the daemon's fail-closed recovery path.
      }
    }, input.heartbeatMs ?? 1_000);
    heartbeat.unref();
    exit = await closed;
  } catch (error) {
    failure = error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    process.off('SIGINT', forwardInterrupt);
    process.off('SIGTERM', forwardTerminate);
    input.client.send({
      type: 'act',
      room: input.room,
      act: { act: 'attach_complete', lease_id: input.lease.id },
    });
  }

  const completed = await nextAttachFrame(
    input.client,
    input.member.id,
    new Set(['completed', 'uncertain']),
  );
  if (failure) throw failure;
  return { status: completed.status as 'completed' | 'uncertain', ...exit };
}
// harn:end attach-custody-lease-tracks-child-pid
