// The diff explorer's client read. Kept in web-next (not @legacy/api) so the
// whole feature stays in one batch; mirrors the fetchJson auth shape.

export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface GitFile {
  path: string;
  status: GitFileStatus;
  additions: number;
  deletions: number;
  diff: string;
  truncated: boolean;
}

export interface GitWorkingState {
  cwds: string[];
  selected: string | null;
  clean: boolean;
  files: GitFile[];
}

/** Read the room's live git working state. `cwd` selects one of the room's known
 *  directories (the daemon refuses anything else); omitted uses the first. */
export async function fetchGitWorkingState(
  room: string,
  token: string,
  cwd?: string,
): Promise<GitWorkingState> {
  const query = cwd !== undefined ? `?cwd=${encodeURIComponent(cwd)}` : '';
  const res = await fetch(`/api/rooms/${encodeURIComponent(room)}/git-diff${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`git-diff request failed: ${String(res.status)}`);
  return res.json() as Promise<GitWorkingState>;
}

const STATUS_LETTER: Record<GitFileStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
};

export const statusLetter = (status: GitFileStatus): string => STATUS_LETTER[status];

/** A compact, readable cwd label for the picker — the last two path segments. */
export function shortenCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts.length <= 2 ? cwd : `…/${parts.slice(-2).join('/')}`;
}

// ── Stale-while-revalidate cache (richard #472): the last known working state
// per room+cwd shows instantly on revisit while a fresh read runs behind a
// small refresh pill — an empty diff appears only on a true first visit or
// when the saved copy is really stale. Memory first, localStorage beneath it
// so the cache survives reloads; oversized states stay memory-only.

const memoryCache = new Map<string, GitWorkingState>();
const STORE_PREFIX = 'nx-gitdiff:';
const REALLY_STALE_MS = 24 * 60 * 60 * 1000;
const MAX_PERSIST_CHARS = 1_500_000;

const cacheKey = (room: string, cwd?: string): string => `${room}|${cwd ?? ''}`;

export function cachedGitWorkingState(room: string, cwd?: string): GitWorkingState | undefined {
  const key = cacheKey(room, cwd);
  const memory = memoryCache.get(key);
  if (memory !== undefined) return memory;
  try {
    const raw = localStorage.getItem(STORE_PREFIX + key);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as { savedAt: number; state: GitWorkingState };
    if (typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > REALLY_STALE_MS) {
      return undefined;
    }
    memoryCache.set(key, parsed.state);
    return parsed.state;
  } catch {
    return undefined;
  }
}

export function rememberGitWorkingState(room: string, cwd: string | undefined, state: GitWorkingState): void {
  const key = cacheKey(room, cwd);
  memoryCache.set(key, state);
  try {
    const raw = JSON.stringify({ savedAt: Date.now(), state });
    if (raw.length <= MAX_PERSIST_CHARS) localStorage.setItem(STORE_PREFIX + key, raw);
    else localStorage.removeItem(STORE_PREFIX + key);
  } catch {
    // Quota or private mode — the in-memory copy still serves this session.
  }
}
