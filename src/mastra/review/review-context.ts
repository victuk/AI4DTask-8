import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseUnifiedDiff, type ParsedDiff } from './diff-parser.js';
import { getDiffForSource, isGitRepo, listRepoFiles, readWorkingFile, readFileAtRef, getRepoInfo } from './git-utils.js';
import { fetchPrDiff, fetchPrMeta, parseGitHubPrUrl } from './github.js';
import { fetchMrDiff, fetchMrMeta, parseGitLabMrUrl } from './gitlab.js';
import type { ReviewOptions } from '../types.js';
import { DEFAULT_REVIEW_OPTIONS } from '../types.js';

/**
 * The shared context for one review run: what changed, and read access to the
 * repository so specialists can inspect code beyond the diff.
 */

export interface ReviewContext {
  reviewId: string;
  repoPath: string;
  repoName: string;
  sourceType: 'diff' | 'commit' | 'pr' | 'repository';
  sourceRef: string;
  title: string;
  /** PR description / commit message when available. */
  description?: string;
  diff: string;
  diffStats?: string;
  parsed: ParsedDiff;
  changedFiles: string[];
  options: ReviewOptions;
  isTempClone: boolean;
  /** Platform PR info for comment posting. */
  pr?: {
    platform: 'github' | 'gitlab';
    repoFullName: string;
    number: number;
    headSha?: string;
  };
}

export interface ResolveSourceParams {
  sourceType: 'diff' | 'commit' | 'pr' | 'repository';
  /** Local repo path (commit/repository), PR URL (pr), or optional context repo (diff). */
  repoPath?: string;
  /** Commit hash, branch, or PR URL. */
  ref?: string;
  /** Raw diff text when sourceType === 'diff'. */
  diffText?: string;
  reviewId: string;
  options?: Partial<ReviewOptions>;
}

function safeRepoName(repoPath: string): string {
  return path.basename(path.resolve(repoPath || 'unknown-repo'));
}

function cleanupLater(dir: string): void {
  process.on('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
}

/**
 * Build the review context from any supported source. Never throws for
 * network problems alone — PR diffs degrade to diff-only review context when
 * the repository cannot be fetched.
 */
export async function resolveReviewContext(params: ResolveSourceParams): Promise<ReviewContext> {
  const options: ReviewOptions = { ...DEFAULT_REVIEW_OPTIONS, ...(params.options ?? {}) };
  const { sourceType } = params;

  if (sourceType === 'diff') {
    const diffText = (params.diffText ?? '').trim();
    if (!diffText) throw new Error('Empty diff provided');
    const repoPath = params.repoPath && isGitRepo(params.repoPath) ? path.resolve(params.repoPath) : '';
    return buildContext({
      reviewId: params.reviewId,
      repoPath,
      sourceType,
      sourceRef: 'pasted diff',
      title: 'Ad-hoc diff review',
      diff: diffText,
      options,
      isTempClone: false,
    });
  }

  if (sourceType === 'commit' || sourceType === 'repository') {
    const repoPath = params.repoPath ? path.resolve(params.repoPath) : '';
    if (!repoPath || !isGitRepo(repoPath)) {
      throw new Error(`Not a git repository: ${repoPath || '(empty)'}`);
    }
    if (sourceType === 'repository') {
      // Review uncommitted working-tree changes; fall back to last commit if clean.
      const wt = await getDiffForSource(repoPath, { type: 'worktree' });
      const source = wt.diff.trim()
        ? { type: 'worktree' as const }
        : { type: 'commit' as const, ref: 'HEAD' };
      const result = await getDiffForSource(repoPath, source);
      if (!result.diff.trim()) throw new Error('No changes found to review (clean working tree).');
      return buildContext({ reviewId: params.reviewId, repoPath, sourceType, sourceRef: source.type === 'commit' ? 'HEAD' : 'worktree', title: result.title, diff: result.diff, diffStats: result.diffStats, options, isTempClone: false });
    }
    const ref = params.ref || 'HEAD';
    const result = await getDiffForSource(repoPath, { type: 'commit', ref });
    if (!result.diff.trim()) throw new Error(`No diff found for commit ${ref}`);
    return buildContext({ reviewId: params.reviewId, repoPath, sourceType: 'commit', sourceRef: ref, title: result.title, diff: result.diff, diffStats: result.diffStats, options, isTempClone: false });
  }

  // sourceType === 'pr': GitHub or GitLab PR/MR URL.
  const url = params.ref?.trim();
  if (!url) throw new Error('Pull request review requires a PR/MR URL');
  const gh = parseGitHubPrUrl(url);
  const gl = !gh ? parseGitLabMrUrl(url) : undefined;
  if (!gh && !gl) throw new Error('Unsupported pull request URL. Use a GitHub pull or GitLab merge_requests URL.');

  const meta = gh ? await fetchPrMeta(gh) : await fetchMrMeta(gl!);
  const diff = gh ? await fetchPrDiff(gh) : await fetchMrDiff(gl!);
  if (!diff.trim()) throw new Error('Pull request has no diff (maybe it is empty or still merging).');

  // Try to fetch the actual repository for full context (shallow clone of the PR head).
  let repoPath = '';
  let isTempClone = false;
  const cloneUrl = gh ? `https://github.com/${gh.owner}/${gh.repo}.git` : `https://${gl!.host}/${gl!.projectId}.git`;
  try {
    const { run } = await import('./clone.js');
    const dest = await run(cloneUrl, meta.headSha);
    repoPath = dest;
    isTempClone = true;
    cleanupLater(dest);
  } catch {
    repoPath = '';
  }

  const prInfo = gh
    ? { platform: 'github' as const, repoFullName: `${gh.owner}/${gh.repo}`, number: gh.number, headSha: meta.headSha }
    : { platform: 'gitlab' as const, repoFullName: String(gl!.projectId), number: gl!.mrIid, headSha: meta.headSha };

  return buildContext({
    reviewId: params.reviewId,
    repoPath,
    sourceType: 'pr',
    sourceRef: url,
    title: `${meta.title} (${meta.author})`,
    description: meta.body,
    diff,
    options,
    isTempClone,
    pr: prInfo,
  });
}

async function buildContext(input: {
  reviewId: string;
  repoPath: string;
  sourceType: ReviewContext['sourceType'];
  sourceRef: string;
  title: string;
  description?: string;
  diff: string;
  diffStats?: string;
  options: ReviewOptions;
  isTempClone: boolean;
  pr?: ReviewContext['pr'];
}): Promise<ReviewContext> {
  const parsed = parseUnifiedDiff(input.diff);
  const changedFiles = parsed.files.map((f) => f.path);
  return {
    reviewId: input.reviewId,
    repoPath: input.repoPath,
    repoName: input.repoPath ? safeRepoName(input.repoPath) : 'inline-diff',
    sourceType: input.sourceType,
    sourceRef: input.sourceRef,
    title: input.title,
    description: input.description,
    diff: input.diff,
    diffStats: input.diffStats,
    parsed,
    changedFiles,
    options: input.options,
    isTempClone: input.isTempClone,
    pr: input.pr,
  };
}

/** Read a file from the review context repo (working tree preferred, HEAD fallback). */
export async function readContextFile(ctx: ReviewContext, filePath: string): Promise<string | undefined> {
  if (!ctx.repoPath) return undefined;
  const safe = normalizeRelPath(filePath);
  if (!safe) return undefined;
  const abs = path.join(ctx.repoPath, safe);
  if (!abs.startsWith(path.resolve(ctx.repoPath))) return undefined;
  const working = await readWorkingFile(ctx.repoPath, safe);
  if (working !== undefined) return working;
  return readFileAtRef(ctx.repoPath, safe);
}

export function normalizeRelPath(p: string): string | undefined {
  const cleaned = p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('..') || cleaned.includes('\0')) return undefined;
  return cleaned;
}

export { listRepoFiles, getRepoInfo, os };
