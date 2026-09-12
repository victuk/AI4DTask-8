import { z } from 'zod';

/**
 * Shared domain types for the code review system.
 *
 * Severity ranks how much damage the issue could cause; confidence ranks how
 * sure the reviewing agent is that the issue is real. Both drive the final
 * recommendation.
 */

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/** Bonus specialist agents beyond the six required ones. */
export const EXTRA_AGENT_IDS = ['database', 'concurrency', 'dependency'] as const;
export type ExtraAgentId = (typeof EXTRA_AGENT_IDS)[number];

/** All specialist agent ids, required + optional. */
export const SPECIALIST_IDS = [
  'correctness',
  'security',
  'architecture',
  'performance',
  'quality',
  'testing',
  ...EXTRA_AGENT_IDS,
] as const;
export type SpecialistId = (typeof SPECIALIST_IDS)[number];

export const FINDING_CATEGORIES = [
  'correctness',
  'security',
  'architecture',
  'performance',
  'quality',
  'testing',
  'database',
  'concurrency',
  'dependency',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/** Findings below this confidence are excluded from the report by default. */
export const DEFAULT_MIN_CONFIDENCE: Confidence = 'low';

export const REVIEW_SOURCES = ['diff', 'commit', 'pr', 'repository'] as const;
export type ReviewSource = (typeof REVIEW_SOURCES)[number];

export const RECOMMENDATIONS = [
  'APPROVE',
  'APPROVE_WITH_COMMENTS',
  'REQUEST_CHANGES',
  'BLOCK_MERGE',
] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

export const REVIEW_STAGES = [
  'pending',
  'preparing',
  'planning',
  'specialists',
  'cross-validation',
  'consolidation',
  'completed',
  'failed',
] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];

/** Location of a finding inside the repository. */
export const findingLocationSchema = z.object({
  /** Repo-relative file path. */
  file: z.string().describe('Repository-relative path of the affected file'),
  /** 1-based line in the NEW (post-change) version of the file. */
  line: z.number().int().positive().optional().describe('Line number in the new version of the file'),
  endLine: z.number().int().positive().optional(),
  /** Snippet the finding refers to (a few lines of the new code). */
  snippet: z.string().max(1200).optional().describe('Short code excerpt the finding refers to'),
});

/** A single review finding, as returned by a specialist agent. */
export const findingSchema = z.object({
  id: z.string().describe('Stable short id, unique within one agent report, e.g. sec-1'),
  title: z.string().min(3).max(140).describe('Short imperative title, e.g. "SQL built by string concatenation"'),
  category: z.enum(FINDING_CATEGORIES),
  severity: z.enum(SEVERITIES).describe('critical > high > medium > low'),
  confidence: z.enum(CONFIDENCE_LEVELS).describe('How sure you are this is a real issue'),
  location: findingLocationSchema,
  explanation: z.string().min(10).describe('What is wrong and why, referencing the actual code'),
  impact: z.string().min(5).describe('Concrete consequence if shipped'),
  recommendation: z.string().min(5).describe('How to fix it, concretely'),
});

export type Finding = z.infer<typeof findingSchema>;

export const agentReportSchema = z.object({
  agent: z.string().describe('Specialist agent id that produced this report'),
  summary: z.string().describe('One paragraph summary of what was reviewed and the overall state'),
  findings: z.array(findingSchema),
  filesInspected: z.array(z.string()).describe('Repository files actually read beyond the diff, if any'),
});

export type AgentReport = z.infer<typeof agentReportSchema>;

/** Result of cross-validating one finding. */
export const validationResultSchema = z.object({
  findingId: z.string(),
  validatorAgent: z.string(),
  verdict: z.enum(['confirmed', 'refuted', 'downgraded']),
  severity: z.enum(SEVERITIES).optional().describe('Adjusted severity when downgraded'),
  rationale: z.string().describe('Why the verdict was reached, referencing code'),
});

export type ValidationResult = z.infer<typeof validationResultSchema>;

/** A consolidated finding in the final report. */
export const consolidatedFindingSchema = findingSchema.extend({
  /** Canonical id in the final report, e.g. F1. */
  id: z.string(),
  /** Ids of the specialist findings merged into this one. */
  sources: z.array(z.string()),
  /** Specialist agents that reported it. */
  reportedBy: z.array(z.string()),
  /** Present when a validator adjusted severity. */
  validation: validationResultSchema.optional(),
});

export type ConsolidatedFinding = z.infer<typeof consolidatedFindingSchema>;

/** Plan produced by the supervisor deciding which specialists to invoke. */
export const reviewPlanSchema = z.object({
  changeType: z.string().describe('One-sentence description of what the change does'),
  riskProfile: z.string().describe('One-sentence overall risk assessment'),
  specialists: z.array(
    z.object({
      agent: z.enum(SPECIALIST_IDS),
      relevance: z.enum(['high', 'medium', 'low']),
      focus: z.string().describe('What this specialist should concentrate on for this change'),
    }),
  ),
  reasoning: z.string().describe('Why these specialists and not the others'),
});

export type ReviewPlan = z.infer<typeof reviewPlanSchema>;

export const reviewPlanStepSchema = z.object({
  plan: reviewPlanSchema,
});

export type ReviewPlanStepOutput = z.infer<typeof reviewPlanStepSchema>;

export const consolidationSchema = z.object({
  summary: z.string().describe('Executive summary of the whole review, 3-8 sentences'),
  overallRisk: z.enum(['none', 'low', 'moderate', 'high', 'severe']),
  recommendation: z.enum(RECOMMENDATIONS),
  findings: z.array(consolidatedFindingSchema),
  positives: z.array(z.string()).describe('Things the change does well, if any'),
});

export type ConsolidationResult = z.infer<typeof consolidationSchema>;

/** Statistical summary of a review stored in history lists. */
export const reviewSummarySchema = z.object({
  id: z.string(),
  repoPath: z.string(),
  repoName: z.string(),
  sourceType: z.enum(REVIEW_SOURCES),
  sourceRef: z.string(),
  createdAt: z.string(),
  stage: z.enum(REVIEW_STAGES),
  recommendation: z.enum(RECOMMENDATIONS).optional(),
  overallRisk: z.string().optional(),
  findingCounts: z.record(z.enum(SEVERITIES), z.number()),
  specialistsRun: z.array(z.string()),
  durationMs: z.number(),
  model: z.string(),
});

export type ReviewSummary = z.infer<typeof reviewSummarySchema>;

/** Full persisted record of a review. */
export const reviewRecordSchema = z.object({
  id: z.string(),
  repoPath: z.string(),
  repoName: z.string(),
  sourceType: z.enum(REVIEW_SOURCES),
  sourceRef: z.string(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  stage: z.enum(REVIEW_STAGES),
  error: z.string().optional(),
  model: z.string(),
  plan: reviewPlanSchema.optional(),
  changedFiles: z.array(z.string()),
  diff: z.string(),
  diffStats: z.string().optional(),
  agentActivities: z.array(
    z.object({
      agent: z.string(),
      status: z.enum(['pending', 'running', 'done', 'skipped', 'error']),
      startedAt: z.string().optional(),
      finishedAt: z.string().optional(),
      summary: z.string().optional(),
      filesInspected: z.array(z.string()).optional(),
      findingCount: z.number().optional(),
      error: z.string().optional(),
    }),
  ),
  validations: z.array(validationResultSchema),
  report: consolidationSchema.optional(),
  usage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      totalTokens: z.number(),
    })
    .optional(),
  durationMs: z.number().optional(),
});

export type ReviewRecord = {
  id: string;
  repoPath: string;
  repoName: string;
  sourceType: ReviewRecordSource['sourceType'];
  sourceRef: string;
  title?: string;
  createdAt: string;
  completedAt?: string;
  stage: ReviewRecordSource['stage'];
  error?: string;
  model: string;
  plan?: ReviewPlan;
  changedFiles: string[];
  diff: string;
  diffStats?: string;
  agentActivities: ReviewRecordSource['agentActivities'];
  validations: ValidationResult[];
  /** Raw per-specialist reports, kept for drill-down and history. */
  reports: AgentReport[];
  report?: ConsolidationResult;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  durationMs?: number;
};

type ReviewRecordSource = z.infer<typeof reviewRecordSchema>;

export const reviewStartResultSchema = z.object({
  reviewId: z.string(),
});
export type ReviewStartResult = z.infer<typeof reviewStartResultSchema>;

/** Input to the review workflow. */
export const reviewInputSchema = z.object({
  reviewId: z.string().describe('Pre-registered review id'),
});
export type ReviewInput = z.infer<typeof reviewInputSchema>;

/** Options a user can pass when starting a review. */
export const reviewOptionsSchema = z.object({
  minConfidence: z.enum(CONFIDENCE_LEVELS).default('low'),
  maxFindings: z.number().int().positive().max(100).default(40),
  /** Skip cross-validation of high severity findings. */
  skipValidation: z.boolean().default(false),
  /** Post inline comments to a PR when supported (GitHub/GitLab token required). */
  postComments: z.boolean().default(false),
  /** Post a single summary comment instead of inline comments. */
  postSummaryOnly: z.boolean().default(false),
  /** Additional repository-specific review rules (plain text). */
  customRules: z.string().max(20000).optional(),
});

export type ReviewOptions = z.infer<typeof reviewOptionsSchema>;

export const DEFAULT_REVIEW_OPTIONS: ReviewOptions = {
  minConfidence: 'low',
  maxFindings: 40,
  skipValidation: false,
  postComments: false,
  postSummaryOnly: false,
};

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export const CONFIDENCE_RANK: Record<Confidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};
