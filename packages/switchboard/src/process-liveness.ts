// harn:assume windows-process-liveness-probes-own-pid ref=windows-process-probe-target
export function processProbeTarget(
  platform: NodeJS.Platform,
  pid: number | undefined,
  processGroupId: number | undefined,
): number | undefined {
  if (processGroupId !== undefined) {
    return platform === 'win32' ? processGroupId : -processGroupId;
  }
  return pid;
}
// harn:end windows-process-liveness-probes-own-pid
