import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';

const exec = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr?: string,
  ) {
    super(message);
  }
}

async function git(repoPath: string, args: string[], timeoutMs = 20000): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', repoPath, ...args], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GitError(`git ${args[0]} failed: ${e.message}`, e.stderr);
  }
}

export function isGitRepo(dir: string): boolean {
  try {
    const stat = fs.statSync(path.join(dir, '.git'));
    return stat.isDirectory() || stat.isFile(); // .git file => worktree
  } catch {
    return false;
  }
}

export interface RepoInfo {
  name: string;
  branch?: string;
  headCommit?: string;
  remoteUrl?: string;
  commitCount: number;
  dirty: boolean;
}

export async function getRepoInfo(repoPath: string): Promise<RepoInfo> {
  const [name, branch, head, remote, count, status] = await Promise.all([
    Promise.resolve(path.basename(path.resolve(repoPath))),
    git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
    git(repoPath, ['rev-parse', '--short', 'HEAD']).catch(() => ''),
    git(repoPath, ['config', '--get', 'remote.origin.url']).catch(() => ''),
    git(repoPath, ['rev-list', '--count', 'HEAD']).catch(() => '0'),
    git(repoPath, ['status', '--porcelain']).catch(() => 'x'),
  ]);
  return {
    name,
    branch: branch.trim() || undefined,
    headCommit: head.trim() || undefined,
    remoteUrl: remote.trim() || undefined,
    commitCount: Number(count.trim()) || 0,
    dirty: status.trim().length > 0 && status !== 'x',
  };
}

/** Most recent N commits with metadata. */
export async function listCommits(repoPath: string, limit = 30) {
  const out = await git(repoPath, [
    'log',
    `--max-count=${limit}`,
    '--date=iso-strict',
    '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e',
  ]);
  return out
    .split('\x1e')
    .filter((s) => s.trim())
    .map((entry) => {
      const [hash, short, author, date, subject] = entry.trim().split('\x1f');
      return { hash, short, author, date, subject };
    });
}

export interface RepoDiffResult {
  diff: string;
  diffStats: string;
  /** Title of what is being reviewed, e.g. commit subject. */
  title: string;
  changedFiles: string[];
}

function changedFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const m of diff.matchAll(/^diff --git a\/(.+?) b\/(.+?)$/gm)) {
    files.add(m[2]);
  }
  return [...files];
}

/**
 * Get a unified diff for the requested source.
 * - commit: that commit vs its parent
 * - pr-like / branch ref: ref vs its merge-base with main/master (falls back to diffing HEAD)
 * - worktree: staged + unstaged changes vs HEAD
 */
export async function getDiffForSource(
  repoPath: string,
  source: { type: 'commit'; ref: string } | { type: 'branch'; ref: string; base?: string } | { type: 'worktree' },
): Promise<RepoDiffResult> {
  if (source.type === 'commit') {
    const subject = (await git(repoPath, ['log', '-1', '--pretty=%s', source.ref]).catch(() => source.ref)).trim();
    const diff = await git(repoPath, ['diff', '--no-color', `${source.ref}^!`]).catch(async () => {
      // Root commit: show the full tree as additions.
      return git(repoPath, ['diff', '--no-color', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', source.ref]);
    });
    const stats = await git(repoPath, ['diff', '--stat', `${source.ref}^!`]).catch(() => '');
    return { diff, diffStats: stats, title: `Commit ${source.ref.slice(0, 10)}: ${subject}`, changedFiles: changedFilesFromDiff(diff) };
  }

  if (source.type === 'branch') {
    let base = source.base;
    if (!base) {
      const mergeBase = await git(repoPath, ['merge-base', 'HEAD', source.ref]).catch(() => '');
      base = mergeBase.trim() || 'HEAD';
    }
    const diff = await git(repoPath, ['diff', '--no-color', `${base}...${source.ref}`]).catch(() =>
      git(repoPath, ['diff', '--no-color', `${base}..${source.ref}`]),
    );
    const stats = await git(repoPath, ['diff', '--stat', `${base}...${source.ref}`]).catch(() => '');
    const subject = (await git(repoPath, ['log', '-1', '--pretty=%s', source.ref]).catch(() => '')).trim();
    return { diff, diffStats: stats, title: `Branch ${source.ref}: ${subject}`, changedFiles: changedFilesFromDiff(diff) };
  }

  // Worktree: staged + unstaged.
  const diff = await git(repoPath, ['diff', '--no-color', 'HEAD']);
  const stats = await git(repoPath, ['diff', '--stat', 'HEAD']);
  return { diff, diffStats: stats, title: 'Uncommitted working-tree changes', changedFiles: changedFilesFromDiff(diff) };
}

/** Read a file at HEAD (or a given ref), repo-relative path. Returns undefined if missing. */
export async function readFileAtRef(repoPath: string, filePath: string, ref = 'HEAD'): Promise<string | undefined> {
  try {
    const out = await git(repoPath, ['show', `${ref}:${filePath}`], 10000);
    return out;
  } catch {
    return undefined;
  }
}

export async function readWorkingFile(repoPath: string, filePath: string): Promise<string | undefined> {
  try {
    return fs.readFileSync(path.join(repoPath, filePath), 'utf8');
  } catch {
    return undefined;
  }
}

/** List repository files (tracked + untracked, excluding .git and common ignores). */
export async function listRepoFiles(repoPath: string, limit = 4000): Promise<string[]> {
  const tracked = await git(repoPath, ['ls-files', '--cached', '--others', '--exclude-standard']).catch(() => '');
  return tracked
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.includes('..'))
    .slice(0, limit);
}

export interface RepoTreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
}

/** Compact directory tree (2 levels deep) for orientation prompts. */
export async function getRepoTree(repoPath: string, maxEntries = 200): Promise<string> {
  const files = await listRepoFiles(repoPath, 2000);
  const dirs = new Map<string, number>();
  for (const f of files) {
    const parts = f.split('/');
    if (parts.length === 1) {
      dirs.set(f, dirs.get(f) ?? 0);
    } else {
      const top = parts[0];
      dirs.set(top, (dirs.get(top) ?? 0) + 1);
    }
  }
  const entries = [...dirs.entries()].slice(0, maxEntries);
  return entries.map(([name, count]) => (count > 0 ? `${name}/ (${count} files)` : name)).join('\n');
}

/** Branches suitable for PR-style review (recent, not the default branch). */
export async function listBranches(repoPath: string, limit = 20) {
  const out = await git(repoPath, [
    'for-each-ref',
    '--sort=-committerdate',
    `--count=${limit}`,
    '--format=%(refname:short)%x1f%(objectname:short)%x1f%(committerdate:iso-strict)%x1f%(subject)',
    'refs/heads/',
  ]).catch(() => '');
  return out
    .split('\n')
    .filter((s) => s.trim())
    .map((line) => {
      const [name, short, date, subject] = line.split('\x1f');
      return { name, short, date, subject };
    });
}

export async function cloneRepository(url: string, destDir: string, depth = 50): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true });
  const name = deriveRepoName(url);
  const dest = path.join(destDir, name);
  if (isGitRepo(dest)) {
    await git(dest, ['fetch', '--all'], 60000).catch(() => {});
    return dest;
  }
  await exec('git', ['clone', '--depth', String(depth), url, dest], {
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return dest;
}

export function deriveRepoName(url: string): string {
  const cleaned = url.replace(/\.git$/, '').replace(/\/$/, '');
  const last = cleaned.split('/').pop() ?? 'repo';
  return last.replace(/[^a-zA-Z0-9._-]/g, '-') || 'repo';
}
