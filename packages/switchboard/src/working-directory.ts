import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

// harn:assume working-directories-validated-before-spawn ref=cwd-normalization-boundary
export function normalizeWorkingDirectory(value: string, home = homedir()): string {
  const expanded = value.startsWith('~/') ? join(home, value.slice(2)) : value;
  if (!isAbsolute(expanded)) {
    throw new Error(`working directory ${expanded} must be absolute`);
  }
  const normalized = resolve(expanded);
  let stat;
  try {
    stat = statSync(normalized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`working directory ${normalized} does not exist`);
    }
    throw error;
  }
  if (!stat.isDirectory()) throw new Error(`${normalized} is not a directory`);
  return normalized;
}
// harn:end working-directories-validated-before-spawn
