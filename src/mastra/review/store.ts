import { createClient, type Client, type InValue } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ReviewRecord,
  ReviewStage,
  Recommendation,
  Severity,
  AgentReport,
  ReviewPlan,
  ConsolidationResult,
  ValidationResult,
} from '../types.js';
import { SEVERITIES } from '../types.js';

/**
 * Review history store backed by LibSQL (local file by default). Reviews are
 * persisted at every stage so the UI can watch progress and users can revisit
 * past reviews.
 */

export interface ReviewSourceInput {
  repoPath: string;
  sourceType: 'diff' | 'commit' | 'pr' | 'repository';
  sourceRef: string;
  diff: string;
  diffStats?: string;
  changedFiles: string[];
  options?: Record<string, unknown>;
}

function emptyCounts(): Record<Severity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

export class ReviewStore {
  private client: Client;
  private initialized = false;

  constructor(url?: string) {
    const dbUrl = url ?? process.env.REVIEW_DB_URL ?? 'file:./reviews.db';
    if (dbUrl.startsWith('file:')) {
      const filePath = dbUrl.slice('file:'.length);
      const dir = path.dirname(filePath.startsWith('/') ? filePath : path.resolve(process.cwd(), filePath));
      fs.mkdirSync(dir, { recursive: true });
    }
    this.client = createClient({ url: dbUrl });
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        stage TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        model TEXT NOT NULL,
        plan_json TEXT,
        diff TEXT,
        diff_stats TEXT,
        changed_files_json TEXT,
        agent_activities_json TEXT NOT NULL DEFAULT '[]',
        reports_json TEXT NOT NULL DEFAULT '[]',
        validations_json TEXT NOT NULL DEFAULT '[]',
        report_json TEXT,
        summary TEXT,
        overall_risk TEXT,
        recommendation TEXT,
        severity_counts_json TEXT,
        specialists_json TEXT,
        usage_json TEXT,
        duration_ms INTEGER,
        options_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_reviews_created ON reviews (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_reviews_repo ON reviews (repo_name);
    `);
    this.initialized = true;
  }

  async createReview(input: ReviewSourceInput, model: string): Promise<string> {
    await this.init();
    const id = `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await this.client.execute({
      sql: `INSERT INTO reviews (id, repo_path, repo_name, source_type, source_ref, title, created_at, stage, model, diff, diff_stats, changed_files_json, agent_activities_json, options_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?, ?, '[]', ?)`,
      args: [
        id,
        input.repoPath,
        path.basename(path.resolve(input.repoPath)),
        input.sourceType,
        input.sourceRef,
        input.sourceRef,
        new Date().toISOString(),
        model,
        input.diff,
        input.diffStats ?? null,
        JSON.stringify(input.changedFiles),
        JSON.stringify(input.options ?? {}),
      ] satisfies InValue[],
    });
    return id;
  }

  async updateStage(id: string, stage: ReviewStage): Promise<void> {
    await this.init();
    await this.client.execute({
      sql: `UPDATE reviews SET stage = ? WHERE id = ?`,
      args: [stage, id],
    });
  }

  /** Fill in resolved source metadata once the context is prepared. */
  async updateReviewTarget(
    id: string,
    target: { repoPath: string; repoName: string; title: string; diff: string; diffStats?: string; changedFiles: string[] },
  ): Promise<void> {
    await this.init();
    await this.client.execute({
      sql: `UPDATE reviews SET repo_path = ?, repo_name = ?, title = ?, diff = ?, diff_stats = ?, changed_files_json = ? WHERE id = ?`,
      args: [
        target.repoPath,
        target.repoName,
        target.title,
        target.diff,
        target.diffStats ?? null,
        JSON.stringify(target.changedFiles),
        id,
      ] satisfies InValue[],
    });
  }

  async setError(id: string, error: string): Promise<void> {
    await this.init();
    await this.client.execute({
      sql: `UPDATE reviews SET stage = 'failed', error = ?, completed_at = ? WHERE id = ?`,
      args: [error.slice(0, 4000), new Date().toISOString(), id],
    });
  }

  async setPlan(id: string, plan: ReviewPlan): Promise<void> {
    await this.init();
    await this.client.execute({
      sql: `UPDATE reviews SET plan_json = ?, stage = 'specialists' WHERE id = ?`,
      args: [JSON.stringify(plan), id],
    });
  }

  async setAgentActivities(id: string, activities: ReviewRecord['agentActivities']): Promise<void> {
    await this.init();
    await this.client.execute({
      sql: `UPDATE reviews SET agent_activities_json = ? WHERE id = ?`,
      args: [JSON.stringify(activities), id],
    });
  }

  async addAgentReport(id: string, report: AgentReport, durationMs: number): Promise<void> {
    await this.init();
    const row = await this.getReview(id);
    if (!row) return;
    const reports = row.reports.filter((r) => r.agent !== report.agent);
    reports.push(report);
    const activities = row.agentActivities.map((a) =>
      a.agent === report.agent
        ? {
            ...a,
            status: 'done' as const,
            finishedAt: new Date().toISOString(),
            summary: report.summary,
            filesInspected: report.filesInspected,
            findingCount: report.findings.length,
          }
        : a,
    );
    await this.client.execute({
      sql: `UPDATE reviews SET reports_json = ?, agent_activities_json = ?, duration_ms = COALESCE(duration_ms, 0) + ? WHERE id = ?`,
      args: [JSON.stringify(reports), JSON.stringify(activities), durationMs, id],
    });
  }

  async setAgentError(id: string, agent: string, error: string): Promise<void> {
    await this.init();
    const row = await this.getReview(id);
    if (!row) return;
    const activities = row.agentActivities.map((a) =>
      a.agent === agent ? { ...a, status: 'error' as const, finishedAt: new Date().toISOString(), error: error.slice(0, 1000) } : a,
    );
    await this.client.execute({
      sql: `UPDATE reviews SET agent_activities_json = ? WHERE id = ?`,
      args: [JSON.stringify(activities), id],
    });
  }

  async setValidations(id: string, validations: ValidationResult[]): Promise<void> {
    await this.init();
    await this.client.execute({
      sql: `UPDATE reviews SET validations_json = ?, stage = 'consolidation' WHERE id = ?`,
      args: [JSON.stringify(validations), id],
    });
  }

  async completeReview(id: string, report: ConsolidationResult, usage?: { inputTokens: number; outputTokens: number; totalTokens: number }, durationMs?: number): Promise<void> {
    await this.init();
    const counts = emptyCounts();
    for (const f of report.findings) counts[f.severity] += 1;
    const specialists = [...new Set(report.findings.flatMap((f) => f.reportedBy))];
    await this.client.execute({
      sql: `UPDATE reviews SET
              report_json = ?, summary = ?, overall_risk = ?, recommendation = ?,
              severity_counts_json = ?, specialists_json = ?, usage_json = ?,
              duration_ms = COALESCE(?, duration_ms), stage = 'completed', completed_at = ?
            WHERE id = ?`,
      args: [
        JSON.stringify(report),
        report.summary,
        report.overallRisk,
        report.recommendation,
        JSON.stringify(counts),
        JSON.stringify(specialists),
        usage ? JSON.stringify(usage) : null,
        durationMs ?? null,
        new Date().toISOString(),
        id,
      ] satisfies InValue[],
    });
  }

  async getReview(id: string): Promise<ReviewRecord | undefined> {
    await this.init();
    const res = await this.client.execute({ sql: `SELECT * FROM reviews WHERE id = ?`, args: [id] });
    if (res.rows.length === 0) return undefined;
    return this.rowToRecord(res.rows[0]);
  }

  async listReviews(limit = 50, repoName?: string): Promise<
    {
      id: string;
      repoName: string;
      sourceType: string;
      sourceRef: string;
      createdAt: string;
      stage: ReviewStage;
      recommendation?: Recommendation;
      overallRisk?: string;
      severityCounts: Record<Severity, number>;
      totalFindings: number;
      durationMs?: number;
    }[]
  > {
    await this.init();
    const res = repoName
      ? await this.client.execute({
          sql: `SELECT id, repo_name, source_type, source_ref, created_at, stage, recommendation, overall_risk, severity_counts_json, duration_ms FROM reviews WHERE repo_name = ? ORDER BY created_at DESC LIMIT ?`,
          args: [repoName, limit],
        })
      : await this.client.execute({
          sql: `SELECT id, repo_name, source_type, source_ref, created_at, stage, recommendation, overall_risk, severity_counts_json, duration_ms FROM reviews ORDER BY created_at DESC LIMIT ?`,
          args: [limit],
        });
    return res.rows.map((r) => {
      const counts = r.severity_counts_json ? (JSON.parse(String(r.severity_counts_json)) as Record<Severity, number>) : emptyCounts();
      return {
        id: String(r.id),
        repoName: String(r.repo_name),
        sourceType: String(r.source_type),
        sourceRef: String(r.source_ref),
        createdAt: String(r.created_at),
        stage: String(r.stage) as ReviewStage,
        recommendation: (r.recommendation ? String(r.recommendation) : undefined) as Recommendation | undefined,
        overallRisk: r.overall_risk ? String(r.overall_risk) : undefined,
        severityCounts: counts,
        totalFindings: SEVERITIES.reduce((n, s) => n + (counts[s] ?? 0), 0),
        durationMs: r.duration_ms != null ? Number(r.duration_ms) : undefined,
      };
    });
  }
  async deleteReview(id: string): Promise<void> {
    await this.init();
    await this.client.execute({ sql: `DELETE FROM reviews WHERE id = ?`, args: [id] });
  }

  private rowToRecord(row: Record<string, unknown>): ReviewRecord {
    const report = row.report_json ? (JSON.parse(String(row.report_json)) as ConsolidationResult) : undefined;
    return {
      id: String(row.id),
      repoPath: String(row.repo_path),
      repoName: String(row.repo_name),
      sourceType: String(row.source_type) as ReviewRecord['sourceType'],
      sourceRef: String(row.source_ref),
      title: row.title ? String(row.title) : undefined,
      createdAt: String(row.created_at),
      completedAt: row.completed_at ? String(row.completed_at) : undefined,
      stage: String(row.stage) as ReviewRecord['stage'],
      error: row.error ? String(row.error) : undefined,
      model: String(row.model),
      plan: row.plan_json ? (JSON.parse(String(row.plan_json)) as ReviewPlan) : undefined,
      changedFiles: row.changed_files_json ? (JSON.parse(String(row.changed_files_json)) as string[]) : [],
      diff: row.diff ? String(row.diff) : '',
      diffStats: row.diff_stats ? String(row.diff_stats) : undefined,
      agentActivities: row.agent_activities_json ? JSON.parse(String(row.agent_activities_json)) : [],
      validations: row.validations_json ? JSON.parse(String(row.validations_json)) : [],
      reports: row.reports_json ? JSON.parse(String(row.reports_json)) : [],
      report,
      durationMs: row.duration_ms != null ? Number(row.duration_ms) : undefined,
      usage: row.usage_json ? JSON.parse(String(row.usage_json)) : undefined,
    } as ReviewRecord;
  }
}

let storeSingleton: ReviewStore | undefined;

/** Shared store instance (lazily created). */
export function getReviewStore(): ReviewStore {
  if (!storeSingleton) storeSingleton = new ReviewStore();
  return storeSingleton;
}
