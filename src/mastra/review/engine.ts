import { z } from 'zod';
import type { Agent } from '@mastra/core/agent';
import type {
  AgentReport,
  ConsolidatedFinding,
  ReviewPlan,
  Severity,
  ValidationResult,
} from '../types.js';
import { CONFIDENCE_RANK, SEVERITY_RANK } from '../types.js';
import { specialists } from '../agents/specialists.js';
import type { ReviewContext } from './review-context.js';
import { addedLineNumbers } from './diff-parser.js';
import { findingsToText } from './prompt-utils.js';
import { isLineInChangedRange } from '../tools/review-tools.js';
import { getReviewStore } from './store.js';

/**
 * The agentic review engine. The Supervisor plans which specialists run; each
 * specialist runs as a real agent with repository inspection tools; high
 * severity findings are cross-validated by a second relevant specialist; the
 * Supervisor consolidates everything into the final report.
 */

const REVIEW_NOTE_KEY = 'agentReviewNote';

/** Plan schema mirrors types.ts reviewPlanSchema (kept local to avoid dual import paths). */
const planSchema = z.object({
  changeType: z.string(),
  riskProfile: z.string(),
  specialists: z.array(
    z.object({
      agent: z.enum([
        'correctness', 'security', 'architecture', 'performance', 'quality', 'testing',
        'database', 'concurrency', 'dependency',
      ]),
      relevance: z.enum(['high', 'medium', 'low']),
      focus: z.string(),
    }),
  ),
  reasoning: z.string(),
});

const findingSchema = z.object({
  id: z.string(),
  title: z.string().min(3).max(140),
  category: z.enum([
    'correctness', 'security', 'architecture', 'performance', 'quality', 'testing',
    'database', 'concurrency', 'dependency',
  ]),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  confidence: z.enum(['high', 'medium', 'low']),
  location: z.object({
    file: z.string(),
    line: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    snippet: z.string().max(1200).optional(),
  }),
  explanation: z.string().min(10),
  impact: z.string().min(5),
  recommendation: z.string().min(5),
});

const reportSchema = z.object({
  summary: z.string(),
  findings: z.array(findingSchema),
  filesInspected: z.array(z.string()).default([]),
});

const validationSchema = z.object({
  verdict: z.enum(['confirmed', 'refuted', 'downgraded']),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  rationale: z.string(),
});

const consolidationSchema = z.object({
  summary: z.string(),
  overallRisk: z.enum(['none', 'low', 'moderate', 'high', 'severe']),
  recommendation: z.enum(['APPROVE', 'APPROVE_WITH_COMMENTS', 'REQUEST_CHANGES', 'BLOCK_MERGE']),
  findings: z.array(
    findingSchema.extend({
      sources: z.array(z.string()).default([]),
      reportedBy: z.array(z.string()).default([]),
    }),
  ),
  positives: z.array(z.string()).default([]),
});

export type ProgressEvent =
  | { type: 'stage'; stage: string }
  | { type: 'plan'; plan: ReviewPlan }
  | { type: 'agent-start'; agent: string }
  | { type: 'agent-end'; agent: string; report: AgentReport }
  | { type: 'agent-error'; agent: string; error: string }
  | { type: 'validation-start'; agent: string }
  | { type: 'validation-end'; agent: string; results: ValidationResult[] }
  | { type: 'consolidated'; report: ConsolidatedFinding[] };

export type ProgressListener = (event: ProgressEvent) => void | Promise<void>;

const MODEL_OPTIONS = {
  maxSteps: Number(process.env.REVIEW_MAX_STEPS ?? 14),
  temperature: 0.1,
} as const;

async function generateStructured(agent: Agent, prompt: string, schema: z.ZodTypeAny, maxSteps: number, requestContext: import('@mastra/core/request-context').RequestContext): Promise<unknown> {
  const opts = {
    maxSteps,
    temperature: 0.1,
    structuredOutput: { schema, jsonPromptInjection: 'auto' as const },
    requestContext,
  };
  // Small/local models sometimes return nothing parseable on the first try;
  // retry once with an explicit reminder before failing the whole stage.
  try {
    const res = await agent.generate(prompt, opts);
    if (res.object !== undefined) return res.object;
  } catch (err) {
    if (!/validation|schema|structured/i.test(err instanceof Error ? err.message : '')) throw err;
  }
  const reminder = `${prompt}\n\nIMPORTANT: your previous response was not valid for the required schema. Respond ONLY with the structured object now.`;
  const res = await agent.generate(reminder, opts);
  return res.object;
}

async function runAgent(agentId: keyof typeof specialists, prompt: string, ctx: ReviewContext): Promise<{ object: unknown; usage?: { inputTokens: number; outputTokens: number; totalTokens: number } }> {
  const specialist = specialists[agentId];
  const { RequestContext } = await import('@mastra/core/request-context');
  const requestContext = new RequestContext();
  requestContext.set(REVIEW_NOTE_KEY, ctx);
  const object = await generateStructured(specialist.agent, prompt, reportSchema, MODEL_OPTIONS.maxSteps, requestContext);
  return { object };
}

async function runSupervisor<T extends z.ZodTypeAny>(
  prompt: string,
  schema: T,
  ctx: ReviewContext,
): Promise<z.infer<T>> {
  const { RequestContext } = await import('@mastra/core/request-context');
  const requestContext = new RequestContext();
  requestContext.set(REVIEW_NOTE_KEY, ctx);
  const { supervisorAgent } = await import('../agents/supervisor.js');
  const object = await generateStructured(supervisorAgent, prompt, schema, Number(process.env.REVIEW_SUPERVISOR_STEPS ?? 20), requestContext);
  return object as z.infer<T>;
}

const HIGH_SEVERITIES: Severity[] = ['critical', 'high'];

/** Severity of the most severe finding a specialist should verify. */
function highestSeverity(findings: { severity: Severity }[]): Severity {
  return findings.reduce<Severity>((acc, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[acc] ? f.severity : acc), 'low');
}

export class ReviewEngine {
  constructor(
    private ctx: ReviewContext,
    private progress: ProgressListener = () => {},
    private onUsage?: (usage: { inputTokens: number; outputTokens: number; totalTokens: number }) => void,
  ) {}

  private async emit(event: ProgressEvent): Promise<void> {
    await this.progress(event);
  }

  /** Supervisor planning: choose relevant specialists + focus notes. */
  async plan(): Promise<ReviewPlan> {
    await this.emit({ type: 'stage', stage: 'planning' });
    const prompt = `Plan this code review.

Change under review: ${this.ctx.title}
${this.ctx.description ? `Description:\n${this.ctx.description.slice(0, 3000)}\n` : ''}
Changed files (${this.ctx.changedFiles.length}):
${this.ctx.changedFiles.map((f) => `- ${f}`).join('\n')}

Diff stat${this.ctx.diffStats ? '' : ' (approximate)'}:
${(this.ctx.diffStats ?? this.ctx.changedFiles.map((f) => f).join('\n')).slice(0, 2500)}

${this.ctx.repoPath ? 'The full repository is available to you for inspection.' : 'Only the diff is available (no repository snapshot); plan accordingly.'}

First, look at the change (get_review_diff) and skim the repository structure if available. Then decide which specialists are relevant. Rules:
- Include a specialist only when its area can genuinely be affected. Quality: include for most non-trivial changes. Testing: include when the change adds/modifies testable behavior.
- For every included specialist write a concrete focus: files to prioritize and what to look for in THIS change.
- Do not include specialists with no plausible connection to the change; instead explain in reasoning why each excluded one is irrelevant.`;

    let plan: ReviewPlan;
    try {
      const raw = await runSupervisor(prompt, planSchema, this.ctx);
      plan = {
        changeType: raw.changeType,
        riskProfile: raw.riskProfile,
        reasoning: raw.reasoning,
        specialists: raw.specialists.filter((s) => s.agent in specialists),
      };
    } catch (err) {
      // Fallback: run the full panel rather than failing the review because
      // the model could not produce a plan.
      plan = {
        changeType: this.ctx.title,
        riskProfile: 'unassessed (planning failed, running full panel)',
        reasoning: `Supervisor planning failed (${err instanceof Error ? err.message : String(err)}); falling back to the full specialist panel.`,
        specialists: (Object.keys(specialists) as (keyof typeof specialists)[]).map((agent) => ({
          agent,
          relevance: 'medium' as const,
          focus: 'Review the entire diff for issues in your specialty.',
        })),
      };
    }
    const normalized = plan;
    // Optional allowlist (REVIEW_AGENTS=correctness,security) — useful to
    // bound cost or focus a review on specific areas.
    const allowlist = (process.env.REVIEW_AGENTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s in specialists);
    if (allowlist.length > 0) {
      const filtered = normalized.specialists.filter((s) => allowlist.includes(s.agent));
      if (filtered.length > 0) normalized.specialists = filtered;
    }
    if (normalized.specialists.length === 0) {
      const fallbackAgent = (allowlist[0] ?? 'correctness') as keyof typeof specialists;
      normalized.specialists = [{ agent: fallbackAgent, relevance: 'high', focus: 'Review the entire diff for issues in your specialty.' }];
    }
    await this.emit({ type: 'plan', plan: normalized });
    return normalized;
  }

  /** Run one specialist agent with the supervisor's focus notes. */
  async runSpecialist(agentId: keyof typeof specialists, plan: ReviewPlan): Promise<AgentReport> {
    const def = specialists[agentId];
    const focus = plan.specialists.find((s) => s.agent === agentId)?.focus ?? 'Review the diff thoroughly.';
    const diffOverview = this.ctx.parsed.files
      .map((f) => `- ${f.path} [${f.changeType}, +${f.additions}/-${f.deletions}]`)
      .join('\n');

    const prompt = `Review this change from your specialty: ${def.name}.

Change: ${this.ctx.title}
${this.ctx.description ? `Description: ${this.ctx.description.slice(0, 1500)}` : ''}
Repository: ${this.ctx.repoName}${this.ctx.repoPath ? '' : ' (diff only — no repo snapshot available)'}
Overall review plan: ${plan.changeType} — risk: ${plan.riskProfile}

Changed files:
${diffOverview}

Supervisor focus for you: ${focus}

Method: start with get_review_diff (overview), then per-file diffs, then read repo context around every suspicious area before reporting. Report at most 10 findings via the structured output. If nothing rises to a reportable issue in your specialty, return an empty findings list — do not invent issues.
Each finding's location.file must be a repository-relative path EXACTLY as it appears in the changed files list (or another repo file you actually inspected), and location.line must be a NEW-file line number from the numbered diff you retrieved.`;

    await this.emit({ type: 'agent-start', agent: agentId });
    const store = getReviewStore();
    await store.updateStage(this.ctx.reviewId, 'specialists');
    const started = Date.now();
    try {
      const { object, usage } = await runAgent(agentId, prompt, this.ctx);
      const parsed = reportSchema.parse(object);
      const report: AgentReport = {
        agent: agentId,
        summary: parsed.summary,
        findings: parsed.findings.map((f, i) => ({
          id: `${agentId}-${i + 1}`,
          title: f.title,
          category: f.category,
          severity: f.severity,
          confidence: f.confidence,
          location: f.location,
          explanation: f.explanation,
          impact: f.impact,
          recommendation: f.recommendation,
        })),
        filesInspected: parsed.filesInspected ?? [],
      };
      if (usage && this.onUsage) this.onUsage(usage);
      await store.addAgentReport(this.ctx.reviewId, report, Date.now() - started);
      await this.emit({ type: 'agent-end', agent: agentId, report });
      return report;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await store.setAgentError(this.ctx.reviewId, agentId, message);
      await this.emit({ type: 'agent-error', agent: agentId, error: message });
      return { agent: agentId, summary: `Specialist failed: ${message}`, findings: [], filesInspected: [] };
    }
  }

  /**
   * Cross-validate high severity findings: each is checked by another relevant
   * specialist (never the reporting agent). Refuted findings are dropped;
   * downgraded ones get their severity adjusted.
   */
  async crossValidate(
    reports: AgentReport[],
    plan: ReviewPlan,
  ): Promise<ValidationResult[]> {
    const candidates: { report: AgentReport; finding: AgentReport['findings'][number] }[] = [];
    for (const report of reports) {
      for (const f of report.findings) {
        if (HIGH_SEVERITIES.includes(f.severity)) candidates.push({ report, finding: f });
      }
    }
    if (candidates.length === 0 || this.ctx.options.skipValidation) return [];

    await this.emit({ type: 'stage', stage: 'cross-validation' });
    const store = getReviewStore();
    const validations: ValidationResult[] = [];
    const selected = plan.specialists.map((s) => s.agent).filter((a) => a in specialists);

    // Group candidates by a validator distinct from the reporter.
    const byValidator = new Map<string, { report: AgentReport; finding: AgentReport['findings'][number] }[]>();
    for (const c of candidates) {
      const others = selected.filter((a) => a !== c.report.agent);
      // Prefer a specialist from the plan different from reporter; else any specialist except reporter.
      const pool = others.length > 0 ? others : (Object.keys(specialists) as (keyof typeof specialists)[]).filter((a) => a !== c.report.agent);
      // Choose the pool member with overlapping category if any, else round-robin by finding index.
      const overlap = pool.find((a) => a === c.finding.category);
      const validator = overlap ?? pool[Math.abs(hash(c.finding.id)) % pool.length];
      const list = byValidator.get(validator) ?? [];
      list.push(c);
      byValidator.set(validator, list);
    }

    const severitySchema = z.enum(['critical', 'high', 'medium', 'low']);

    for (const [validator, list] of byValidator) {
      const def = specialists[validator as keyof typeof specialists];
      if (!def) continue;
      await this.emit({ type: 'validation-start', agent: validator });
      const prompt = `You are the second reviewer cross-validating ${list.length} ${list.map((c) => c.finding.severity).join('/')} severity finding(s) reported by other specialists on this change.

Change: ${this.ctx.title}
Changed files: ${this.ctx.changedFiles.join(', ')}

Findings to validate:
${findingsToText(list.map((c) => ({ id: c.finding.id, title: c.finding.title, severity: c.finding.severity, location: c.finding.location, explanation: c.finding.explanation })))}

For EACH finding: read the actual code (get_review_diff for the file, read_repo_file / search_repo_text for context) and decide:
- "confirmed" if the code genuinely has this problem with the claimed severity,
- "downgraded" if the problem exists but is less severe than claimed (set the correct severity),
- "refuted" if the code does NOT actually have this problem (e.g. a guard exists elsewhere, the claim misreads the code, or it is pre-existing rather than introduced by this change) — explain exactly where the protection is.

Be rigorous and independent: your job is to kill false positives. Verdict for every finding id via structured output.`;

      try {
        const { RequestContext } = await import('@mastra/core/request-context');
        const requestContext = new RequestContext();
        requestContext.set(REVIEW_NOTE_KEY, this.ctx);
        const object = await generateStructured(
          def.agent,
          prompt,
          z.object({ verdicts: z.array(validationSchema.extend({ findingId: z.string() })) }),
          18,
          requestContext,
        );
        const parsed = z.object({ verdicts: z.array(validationSchema.extend({ findingId: z.string() })) }).parse(object);
        for (const v of parsed.verdicts) {
          if (!list.some((c) => c.finding.id === v.findingId)) continue;
          validations.push({
            findingId: v.findingId,
            validatorAgent: validator,
            verdict: v.verdict,
            severity: v.severity,
            rationale: v.rationale,
          });
        }
      } catch {
        // Validation is best-effort; findings stand as reported if validation fails.
      }
      await this.emit({ type: 'validation-end', agent: validator, results: validations });
    }

    await store.setValidations(this.ctx.reviewId, validations);
    return validations;
  }

  /** Supervisor consolidation: dedupe, merge, prioritize, recommend. */
  async consolidate(reports: AgentReport[], plan: ReviewPlan, validations: ValidationResult[]): Promise<{ report: import('../types.js').ConsolidationResult }> {
    await this.emit({ type: 'stage', stage: 'consolidation' });
    const all: (AgentReport['findings'][number] & { reportedBy: string })[] = reports.flatMap((r) =>
      r.findings.map((f) => ({ ...f, reportedBy: r.agent })),
    );

    // Drop findings whose locations are clearly outside the change (guardrail against hallucinated lines).
    const inScope = all.filter((f) => {
      if (!f.location?.file) return false;
      const known = this.ctx.changedFiles.includes(f.location.file) || this.ctx.parsed.files.some((p) => p.oldPath === f.location.file);
      if (!known) return f.category === 'testing' || f.category === 'architecture'; // allow repo-level findings
      return isLineInChangedRange(this.ctx, f.location.file, f.location.line) || f.category === 'testing' || f.confidence !== 'high';
    });

    const validationText = validations.length
      ? validations
          .map((v) => `[${v.findingId}] ${v.verdict}${v.severity ? ` (severity now ${v.severity})` : ''} by ${v.validatorAgent}: ${v.rationale}`)
          .join('\n')
      : 'No cross-validation was performed.';

    const prompt = `Consolidate this code review into the final report.

Change: ${this.ctx.title}
Repository: ${this.ctx.repoName}
Plan reasoning: ${plan.reasoning}

Specialist summaries:
${reports.map((r) => `- ${r.agent}: ${r.summary}`).join('\n')}

All findings (id | reporter | severity | confidence | location | title):
${all.map((f) => `[${f.id}] ${f.reportedBy} | ${f.severity} | ${f.confidence} | ${f.location.file}${f.location.line ? `:${f.location.line}` : ''} | ${f.title}\n    ${f.explanation}`).join('\n')}

Cross-validation outcomes (refuted findings must be dropped; downgraded ones take the adjusted severity):
${validationText}

Rules:
- MERGE duplicates/overlaps: same root cause from different agents becomes ONE finding. List every source finding id in "sources" and every reporter in "reportedBy". Keep the clearest title, the most complete explanation, and the highest severity justified by evidence.
- Drop subjective style nits and any finding that cross-validation refuted. When confidence is low AND severity is low, consider dropping.
- CONFIRMED high/critical findings keep their severity; findings downgraded by validation take the validated severity.
- Re-number consolidated findings F1, F2, ... ordered by severity then confidence (most severe first).
- recommendation: BLOCK_MERGE if any confirmed critical; REQUEST_CHANGES if any confirmed high or a pattern of mediums; APPROVE_WITH_COMMENTS for mediums/lows worth addressing; APPROVE if only lows or nothing.
- overallRisk: none|low|moderate|high|severe matching the worst confirmed finding.
- summary: 3-8 sentences an engineer can act on. Name the top problems with file:line.
- positives: 0-4 things done well (only if genuinely true).

Findings passed to you (already scope-checked): ${inScope.length} of ${all.length}.`;

    let result: z.infer<typeof consolidationSchema>;
    try {
      result = await runSupervisor(prompt, consolidationSchema, this.ctx);
    } catch (err) {
      // Deterministic fallback: dedupe/sort/merge without the model so a
      // consolidation failure never destroys an otherwise complete review.
      result = fallbackConsolidation(inScope, validations);
    }
    const consolidated: ConsolidatedFinding[] = result.findings.map((f, i) => {
      const validation = validations.find((v) => v.findingId === (f.sources[0] ?? `F${i + 1}`));
      return {
        ...f,
        id: `F${i + 1}`,
        sources: f.sources ?? [],
        reportedBy: f.reportedBy?.length ? f.reportedBy : [...new Set(all.filter((a) => f.sources?.includes(a.id)).map((a) => a.reportedBy))],
        validation: validation
          ? { findingId: validation.findingId, validatorAgent: validation.validatorAgent, verdict: validation.verdict, severity: validation.severity, rationale: validation.rationale }
          : undefined,
      };
    });
    await this.emit({ type: 'consolidated', report: consolidated });
    return {
      report: {
        summary: result.summary,
        overallRisk: result.overallRisk,
        recommendation: result.recommendation,
        findings: consolidated,
        positives: result.positives ?? [],
      },
    };
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * Model-free consolidation: merge near-duplicate findings (same file and
 * similar title), apply validation verdicts, sort by severity/confidence, and
 * derive the recommendation. Used when the supervisor's consolidation call
 * fails so completed specialist work is never lost.
 */
function fallbackConsolidation(
  findings: (AgentReport['findings'][number] & { reportedBy: string })[],
  validations: ValidationResult[],
): import('../types.js').ConsolidationResult {
  const norm = (t: string) =>
    t.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter((w) => w.length > 2).sort().join(' ');
  type Group = (AgentReport['findings'][number] & { reportedBy: string; sources: string[] })[];
  const groups = new Map<string, Group>();
  for (const f of findings) {
    const key = `${f.location.file.toLowerCase()}|${norm(f.title).split(' ').slice(0, 4).join(' ')}`;
    const list = groups.get(key) ?? [];
    list.push({ ...f, sources: [f.id] });
    groups.set(key, list);
  }

  const merged: ConsolidatedFinding[] = [];
  let n = 0;
  for (const group of groups.values()) {
    n += 1;
    const best = group.reduce((a, b) =>
      SEVERITY_RANK[b.severity] * 10 + CONFIDENCE_RANK[b.confidence] > SEVERITY_RANK[a.severity] * 10 + CONFIDENCE_RANK[a.confidence] ? b : a,
    );
    const validation = validations.find((v) => group.some((g) => g.id === v.findingId));
    let severity = best.severity;
    if (validation?.verdict === 'downgraded' && validation.severity) severity = validation.severity;
    merged.push({
      ...best,
      id: `F${n}`,
      severity,
      sources: group.flatMap((g) => g.sources),
      reportedBy: [...new Set(group.map((g) => g.reportedBy))],
      validation,
    });
  }

  merged.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence]);
  merged.forEach((f, i) => (f.id = `F${i + 1}`));

  const hasCritical = merged.some((f) => f.severity === 'critical');
  const hasHigh = merged.some((f) => f.severity === 'high');
  const recommendation = hasCritical ? 'BLOCK_MERGE' : hasHigh ? 'REQUEST_CHANGES' : merged.length > 0 ? 'APPROVE_WITH_COMMENTS' : 'APPROVE';
  const worst = merged[0]?.severity;
  const overallRisk = hasCritical ? 'severe' : hasHigh ? 'high' : worst === 'medium' ? 'moderate' : merged.length > 0 ? 'low' : 'none';
  const counts = merged
    .slice(0, 3)
    .map((f) => `${f.severity}-severity issue in ${f.location.file}${f.location.line ? `:${f.location.line}` : ''} (${f.title})`);
  const summary = counts.length
    ? `Review found ${merged.length} issue(s): ${counts.join('; ')}. See the findings list for details and recommended fixes.`
    : 'No reportable issues were found in the reviewed change.';
  return { summary, overallRisk, recommendation, findings: merged, positives: [] };
}

export { REVIEW_NOTE_KEY };
