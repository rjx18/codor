import type { PostFrame, ServerFrame } from '@codor/protocol';

export type SubmissionResult =
  | Extract<ServerFrame, { type: 'post_accepted' }>
  | Extract<ServerFrame, { type: 'error' }>
  | { type: 'post_wait_stopped'; origin_room: string; submission_id: string };

// harn:assume pending-submission-retries-only-through-ready-owner-v3 ref=p6-pending-submission-retries-only-through-ready-owner-v2
/** Independent already-dispatched operations, never an offline queue. The
 * connector supplies readiness/generation; this registry owns no timers. */
export class PendingSubmission {
  private pending = new Map<string, {
    frame: PostFrame;
    generation: number;
    result?: (result: SubmissionResult) => void;
  }>();

  get room(): string | undefined { return this.rooms[0]; }
  get rooms(): string[] { return [...new Set([...this.pending.values()].map(p => p.frame.room))]; }
  get active(): boolean { return this.pending.size > 0; }
  settleCanonical(id: string): void { this.pending.delete(id); }

  post(frame: PostFrame, generation: number, send: (frame: PostFrame) => boolean,
    result?: (result: SubmissionResult) => void): boolean {
    if (frame.submission_id === undefined || this.pending.has(frame.submission_id)) return false;
    const frozen = JSON.parse(JSON.stringify(frame)) as PostFrame;
    if (frozen.attachments) Object.freeze(frozen.attachments);
    if (frozen.voice) { Object.freeze(frozen.voice.levels); Object.freeze(frozen.voice); }
    Object.freeze(frozen);
    const pending = { frame: frozen, generation, result };
    this.pending.set(frame.submission_id, pending);
    if (send(frozen)) return true;
    if (this.pending.get(frame.submission_id) === pending) this.pending.delete(frame.submission_id);
    return false;
  }

  /** Called only on the origin room's current authenticated sync_complete. */
  ready(room: string, generation: number, send: (frame: PostFrame) => boolean,
    mayRetry: (id: string) => boolean = () => true): void {
    for (const pending of this.pending.values()) {
      if (pending.frame.room !== room || pending.generation === generation || !mayRetry(pending.frame.submission_id!)) continue;
      pending.generation = generation;
      send(pending.frame);
    }
  }

  receive(frame: ServerFrame): string | undefined {
    if (frame.type !== 'post_accepted' && frame.type !== 'error') return;
    const pending = frame.submission_id === undefined ? undefined : this.pending.get(frame.submission_id);
    if (!pending || frame.submission_id !== pending.frame.submission_id
      || frame.origin_room !== pending.frame.room) return;
    this.pending.delete(frame.submission_id!);
    pending.result?.(frame);
    return pending.frame.room;
  }

  // harn:assume unsupported-submissions-can-stop-local-wait-v3 ref=stop-local-submission-wait
  stopWaiting(room: string, id: string): boolean {
    const pending = this.pending.get(id);
    if (!pending || pending.frame.room !== room || pending.frame.submission_id !== id) return false;
    this.pending.delete(id);
    pending.result?.({ type: 'post_wait_stopped', origin_room: room, submission_id: id });
    return true;
  }
  // harn:end unsupported-submissions-can-stop-local-wait-v3

  dispose(): void { this.pending.clear(); }
}
// harn:end pending-submission-retries-only-through-ready-owner-v3
