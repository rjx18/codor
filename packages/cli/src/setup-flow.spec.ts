import { describe, expect, it } from 'vitest';

import { SetupFlow } from './setup-flow.js';

const flow = () => new SetupFlow([
  { title: 'Check this computer' },
  { title: 'Prepare private files' },
  { title: 'Choose access', kind: 'choice' },
  { title: 'Start Codor' },
  { title: 'Create pairing code' },
]);

describe('running a step at most once', () => {
  it('marks a pending active step as needing a run, and a done step as not', () => {
    const f = flow();
    expect(f.activeNeedsRun).toBe(true);
    f.markRunning(0);
    f.markDone(0, { checked: true });
    expect(f.activeNeedsRun).toBe(false);
  });

  it('memoizes the exact result object of a completed step', () => {
    const f = flow();
    const offer = { code: 'ABCD-2345' };
    f.markDone(4, offer);
    expect(f.steps[4]!.result).toBe(offer);
  });
});

describe('Next advances only a settled step and never re-runs', () => {
  it('cannot advance while the active step is pending or running', () => {
    const f = flow();
    expect(f.canNext).toBe(false);
    f.markRunning(0);
    expect(f.canNext).toBe(false);
  });

  it('advances the cursor once the active step is done', () => {
    const f = flow();
    f.markDone(0);
    expect(f.canNext).toBe(true);
    f.next();
    expect(f.cursor).toBe(1);
  });

  it('advancing forward over an already-completed step leaves it done', () => {
    const f = flow();
    f.markDone(0);
    f.markDone(1);
    f.next(); // -> 1
    f.next(); // -> 2 is a choice, still pending; cannot go further
    expect(f.cursor).toBe(2);
    expect(f.steps[0]!.state).toBe('done');
    expect(f.steps[1]!.state).toBe('done');
    expect(f.activeNeedsRun).toBe(true); // the choice step still needs deciding
  });
});

describe('Back moves the cursor only', () => {
  it('returns to a completed step without changing its state or result', () => {
    const f = flow();
    const result = { token: 'made' };
    f.markDone(0);
    f.markDone(1, result);
    f.next(); // -> 1
    f.back(); // -> 0
    expect(f.cursor).toBe(0);
    expect(f.steps[1]!.state).toBe('done');
    expect(f.steps[1]!.result).toBe(result);
    // Nothing about step 0 was reset either.
    expect(f.steps[0]!.state).toBe('done');
    expect(f.activeNeedsRun).toBe(false);
  });

  it('cannot go back from the first step', () => {
    const f = flow();
    expect(f.canBack).toBe(false);
    f.back();
    expect(f.cursor).toBe(0);
  });

  it('a completed step returned to and advanced from again is not re-run', () => {
    const f = flow();
    f.markDone(0);
    f.next();  // -> 1
    f.markDone(1);
    f.back();  // -> 0, still done
    f.next();  // -> 1, still done, activeNeedsRun false
    expect(f.cursor).toBe(1);
    expect(f.activeNeedsRun).toBe(false);
  });
});

describe('Retry is the only re-run, and only on a failed step', () => {
  it('is offered only when the active step has failed', () => {
    const f = flow();
    expect(f.canRetry).toBe(false);
    f.markRunning(0);
    expect(f.canRetry).toBe(false);
    f.markDone(0);
    expect(f.canRetry).toBe(false);
    f.markFailed(0, 'boom');
    expect(f.canRetry).toBe(true);
  });

  it('resets a failed step to pending so its work runs again, and clears its error and logs', () => {
    const f = flow();
    f.markRunning(0);
    f.log(0, 'attempting');
    f.markFailed(0, 'launchctl bootstrap failed');
    f.retry();
    expect(f.steps[0]!.state).toBe('pending');
    expect(f.steps[0]!.error).toBeUndefined();
    expect(f.steps[0]!.logs).toEqual([]);
    expect(f.activeNeedsRun).toBe(true);
  });

  it('does nothing on a step that has not failed', () => {
    const f = flow();
    f.markDone(0, 'result');
    f.retry();
    expect(f.steps[0]!.state).toBe('done');
    expect(f.steps[0]!.result).toBe('result');
  });
});

describe('completion', () => {
  it('is reached only when every step is done and the cursor rests on the last', () => {
    const f = flow();
    for (let index = 0; index < 5; index += 1) {
      f.markDone(index);
      if (index < 4) f.next();
    }
    expect(f.cursor).toBe(4);
    expect(f.complete).toBe(true);
  });

  it('is not complete while an earlier step is still pending', () => {
    const f = flow();
    f.markDone(0);
    f.next();
    expect(f.complete).toBe(false);
  });
});
