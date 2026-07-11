import { realpathSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';

export class LocalDirectoryError extends Error {
  constructor(readonly status: 400 | 403 | 404, message: string) {
    super(message);
  }
}

export interface LocalDirectoryListing {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
}

// harn:assume local-directory-listing-home-contained ref=contained-directory-listing
export function listLocalDirectories(
  requestedPath: string | undefined,
  hidden: boolean,
  home = homedir(),
): LocalDirectoryListing {
  const input = requestedPath ?? home;
  if (!isAbsolute(input)) throw new LocalDirectoryError(400, 'path must be absolute');
  let root: string;
  let path: string;
  try {
    root = realpathSync(home);
    path = realpathSync(input);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LocalDirectoryError(404, `directory ${input} does not exist`);
    }
    throw error;
  }
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new LocalDirectoryError(403, 'path is outside the operator home');
  }
  if (!statSync(path).isDirectory()) throw new LocalDirectoryError(400, `${path} is not a directory`);
  const dirs = readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (hidden || !entry.name.startsWith('.')))
    .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { path, parent: path === root ? null : dirname(path), dirs };
}
// harn:end local-directory-listing-home-contained
