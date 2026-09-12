import path from 'node:path';
import fs from 'node:fs';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { DuckDBStore } from '@mastra/duckdb';
import { MastraCompositeStore } from '@mastra/core/storage';
import {
  MastraStorageExporter,
  MastraPlatformExporter,
  Observability,
  SensitiveDataFilter,
} from '@mastra/observability';
import { registerApiRoute } from '@mastra/core/server';
import { supervisorAgent } from './agents/supervisor';
import { specialistList } from './agents/specialists';
import { getReviewStore } from './review/store';
import { startReview, reviewToMarkdown, compareReviews } from './service';
import { isGitRepo, getRepoInfo, listCommits, listBranches, getDiffForSource, cloneRepository } from './review/git-utils';
import { parseGitHubRepoUrl, listOpenPrs } from './review/github';
import { parseGitLabProjectUrl, listOpenMrs } from './review/gitlab';
import { z } from 'zod';
import { OllamaGateway } from './review/ollama-gateway';

const specialistAgents = Object.fromEntries(specialistList.map((s) => [`${s.id}-agent`, s.agent]));

const startReviewBody = z.object({
  sourceType: z.enum(['diff', 'commit', 'pr', 'repository']),
  repoPath: z.string().optional(),
  ref: z.string().optional(),
  diffText: z.string().optional(),
  options: z
    .object({
      minConfidence: z.enum(['high', 'medium', 'low']).optional(),
      maxFindings: z.number().int().positive().max(100).optional(),
      skipValidation: z.boolean().optional(),
      postComments: z.boolean().optional(),
      postSummaryOnly: z.boolean().optional(),
      customRules: z.string().max(20000).optional(),
    })
    .optional(),
});

function json(c: { json: (data: unknown, status?: number) => Response }, data: unknown, status = 200) {
  return c.json(data, status);
}

const apiRoutes = [
  registerApiRoute('/system-info', {
    method: 'GET',
    handler: async (c) =>
      json(c, {
        ok: true,
        model: process.env.MODEL_NAME ?? 'openrouter/openai/gpt-4o-mini',
        openrouterKeyConfigured: Boolean(process.env.OPENROUTER_API_KEY),
        githubTokenConfigured: Boolean(process.env.GITHUB_TOKEN),
        gitlabTokenConfigured: Boolean(process.env.GITLAB_TOKEN),
      }),
  }),

  // ---- Reviews ----
  registerApiRoute('/reviews', {
    method: 'POST',
    handler: async (c) => {
      const body = await c.req.json<unknown>();
      const parsed = startReviewBody.safeParse(body);
      if (!parsed.success) return json(c, { error: 'Invalid request', details: parsed.error.issues }, 400);
      if (parsed.data.sourceType === 'diff' && !parsed.data.diffText?.trim()) {
        return json(c, { error: 'diffText is required for sourceType "diff"' }, 400);
      }
      if ((parsed.data.sourceType === 'commit' || parsed.data.sourceType === 'repository') && !parsed.data.repoPath) {
        return json(c, { error: 'repoPath is required for commit/repository reviews' }, 400);
      }
      if (parsed.data.sourceType === 'pr' && !parsed.data.ref) {
        return json(c, { error: 'ref (GitHub pull / GitLab merge_requests URL) is required for PR reviews' }, 400);
      }
      const reviewId = await startReview(parsed.data);
      return json(c, { reviewId }, 201);
    },
  }),

  registerApiRoute('/reviews', {
    method: 'GET',
    handler: async (c) => {
      const limit = Number(c.req.query('limit') ?? 50);
      const repo = c.req.query('repo') ?? undefined;
      const reviews = await getReviewStore().listReviews(Number.isFinite(limit) ? limit : 50, repo || undefined);
      return json(c, { reviews });
    },
  }),

  registerApiRoute('/reviews/:id', {
    method: 'GET',
    handler: async (c) => {
      const record = await getReviewStore().getReview(c.req.param('id'));
      if (!record) return json(c, { error: 'Review not found' }, 404);
      return json(c, record);
    },
  }),

  registerApiRoute('/reviews/:id', {
    method: 'DELETE',
    handler: async (c) => {
      await getReviewStore().deleteReview(c.req.param('id'));
      return json(c, { ok: true });
    },
  }),

  registerApiRoute('/reviews/:id/markdown', {
    method: 'GET',
    handler: async (c) => {
      const record = await getReviewStore().getReview(c.req.param('id'));
      if (!record) return json(c, { error: 'Review not found' }, 404);
      return new Response(reviewToMarkdown(record), {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="review-${record.id}.md"`,
        },
      });
    },
  }),

  registerApiRoute('/reviews/:id/post-to-pr', {
    method: 'POST',
    handler: async (c) => {
      const store = getReviewStore();
      const record = await store.getReview(c.req.param('id'));
      if (!record) return json(c, { error: 'Review not found' }, 404);
      if (record.sourceType !== 'pr') return json(c, { error: 'Only pull-request reviews can be posted' }, 400);
      if (!record.report) return json(c, { error: 'Review has not completed yet' }, 409);
      const body = await c.req.json<{ summaryOnly?: boolean }>().catch(() => ({ summaryOnly: false }));
      const prMatch = /github\.com[/:]([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(record.sourceRef);
      const glMatch = /https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/.exec(record.sourceRef);
      if (prMatch) {
        const { postPrReview } = await import('./review/github');
        const { buildPrComments } = await import('./service');
        const { comments } = buildPrComments(record);
        const res = await postPrReview(
          { owner: prMatch[1], repo: prMatch[2].replace(/\.git$/, ''), number: Number(prMatch[3]) },
          reviewToMarkdown(record),
          body?.summaryOnly ? [] : comments,
          record.report.recommendation,
        );
        return json(c, res);
      }
      if (glMatch) {
        const { postMrComments } = await import('./review/gitlab');
        const { buildPrComments } = await import('./service');
        const { comments } = buildPrComments(record);
        const res = await postMrComments(
          { host: glMatch[1], projectId: decodeURIComponent(glMatch[2]), mrIid: Number(glMatch[3]) },
          reviewToMarkdown(record),
          body?.summaryOnly ? [] : comments,
        );
        return json(c, res);
      }
      return json(c, { error: 'Unrecognized PR URL' }, 400);
    },
  }),

  registerApiRoute('/reviews/:id/compare', {
    method: 'GET',
    handler: async (c) => {
      const store = getReviewStore();
      const target = await store.getReview(c.req.param('id'));
      const againstId = c.req.query('against');
      if (!target) return json(c, { error: 'Review not found' }, 404);
      if (!againstId) return json(c, { error: 'against=<reviewId> query param required' }, 400);
      const against = await store.getReview(againstId);
      if (!against) return json(c, { error: 'Comparison review not found' }, 404);
      return json(c, compareReviews(against, target));
    },
  }),

  // ---- Repository browsing ----
  registerApiRoute('/repos/info', {
    method: 'POST',
    handler: async (c) => {
      const { repoPath } = await c.req.json<{ repoPath: string }>();
      const resolved = repoPath ? path.resolve(repoPath) : '';
      if (!resolved || !isGitRepo(resolved)) {
        return json(c, { error: `Not a git repository: ${resolved}` }, 400);
      }
      const info = await getRepoInfo(resolved);
      return json(c, { repoPath: resolved, info });
    },
  }),

  registerApiRoute('/repos/commits', {
    method: 'POST',
    handler: async (c) => {
      const { repoPath, limit } = await c.req.json<{ repoPath: string; limit?: number }>();
      const resolved = repoPath ? path.resolve(repoPath) : '';
      if (!isGitRepo(resolved)) return json(c, { error: 'Not a git repository' }, 400);
      const commits = await listCommits(resolved, Math.min(limit ?? 25, 100));
      return json(c, { commits });
    },
  }),

  registerApiRoute('/repos/branches', {
    method: 'POST',
    handler: async (c) => {
      const { repoPath } = await c.req.json<{ repoPath: string }>();
      const resolved = repoPath ? path.resolve(repoPath) : '';
      if (!isGitRepo(resolved)) return json(c, { error: 'Not a git repository' }, 400);
      const branches = await listBranches(resolved, 25);
      return json(c, { branches });
    },
  }),

  registerApiRoute('/repos/preview', {
    method: 'POST',
    handler: async (c) => {
      const { repoPath, sourceType, ref } = await c.req.json<{
        repoPath: string;
        sourceType: 'commit' | 'branch' | 'worktree';
        ref?: string;
      }>();
      const resolved = repoPath ? path.resolve(repoPath) : '';
      if (!isGitRepo(resolved)) return json(c, { error: 'Not a git repository' }, 400);
      const result = await getDiffForSource(
        resolved,
        sourceType === 'commit'
          ? { type: 'commit', ref: ref ?? 'HEAD' }
          : sourceType === 'branch'
            ? { type: 'branch', ref: ref ?? 'HEAD' }
            : { type: 'worktree' },
      );
      return json(c, result);
    },
  }),

  registerApiRoute('/repos/clone', {
    method: 'POST',
    handler: async (c) => {
      const { url } = await c.req.json<{ url: string }>();
      if (!url || !/^(https|git|ssh):\/\//.test(url)) return json(c, { error: 'Provide a git URL' }, 400);
      const dest = path.resolve(process.env.REPO_CACHE_DIR ?? '.repos');
      try {
        const repoPath = await cloneRepository(url, dest);
        const info = await getRepoInfo(repoPath);
        return json(c, { repoPath, info });
      } catch (err) {
        return json(c, { error: err instanceof Error ? err.message : 'Clone failed' }, 502);
      }
    },
  }),

  // ---- Pull request listing (GitHub / GitLab) ----
  registerApiRoute('/prs', {
    method: 'POST',
    handler: async (c) => {
      const { url } = await c.req.json<{ url: string }>();
      const gh = parseGitHubRepoUrl(url ?? '');
      if (gh) {
        try {
          const prs = await listOpenPrs(gh.owner, gh.repo, 25);
          return json(c, { platform: 'github', prs });
        } catch (err) {
          return json(c, { error: err instanceof Error ? err.message : 'GitHub API error' }, 502);
        }
      }
      const gl = parseGitLabProjectUrl(url ?? '');
      if (gl) {
        try {
          const prs = await listOpenMrs(gl.host, gl.projectId, 25);
          return json(c, { platform: 'gitlab', prs });
        } catch (err) {
          return json(c, { error: err instanceof Error ? err.message : 'GitLab API error' }, 502);
        }
      }
      return json(c, { error: 'Provide a GitHub or GitLab repository URL' }, 400);
    },
  }),
];

// ---- Static UI serving (embedded single-page app) ----
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function uiDir(): string {
  if (process.env.UI_DIR) return path.resolve(process.env.UI_DIR);
  // The dev/build server runs from a nested working directory (e.g.
  // src/mastra/public), so walk upward until we find the project's ui/ dir.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'ui');
    try {
      if (fs.statSync(path.join(candidate, 'index.html')).isFile()) return candidate;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), 'ui');
}

function serveStatic(relPath: string): Response | undefined {
  const base = uiDir();
  const clean = relPath.replace(/^\/+/, '').split('?')[0];
  const candidates = clean === '' ? ['index.html'] : [clean, `${clean}.html`, 'index.html'];
  for (const candidate of candidates) {
    const abs = path.resolve(base, candidate);
    if (!abs.startsWith(base)) continue; // traversal guard
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      const ext = path.extname(abs).toLowerCase();
      return new Response(fs.readFileSync(abs), {
        headers: { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' },
      });
    } catch {
      continue;
    }
  }
  return undefined;
}

export const mastra = new Mastra({
  bundler: {
    externals: ['@duckdb/node-bindings'],
  },
  gateways: {
    ollama: new OllamaGateway(),
  },
  agents: { supervisorAgent, ...specialistAgents },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: 'mastra-storage',
      url: process.env.TURSO_DATABASE_URL || 'file:./mastra.db',
      authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    }),
    domains: {
      observability: await new DuckDBStore().getStore('observability'),
    },
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'code-review-agent',
        exporters: [new MastraStorageExporter(), new MastraPlatformExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
  server: {
    cors: { origin: '*' },
    apiRoutes: [
      ...apiRoutes,
      // Catch-all UI route must come last.
      registerApiRoute('/*', {
        method: 'GET',
        handler: async (c) => {
          const url = new URL(c.req.url);
          if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/swagger-ui') || url.pathname.startsWith('/health') || url.pathname.startsWith('/reviews') || url.pathname.startsWith('/repos') || url.pathname.startsWith('/prs')) {
            return c.json({ error: 'Not found' }, 404);
          }
          const res = serveStatic(url.pathname);
          return res ?? c.json({ error: 'Not found' }, 404);
        },
      }),
    ],
  },
});

// Initialize the review-history schema eagerly so the UI sees tables immediately.
getReviewStore().init().catch(() => undefined);
