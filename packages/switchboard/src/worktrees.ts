import { execFile } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import {
  RegisteredWorktreeSchema,
  RepositoryRecordSchema,
  WorktreeAdoptRequestSchema,
  WorktreeAliasSchema,
  WorktreeCreateRequestSchema,
  WorktreeDiscoveryCandidateSchema,
  WorktreeListResponseSchema,
  type RegisteredWorktree,
  type RepositoryRecord,
  type WorktreeAdoptRequest,
  type WorktreeCreateRequest,
  type WorktreeDiscoveryCandidate,
  type WorktreeListResponse,
} from '@codor/protocol';

import {
  type RepositoryObservation,
  Store,
  type WorktreeObservation,
} from './store.js';

// harn:assume worktree-git-execution-is-argument-safe ref=worktree-git-runner
export const WORKTREE_GIT_TIMEOUT_MS = 5_000;
export const WORKTREE_GIT_MAX_BUFFER = 16 * 1024 * 1024;

export interface GitRunResult {
  stdout: string;
  stderr: string;
}

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<GitRunResult>;

const execFileAsync = promisify(execFile);

/** The only production Git execution seam used by the registry. `shell` is
 * explicitly false even though it is Node's default, so paths and labels can
 * never become command syntax. */
export const defaultWorktreeGitRunner: GitRunner = async (cwd, args) => {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    shell: false,
    timeout: WORKTREE_GIT_TIMEOUT_MS,
    maxBuffer: WORKTREE_GIT_MAX_BUFFER,
    windowsHide: true,
  });
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
};

interface ParsedGitWorktree {
  rawPath: string;
  head?: string;
  branch?: string;
  locked: boolean;
  prunable: boolean;
  primaryHint: boolean;
}

export interface GitRepositoryInspection {
  common_path: string;
  primary_path: string;
  primary_git_admin_id: string;
  worktrees: WorktreeObservation[];
}

export interface WorktreeManagerOptions {
  git?: GitRunner;
}

function outputLine(output: string): string {
  return output.trim().split('\n')[0]?.trim() ?? '';
}

function isCommitHash(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{40}$/i.test(value);
}

function canonicalExistingPath(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  try {
    const stat = statSync(value);
    if (!stat.isDirectory()) throw new Error(`${label} must be a directory`);
    return realpathSync(value);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith('must be a directory')) throw error;
    throw new Error(`${label} does not exist`);
  }
}

function canonicalGitPath(value: string, cwd: string): string {
  const expanded = isAbsolute(value) ? value : resolve(cwd, value);
  return resolve(expanded);
}

function canonicalTargetPath(value: string): { target: string; parent: string } {
  if (!isAbsolute(value)) throw new Error('worktree target must be absolute');
  const target = resolve(value);
  if (existsSync(target)) throw new Error('worktree target already exists');
  const parent = dirname(target);
  if (!existsSync(parent)) throw new Error('worktree target parent must already exist');
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory()) throw new Error('worktree target parent must be a directory');
  return { target: join(realpathSync(parent), basename(target)), parent: realpathSync(parent) };
}

function isWithin(path: string, parent: string): boolean {
  const child = resolve(path);
  const base = resolve(parent);
  const remainder = relative(base, child);
  return remainder === '' || (remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

/** Parse Git's NUL-delimited worktree porcelain. Empty NUL fields delimit
 * records; no path is split on whitespace. */
function parseWorktreePorcelain(output: string): ParsedGitWorktree[] {
  const records: ParsedGitWorktree[] = [];
  let current: Partial<ParsedGitWorktree> = {};
  const flush = (): void => {
    if (typeof current.rawPath !== 'string' || current.rawPath === '') {
      current = {};
      return;
    }
    records.push({
      rawPath: current.rawPath,
      ...(current.head !== undefined && { head: current.head }),
      ...(current.branch !== undefined && { branch: current.branch }),
      locked: current.locked === true,
      prunable: current.prunable === true,
      primaryHint: records.length === 0,
    });
    current = {};
  };

  for (const token of output.split('\0')) {
    if (token === '') {
      flush();
      continue;
    }
    if (token.startsWith('worktree ')) current.rawPath = token.slice('worktree '.length);
    else if (token.startsWith('HEAD ')) current.head = token.slice('HEAD '.length).trim();
    else if (token.startsWith('branch ')) {
      const branch = token.slice('branch '.length).trim();
      current.branch = branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
    } else if (token === 'locked' || token.startsWith('locked ')) current.locked = true;
    else if (token === 'prunable' || token.startsWith('prunable ')) current.prunable = true;
  }
  flush();
  return records;
}

function normalizeAlias(value: string): string {
  const normalized = value.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 48)
    .replace(/[^a-z0-9]+$/, '');
  if (normalized === '' || normalized === 'main') throw new Error('worktree alias must be a non-main label');
  return WorktreeAliasSchema.parse(normalized);
}

export function normalizeWorktreeAlias(value: string): string {
  return normalizeAlias(value);
}

function defaultAlias(candidate: ParsedGitWorktree, path: string): string {
  return normalizeAlias(candidate.branch ?? basename(path));
}

function errorCode(error: unknown): string | number | undefined {
  return (error as { code?: string | number }).code;
}

function errorStdout(error: unknown): string {
  const stdout = (error as { stdout?: unknown }).stdout;
  return typeof stdout === 'string' ? stdout : '';
}

function errorStderr(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === 'string' ? stderr : '';
}

function isExpectedGitRefFailure(error: unknown): boolean {
  return errorCode(error) === 1;
}

function pathFromGitdirFile(path: string): string | undefined {
  try {
    const contents = readFileSync(path, 'utf8').trim();
    if (contents === '') return undefined;
    return contents.startsWith('/') || /^[A-Za-z]:[\\/]/.test(contents)
      ? resolve(contents)
      : resolve(dirname(path), contents);
  } catch {
    return undefined;
  }
}

// harn:end worktree-git-execution-is-argument-safe

// harn:assume repository-primary-identity-is-git-derived ref=git-repository-detection
export class WorktreeManager {
  private readonly git: GitRunner;

  constructor(private readonly store: Store, options: WorktreeManagerOptions = {}) {
    this.git = options.git ?? defaultWorktreeGitRunner;
  }

  /** Read-only repository and worktree inspection. A non-Git directory is
   * represented by undefined and never creates a repository/store row. */
  async inspect(cwd: string): Promise<GitRepositoryInspection | undefined> {
    const selected = canonicalExistingPath(cwd, 'repository cwd');
    let commonPath: string;
    let primaryAdmin: string;
    try {
      const inside = outputLine((await this.git(selected, ['rev-parse', '--is-inside-work-tree'])).stdout);
      if (inside !== 'true') return undefined;
      const commonRaw = outputLine((await this.git(selected, [
        'rev-parse', '--path-format=absolute', '--git-common-dir',
      ])).stdout);
      const adminRaw = outputLine((await this.git(selected, [
        'rev-parse', '--path-format=absolute', '--git-dir',
      ])).stdout);
      if (commonRaw === '' || adminRaw === '') return undefined;
      commonPath = canonicalGitPath(commonRaw, selected);
      primaryAdmin = canonicalGitPath(adminRaw, selected);
    } catch {
      return undefined;
    }

    const worktreeList = (await this.git(selected, ['worktree', 'list', '--porcelain', '-z'])).stdout;
    const parsed = parseWorktreePorcelain(worktreeList);
    const metadataRoot = await this.git(selected, [
      'rev-parse', '--path-format=absolute', '--git-path', 'worktrees',
    ]).then((result) => canonicalGitPath(outputLine(result.stdout), selected)).catch(() => undefined);
    const observations: WorktreeObservation[] = [];

    for (const candidate of parsed) {
      const path = resolve(candidate.rawPath);
      const available = existsSync(path) && (() => {
        try { return lstatSync(path).isDirectory(); } catch { return false; }
      })();
      const canonicalPath = available ? realpathSync(path) : path;
      let adminId: string | undefined;
      if (available) {
        try {
          adminId = canonicalGitPath(outputLine((await this.git(canonicalPath, [
            'rev-parse', '--path-format=absolute', '--git-dir',
          ])).stdout), canonicalPath);
        } catch {
          adminId = undefined;
        }
      }
      if (adminId === undefined && metadataRoot !== undefined && canonicalPath !== commonPath) {
        try {
          for (const entry of readdirSync(metadataRoot, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const adminPath = join(metadataRoot, entry.name);
            const worktreeGitdir = pathFromGitdirFile(join(adminPath, 'gitdir'));
            if (worktreeGitdir === undefined) continue;
            const linkedPath = worktreeGitdir.endsWith(`${sep}.git`)
              ? worktreeGitdir.slice(0, -(`${sep}.git`).length)
              : dirname(worktreeGitdir);
            if (resolve(linkedPath) === canonicalPath) {
              adminId = resolve(adminPath);
              break;
            }
          }
        } catch {
          // An inaccessible metadata directory is simply an unavailable candidate.
        }
      }
      if (adminId === undefined && candidate.primaryHint) adminId = commonPath;
      if (adminId === undefined) {
        // A missing worktree without readable metadata cannot be safely
        // correlated to a Codor identity, so it remains an observation only.
        adminId = join(commonPath, 'worktrees', basename(canonicalPath));
      }

      const primary = adminId === commonPath || (candidate.primaryHint && primaryAdmin === commonPath);
      observations.push({
        path: canonicalPath,
        git_admin_id: adminId,
        primary,
        availability: candidate.prunable
          ? 'prunable'
          : !available
            ? 'missing'
            : candidate.locked
              ? 'locked'
              : 'available',
        locked: candidate.locked,
        ...(isCommitHash(candidate.head) && { head: candidate.head.toLowerCase() }),
        ...(candidate.branch !== undefined && { branch: candidate.branch }),
      });
    }

    const primaryObservation = observations.find((observation) => observation.primary)
      ?? observations[0];
    if (primaryObservation === undefined) return undefined;
    // The primary checkout's administrative identity is the repository's
    // common directory. This remains true across branch changes and detached
    // HEADs; branch names are never used as identity.
    primaryObservation.primary = true;
    primaryObservation.git_admin_id = commonPath;
    return {
      common_path: commonPath,
      primary_path: primaryObservation.path,
      primary_git_admin_id: primaryAdmin === commonPath ? primaryAdmin : commonPath,
      worktrees: observations,
    };
  }
  // harn:end repository-primary-identity-is-git-derived

  // harn:assume worktree-discovery-never-registers-candidates ref=worktree-discovery-contract
  async list(room: string, cwd: string): Promise<WorktreeListResponse> {
    const inspection = await this.inspect(cwd);
    if (inspection === undefined) {
      return WorktreeListResponseSchema.parse({
        // A non-Git known cwd keeps the ordinary channel path: a repository
        // row from another (or a former) cwd is not projected across it.
        repository: null,
        registered: [],
        discovered: [],
      });
    }

    const repository = this.store.getRepositoryByCommonPath(room, inspection.common_path);
    if (repository === undefined) {
      return WorktreeListResponseSchema.parse({ repository: null, registered: [], discovered: inspection.worktrees });
    }

    const active = this.store.listRegisteredWorktrees(room, repository.id);
    // harn:assume registered-worktree-identities-are-durable ref=worktree-runtime-reconciliation
    const byAdmin = new Map(active.map((worktree) => [worktree.git_admin_id, worktree]));
    const seen = new Set<string>();
    for (const observation of inspection.worktrees) {
      const registered = byAdmin.get(observation.git_admin_id);
      if (registered === undefined) continue;
      seen.add(registered.id);
      this.store.refreshWorktreeObservation(room, registered.id, observation);
    }
    for (const registered of active) {
      if (seen.has(registered.id)) continue;
      this.store.refreshWorktreeObservation(room, registered.id, {
        path: registered.path,
        git_admin_id: registered.git_admin_id,
        primary: registered.primary,
        availability: 'missing',
        locked: false,
        ...(registered.head !== undefined && { head: registered.head }),
        ...(registered.branch !== undefined && { branch: registered.branch }),
      });
    }
    // harn:end registered-worktree-identities-are-durable

    const refreshed = this.store.listRegisteredWorktrees(room, repository.id);
    const refreshedByAdmin = new Map(refreshed.map((worktree) => [worktree.git_admin_id, worktree]));
    const discovered = inspection.worktrees.map((observation) => {
      const registered = refreshedByAdmin.get(observation.git_admin_id);
      return WorktreeDiscoveryCandidateSchema.parse({
        ...observation,
        ...(registered !== undefined && {
          registered_id: registered.id,
          alias: registered.alias,
        }),
      });
    });
    return WorktreeListResponseSchema.parse({
      repository: this.store.getRepository(room) ?? repository,
      registered: refreshed,
      discovered,
    });
  }
  // harn:end worktree-discovery-never-registers-candidates

  // harn:assume worktree-creation-registers-only-a-new-secondary ref=worktree-create-contract
  async adopt(
    room: string,
    cwd: string,
    input: WorktreeAdoptRequest,
  ): Promise<{ repository: RepositoryRecord; worktree: RegisteredWorktree }> {
    const parsedInput = WorktreeAdoptRequestSchema.parse(input);
    const inspection = await this.requireInspection(cwd);
    const target = canonicalExistingPath(parsedInput.path, 'worktree path');
    const candidate = inspection.worktrees.find((observation) => observation.path === target);
    if (candidate === undefined) throw new Error('worktree path is not a discovered candidate');
    if (candidate.primary) throw new Error('the primary checkout is registered as main, not adoptable');
    if (candidate.availability !== 'available' || candidate.locked) {
      throw new Error('only an available, unlocked worktree can be adopted');
    }

    this.assertRepositoryAllowed(room, inspection.common_path);
    const repositoryObservation = this.repositoryObservation(inspection);
    const existing = this.store.getRepositoryByCommonPath(room, inspection.common_path);
    const tombstone = existing === undefined
      ? undefined
      : this.store.getWorktreeByGitAdmin(room, candidate.git_admin_id, { includeTombstones: true });
    const alias = parsedInput.alias === undefined
      ? tombstone?.alias ?? defaultAliasFromObservation(candidate, target)
      : normalizeAlias(parsedInput.alias);
    this.assertAliasAvailable(room, existing?.id, alias, tombstone?.id);
    const result = this.store.registerWorktree(
      room,
      repositoryObservation,
      inspection.worktrees.find((observation) => observation.primary) ?? candidate,
      candidate,
      alias,
      'adopted',
    );
    return {
      repository: RepositoryRecordSchema.parse(result.repository),
      worktree: RegisteredWorktreeSchema.parse(result.worktree),
    };
  }

  async create(
    room: string,
    cwd: string,
    input: WorktreeCreateRequest,
  ): Promise<{ repository: RepositoryRecord; worktree: RegisteredWorktree }> {
    const parsedInput = WorktreeCreateRequestSchema.parse(input);
    const inspection = await this.requireInspection(cwd);
    const primary = inspection.worktrees.find((observation) => observation.primary);
    if (primary === undefined || primary.availability !== 'available') {
      throw new Error('the primary checkout is unavailable');
    }
    const alias = normalizeAlias(parsedInput.alias);
    this.assertRepositoryAllowed(room, inspection.common_path);
    const existing = this.store.getRepositoryByCommonPath(room, inspection.common_path);
    this.assertAliasAvailable(room, existing?.id, alias);
    const { target } = canonicalTargetPath(parsedInput.path);
    for (const observation of inspection.worktrees) {
      if (isWithin(target, observation.path) || isWithin(observation.path, target)) {
        throw new Error('worktree target overlaps an existing checkout');
      }
    }
    if (isWithin(target, inspection.common_path) || isWithin(inspection.common_path, target)) {
      throw new Error('worktree target overlaps Git administrative state');
    }

    await this.assertNewBranch(primary.path, parsedInput.branch);
    const head = outputLine((await this.git(primary.path, ['rev-parse', '--verify', 'HEAD'])).stdout);
    if (!isCommitHash(head)) throw new Error('the primary checkout has no commit HEAD');
    await this.git(primary.path, [
      'worktree', 'add', '--no-track', '-b', parsedInput.branch, target, head,
    ]);

    let created: GitRepositoryInspection | undefined;
    try {
      created = await this.requireInspection(target);
    } catch (error) {
      // A successful Git mutation with an unreadable result must not be
      // silently registered. Best-effort non-force cleanup is still bounded
      // and branch-preserving.
      try { await this.git(primary.path, ['worktree', 'remove', '--', target]); } catch { /* diagnostic only */ }
      throw error;
    }
    if (created.common_path !== inspection.common_path) {
      try { await this.git(primary.path, ['worktree', 'remove', '--', target]); } catch { /* diagnostic only */ }
      throw new Error('created worktree belongs to a different repository');
    }
    const createdObservation = created.worktrees.find((observation) => observation.path === target);
    if (createdObservation === undefined || createdObservation.primary) {
      try { await this.git(primary.path, ['worktree', 'remove', '--', target]); } catch { /* diagnostic only */ }
      throw new Error('created worktree could not be rediscovered');
    }
    const result = this.store.registerWorktree(
      room,
      this.repositoryObservation(created),
      created.worktrees.find((observation) => observation.primary) ?? primary,
      createdObservation,
      alias,
      'created',
    );
    return {
      repository: RepositoryRecordSchema.parse(result.repository),
      worktree: RegisteredWorktreeSchema.parse(result.worktree),
    };
  }
  // harn:end worktree-creation-registers-only-a-new-secondary

  // harn:assume worktree-removal-is-clean-and-branch-preserving ref=worktree-remove-contract
  unregister(room: string, worktreeId: string): RegisteredWorktree {
    return this.store.unregisterWorktree(room, worktreeId);
  }

  async remove(room: string, cwd: string, worktreeId: string): Promise<{
    repository: RepositoryRecord;
    worktree: RegisteredWorktree;
  }> {
    const registered = this.store.getWorktree(room, worktreeId);
    if (registered === undefined || registered.lifecycle !== 'active' || registered.primary) {
      throw new Error('only an active secondary worktree can be removed');
    }
    const repository = this.store.getRepository(room);
    if (repository === undefined || repository.id !== registered.repository_id) {
      throw new Error('worktree repository is not registered');
    }
    const inspection = await this.requireInspection(cwd);
    if (inspection.common_path !== repository.common_path) {
      throw new Error('worktree belongs to a different repository');
    }
    const fresh = inspection.worktrees.find((observation) => observation.git_admin_id === registered.git_admin_id);
    if (fresh === undefined || fresh.primary) throw new Error('registered worktree is missing or mismatched');
    if (fresh.path !== registered.path || fresh.git_admin_id !== registered.git_admin_id) {
      throw new Error('registered worktree is missing or mismatched');
    }
    if (fresh.availability !== 'available' || fresh.locked) {
      throw new Error('worktree is locked, prunable, or unavailable');
    }
    const refreshed = this.store.refreshWorktreeObservation(room, worktreeId, fresh);
    if (refreshed.path !== fresh.path || refreshed.git_admin_id !== fresh.git_admin_id) {
      throw new Error('registered worktree identity does not match Git');
    }
    const status = (await this.git(fresh.path, [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching',
    ])).stdout;
    if (status !== '') throw new Error('worktree must be clean before removal');
    const primary = inspection.worktrees.find((observation) => observation.primary);
    if (primary === undefined || primary.availability !== 'available') {
      throw new Error('the primary checkout is unavailable');
    }
    await this.git(primary.path, ['worktree', 'remove', '--', fresh.path]);
    const removed = this.store.removeWorktree(room, worktreeId);
    return { repository: this.store.getRepository(room)!, worktree: removed };
  }
  // harn:end worktree-removal-is-clean-and-branch-preserving

  private async requireInspection(cwd: string): Promise<GitRepositoryInspection> {
    const inspection = await this.inspect(cwd);
    if (inspection === undefined) throw new Error('cwd is not inside a Git worktree');
    return inspection;
  }

  private repositoryObservation(inspection: GitRepositoryInspection): RepositoryObservation {
    return {
      common_path: inspection.common_path,
      primary_path: inspection.primary_path,
      primary_git_admin_id: inspection.primary_git_admin_id,
    };
  }

  private assertAliasAvailable(room: string, repositoryId: string | undefined, alias: string, exceptId?: string): void {
    if (alias === 'main') throw new Error('the main alias is reserved');
    if (repositoryId === undefined) return;
    const collision = this.store.listRegisteredWorktrees(room, repositoryId)
      .find((worktree) => worktree.alias === alias && worktree.id !== exceptId);
    if (collision !== undefined) throw new Error(`worktree alias is already in use: ${alias}`);
  }

  private assertRepositoryAllowed(room: string, commonPath: string): void {
    const existing = this.store.getRepository(room);
    if (existing !== undefined && existing.common_path !== commonPath) {
      throw new Error('a room may register only one Git repository');
    }
  }

  private async assertNewBranch(primary: string, branch: string): Promise<void> {
    try {
      await this.git(primary, ['check-ref-format', '--branch', branch]);
    } catch (error) {
      throw new Error(`invalid local branch name: ${branch}`);
    }
    try {
      await this.git(primary, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
      throw new Error(`local branch already exists: ${branch}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('local branch already exists')) throw error;
      if (!isExpectedGitRefFailure(error)) {
        const detail = errorStderr(error) || errorStdout(error);
        throw new Error(`could not verify local branch: ${branch}${detail ? ` (${detail.trim()})` : ''}`);
      }
    }
  }
}

function defaultAliasFromObservation(observation: WorktreeObservation, path: string): string {
  return normalizeAlias(observation.branch ?? basename(path));
}

// harn:assume worktree-git-execution-is-argument-safe ref=worktree-git-runner-regression
export function parseWorktreeListForTest(output: string): ReadonlyArray<{
  rawPath: string;
  head?: string;
  branch?: string;
  locked: boolean;
  prunable: boolean;
}> {
  return parseWorktreePorcelain(output).map(({ primaryHint: _primaryHint, ...record }) => record);
}
// harn:end worktree-git-execution-is-argument-safe
