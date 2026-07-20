import { describe, expect, it } from 'vitest';

import { processProbeTarget } from './process-liveness.js';

// harn:assume windows-process-liveness-probes-own-pid ref=windows-process-probe-regression
describe('processProbeTarget', () => {
  it('probes the positive process-group leader on Windows', () => {
    expect(processProbeTarget('win32', 41, 42)).toBe(42);
  });

  it('probes the negative process group on POSIX', () => {
    expect(processProbeTarget('linux', 41, 42)).toBe(-42);
    expect(processProbeTarget('darwin', 41, undefined)).toBe(41);
  });
});
// harn:end windows-process-liveness-probes-own-pid
