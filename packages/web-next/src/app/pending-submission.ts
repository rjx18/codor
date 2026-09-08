import type { PostFrame, ServerFrame } from '@codor/protocol';

export type SubmissionResult =
  | Extract<ServerFrame, { type: 'post_accepted' }>
  | Extract<ServerFrame, { type: 'error' }>;

// harn:assume pending-submission-retries-only-through-ready-owner ref=p6-pending-submission-retries-only-through-ready-owner
/** One already-dispatched operation, never an offline queue. The connector
 * supplies readiness and generation; this slot owns no timers or credentials. */
export class PendingSubmission {
  private pending?: {
    frame: PostFrame;
    generation: number;
    result?: (result: SubmissionResult) => void;
  };

  get room(): string | undefined { return this.pending?.frame.room; }
  get active(): boolean { return this.pending !== undefined; }

  post(frame: PostFrame, generation: number, send: (frame: PostFrame) => boolean,
    result?: (result: SubmissionResult) => void): boolean {
    if (this.pending !== undefined || frame.submission_id === undefined) return false;
    const frozen = JSON.parse(JSON.stringify(frame)) as PostFrame;
    if (frozen.attachments) Object.freeze(frozen.attachments);
    if (frozen.voice) { Object.freeze(frozen.voice.levels); Object.freeze(frozen.voice); }
    Object.freeze(frozen);
    const pending = { frame: frozen, generation, result };
    this.pending = pending;
    if (send(frozen)) return true;
    if (this.pending === pending) this.pending = undefined;
    return false;
  }

  /** Called only on the origin room's current authenticated sync_complete. */
  ready(room: string, generation: number, send: (frame: PostFrame) => boolean): void {
    const pending = this.pending;
    if (!pending || pending.frame.room !== room || pending.generation === generation) return;
    pending.generation = generation;
    send(pending.frame);
  }

  receive(frame: ServerFrame): string | undefined {
    if (frame.type !== 'post_accepted' && frame.type !== 'error') return;
    const pending = this.pending;
    if (!pending || frame.submission_id !== pending.frame.submission_id
      || frame.origin_room !== pending.frame.room) return;
    this.pending = undefined;
    pending.result?.(frame);
    return pending.frame.room;
  }

  dispose(): void { this.pending = undefined; }
}
// harn:end pending-submission-retries-only-through-ready-owner
