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
