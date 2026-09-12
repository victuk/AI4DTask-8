import type { ReviewOptions, AgentReport } from './types.js';
import { SEVERITY_RANK } from './types.js';
import { resolveModel } from './agents/specialists.js';
import { resolveReviewContext, type ReviewContext } from './review/review-context.js';
import { ReviewEngine } from './review/engine.js';
import { getReviewStore, type ReviewSourceInput } from './review/store.js';
import { postPrReview, type InlineComment } from './review/github.js';
import { postMrComments } from './review/gitlab.js';
import type { ReviewRecord } from './types.js';

/**
 * Review lifecycle service. startReview() registers the review, kicks off the
 * agentic pipeline in the background, and returns the id the UI/CLI polls.
 */

export interface StartReviewInput {
  sourceType: 'diff' | 'commit' | 'pr' | 'repository';
  repoPath?: string;
  ref?: string;
  diffText?: string;
  options?: Partial<ReviewOptions>;
}

export async function startReview(input: StartReviewInput): Promise<string> {
  const store = getReviewStore();
  const model = resolveModel();
  const seed: ReviewSourceInput = {
    repoPath: input.repoPath ?? '(resolving)',
    sourceType: input.sourceType,
    sourceRef: input.ref ?? (input.sourceType === 'diff' ? 'pasted diff' : 'HEAD'),
    diff: '',
    changedFiles: [],
    options: input.options,
  };
  const reviewId = await store.createReview(seed, model);

  void runReview(reviewId, input).catch(async (err) => {
    await store.setError(reviewId, err instanceof Error ? err.message : String(err));
  });
  return reviewId;
}

async function runReview(reviewId: string, input: StartReviewInput): Promise<void> {
  const store = getReviewStore();
  const startedAt = Date.now();

  let ctx: ReviewContext;
  try {
    await store.updateStage(reviewId, 'preparing');
    ctx = await resolveReviewContext({
      sourceType: input.sourceType,
      repoPath: input.repoPath,
      ref: input.ref,
      diffText: input.diffText,
      reviewId,
      options: input.options,
    });
  } catch (err) {
    await store.setError(reviewId, err instanceof Error ? err.message : String(err));
    return;
  }

  await store.updateReviewTarget(reviewId, {
    repoPath: ctx.repoPath || '(no repo — diff only)',
    repoName: ctx.repoName,
    title: ctx.title,
    diff: ctx.diff,
    diffStats: ctx.diffStats,
    changedFiles: ctx.changedFiles,
  });

  const engine = new ReviewEngine(ctx, async (event) => {
    if (event.type === 'stage') await store.updateStage(reviewId, stageForEvent(event.stage));
    if (event.type === 'plan') {
      await store.setPlan(reviewId, event.plan);
      await store.setAgentActivities(
        reviewId,
        event.plan.specialists.map((s) => ({ agent: s.agent, status: 'pending' as const })),
      );
    }
  });

  try {
    const plan = await engine.plan();

    // Run specialists with bounded concurrency.
    const agents = plan.specialists.map((s) => s.agent);
    const reports: AgentReport[] = [];
    const CONCURRENCY = 3;
    for (let i = 0; i < agents.length; i += CONCURRENCY) {
      const batch = agents.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (agentId) => {
          const report = await engine.runSpecialist(agentId, plan);
          return report;
        }),
      );
      reports.push(...results);
    }

    const validations = await engine.crossValidate(reports, plan);
    const { report } = await engine.consolidate(reports, plan, validations);

    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    await store.completeReview(reviewId, report, usage, Date.now() - startedAt);

    // Optional PR comment posting.
    if (input.options?.postComments && ctx.pr) {
      const record = await store.getReview(reviewId);
      if (record) await postReviewToPR(ctx, record, input.options.postSummaryOnly ?? false).catch(() => null);
    }
  } catch (err) {
    await store.setError(reviewId, err instanceof Error ? err.message : String(err));
  }
}

function stageForEvent(stage: string): 'planning' | 'specialists' | 'cross-validation' | 'consolidation' | 'completed' {
  switch (stage) {
    case 'planning':
      return 'planning';
    case 'specialists':
      return 'specialists';
    case 'cross-validation':
      return 'cross-validation';
    case 'consolidation':
      return 'consolidation';
    default:
      return 'completed';
  }
}

/** Build inline comments (one per finding with a line) + summary body. */
export function buildPrComments(record: ReviewRecord): { body: string; comments: InlineComment[] } {
  const report = record.report;
  if (!report) return { body: '', comments: [] };
  const comments: InlineComment[] = [];
  for (const f of report.findings) {
    if (!f.location.line || !f.location.file) continue;
    comments.push({
      path: f.location.file,
      line: f.location.line,
      body: `**[${f.severity.toUpperCase()}] ${f.title}** (confidence: ${f.confidence})\n\n${f.explanation}\n\n**Impact:** ${f.impact}\n\n**Recommendation:** ${f.recommendation}\n\n— automated review by ${f.reportedBy.join(', ') || 'review agent'}`,
    });
  }
  return { body: reviewToMarkdown(record), comments };
}

/** Post the review to the PR the change came from. */
export async function postReviewToPR(ctx: ReviewContext, record: ReviewRecord, summaryOnly: boolean): Promise<{ platform: string; posted: string; commentCount: number; url?: string }> {
  const { body, comments } = buildPrComments(record);
  if (!body) throw new Error('Review has no report yet');
  const toPost = summaryOnly ? [] : comments;
  if (ctx.pr?.platform === 'github') {
    const ref = parseGitHubRef(ctx.pr.repoFullName, ctx.pr.number);
    const res = await postPrReview(ref, body, toPost, record.report?.recommendation, ctx.pr.headSha);
    return { platform: 'github', ...res };
  }
  if (ctx.pr?.platform === 'gitlab') {
    const { parseGitLabMrUrl } = await import('./review/gitlab.js');
    const ref = parseGitLabMrUrl(ctx.sourceRef);
    if (!ref) throw new Error('Cannot re-parse GitLab MR URL');
    const res = await postMrComments(ref, body, toPost, ctx.pr.headSha);
    return { platform: 'gitlab', ...res };
  }
  throw new Error('Review did not originate from a GitHub/GitLab pull request');
}

function parseGitHubRef(fullName: string, number: number) {
  const [owner, repo] = fullName.split('/');
  return { owner, repo, number };
}

/** Render the full review as markdown (GitHub comments, CLI, downloads). */
export function reviewToMarkdown(record: ReviewRecord): string {
  const r = record.report;
  const lines: string[] = [];
  const verdictBadge: Record<string, string> = {
    APPROVE: '✅ APPROVE',
    APPROVE_WITH_COMMENTS: '🟡 APPROVE WITH COMMENTS',
    REQUEST_CHANGES: '🟠 REQUEST CHANGES',
    BLOCK_MERGE: '🔴 BLOCK MERGE',
  };
  lines.push(`## Code review — ${record.repoName} (${record.sourceType}: ${record.sourceRef})`);
  lines.push('');
  if (r) {
    lines.push(`**Recommendation: ${verdictBadge[r.recommendation] ?? r.recommendation}** · overall risk: ${r.overallRisk}`);
    lines.push('');
    lines.push(r.summary);
    lines.push('');
    if (r.positives.length) {
      lines.push('**What looks good**');
      for (const p of r.positives) lines.push(`- ${p}`);
      lines.push('');
    }
    const bySeverity = new Map<string, typeof r.findings>();
    for (const f of r.findings) {
      const list = bySeverity.get(f.severity) ?? [];
      list.push(f);
      bySeverity.set(f.severity, list);
    }
    const order = ['critical', 'high', 'medium', 'low'];
    for (const sev of order) {
      const list = bySeverity.get(sev);
      if (!list?.length) continue;
      lines.push(`### ${sev.toUpperCase()} (${list.length})`);
      for (const f of list) {
        lines.push(`#### [${f.id}] ${f.title}`);
        lines.push(`- **Location:** \`${f.location.file}${f.location.line ? `:${f.location.line}` : ''}\``);
        lines.push(`- **Category:** ${f.category} · **Confidence:** ${f.confidence} · **Reported by:** ${f.reportedBy.join(', ')}`);
        if (f.validation) {
          lines.push(`- **Cross-validation:** ${f.validation.verdict} by ${f.validation.validatorAgent} — ${f.validation.rationale}`);
        }
        lines.push('');
        lines.push(f.explanation);
        lines.push('');
        lines.push(`**Impact:** ${f.impact}`);
        lines.push('');
        lines.push(`**Recommendation:** ${f.recommendation}`);
        lines.push('');
      }
    }
    if (r.findings.length === 0) {
      lines.push('No significant issues found.');
      lines.push('');
    }
  } else if (record.stage === 'failed') {
    lines.push(`Review failed: ${record.error ?? 'unknown error'}`);
    lines.push('');
  }
  lines.push(`---`);
  lines.push(`<sub>Review id \`${record.id}\` · model \`${record.model}\` · ${record.changedFiles.length} files changed</sub>`);
  return lines.join('\n');
}

/** Compare two reviews of the same repo: new, resolved, persistent findings. */
export function compareReviews(a: ReviewRecord, b: ReviewRecord): {
  newFindings: { title: string; severity: string; file: string; line?: number }[];
  resolvedFindings: { title: string; severity: string; file: string; line?: number }[];
  persistentFindings: { title: string; severity: string; file: string; line?: number }[];
} {
  const key = (f: { title: string; location: { file: string; line?: number } }) =>
    `${f.location.file.toLowerCase()}|${normalizeTitle(f.title)}`;
  const normalizeTitle = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .sort()
      .join(' ');

  const aFindings = a.report?.findings ?? [];
  const bFindings = b.report?.findings ?? [];
  const aKeys = new Map(aFindings.map((f) => [key(f), f]));
  const bKeys = new Map(bFindings.map((f) => [key(f), f]));

  const newFindings = bFindings.filter((f) => !aKeys.has(key(f))).map(pick);
  const resolvedFindings = aFindings.filter((f) => !bKeys.has(key(f))).map(pick);
  const persistentFindings = bFindings.filter((f) => aKeys.has(key(f))).map(pick);
  return { newFindings, resolvedFindings, persistentFindings };

  function pick(f: (typeof aFindings)[number]) {
    return { title: f.title, severity: f.severity, file: f.location.file, line: f.location.line };
  }
}

export { SEVERITY_RANK };
