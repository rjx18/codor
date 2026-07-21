import { spawnSync } from 'node:child_process';

export interface ClipboardResult {
  status: number | null;
  error?: Error;
}

/** Runs a clipboard tool, passing the text on stdin. Injectable for tests. */
export type ClipboardSpawn = (command: string, args: readonly string[], input: string) => ClipboardResult;

export interface ClipboardDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  which: (command: string) => string | undefined;
  spawn?: ClipboardSpawn;
}

// harn:assume setup-copies-pairing-link-once-via-clipboard ref=clipboard-copy
/** The default spawn: pipe the text through stdin so it never appears in argv,
 *  and silence stdout/stderr so the text never appears in command output. */
const defaultSpawn: ClipboardSpawn = (command, args, input) => {
  const result = spawnSync(command, [...args], { input, stdio: ['pipe', 'ignore', 'ignore'] });
  return { status: result.status, error: result.error };
};

const isWsl = (env: NodeJS.ProcessEnv): boolean => Boolean(env.WSL_DISTRO_NAME ?? env.WSL_INTEROP);

/** Ordered native clipboard tools for the platform. Every tool reads the text on
 *  stdin and takes only static arguments, so the URL and its token are never
 *  passed as process arguments. */
function clipboardTools(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Array<{ command: string; args: string[] }> {
  if (platform === 'darwin') return [{ command: 'pbcopy', args: [] }];
  if (platform === 'win32' || isWsl(env)) return [{ command: 'clip.exe', args: [] }];
  if (platform === 'linux') {
    return [
      { command: 'wl-copy', args: [] },
      { command: 'xclip', args: ['-selection', 'clipboard'] },
      { command: 'xsel', args: ['--clipboard', '--input'] },
    ];
  }
  return [];
}

/** Copy `text` to the system clipboard via the first available native tool that
 *  succeeds. Returns false (never throws) when no tool is available or all fail;
 *  callers must treat that as "copy the link yourself", not a fatal error. The
 *  text travels on stdin only, so it never reaches argv or command output. */
export function copyToClipboard(text: string, deps: ClipboardDeps): boolean {
  const spawn = deps.spawn ?? defaultSpawn;
  for (const tool of clipboardTools(deps.platform, deps.env)) {
    if (deps.which(tool.command) === undefined) continue;
    try {
      const { status, error } = spawn(tool.command, tool.args, text);
      if (error === undefined && status === 0) return true;
    } catch {
      // A throwing spawn is treated like a failed tool: try the next candidate.
    }
  }
  return false;
}
// harn:end setup-copies-pairing-link-once-via-clipboard
