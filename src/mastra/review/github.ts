/**
 * GitHub integration: pull request metadata + diffs, and posting review
 * comments (inline when line info is available, otherwise a summary comment).
 * Uses GITHUB_TOKEN when present; anonymous access works for public repos.
 */

const API = 'https://api.github.com';

export interface GitHubRef {
  owner: string;
  repo: string;
  number: number;
}

export function parseGitHubPrUrl(url: string): GitHubRef | undefined {
  const m = /github\.com[/:]([^/]+)\/([^/]+)\/(?:pull|pulls)\/(\d+)/.exec(url);
  if (!m) return undefined;
  return { owner: m[1], repo: m[2].replace(/\.git$/, ''), number: Number(m[3]) };
}

export function parseGitHubRepoUrl(url: string): { owner: string; repo: string } | undefined {
  const m = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#]|$)/.exec(url);
  if (!m) return undefined;
  return { owner: m[1], repo: m[2] };
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'code-review-agent',
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function gh(pathname: string, init?: RequestInit & { raw?: boolean }) {
  const res = await fetch(`${API}${pathname}`, { ...init, headers: { ...headers(), ...(init?.headers as Record<string, string>) } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} for ${pathname}: ${body.slice(0, 300)}`);
  }
  if (init?.raw) return res.text();
  return res.json();
}

export interface GitHubPrMeta {
  ref: GitHubRef;
  title: string;
  body: string | undefined;
  author: string;
  state: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  htmlUrl: string;
}

export async function fetchPrMeta(ref: GitHubRef): Promise<GitHubPrMeta> {
  const pr = (await gh(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`)) as {
    title: string;
    body?: string;
    state: string;
    user?: { login: string };
    head: { sha: string; ref: string };
    base: { ref: string };
    html_url: string;
  };
  return {
    ref,
    title: pr.title,
    body: pr.body ?? undefined,
    author: pr.user?.login ?? 'unknown',
    state: pr.state,
    headSha: pr.head.sha,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    htmlUrl: pr.html_url,
  };
}

export async function fetchPrDiff(ref: GitHubRef): Promise<string> {
  return (await gh(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, {
    headers: { Accept: 'application/vnd.github.v3.diff' },
    raw: true,
  })) as unknown as string;
}

export interface GitHubPrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export async function fetchPrFiles(ref: GitHubRef): Promise<GitHubPrFile[]> {
  return (await gh(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=100`)) as GitHubPrFile[];
}

export async function listOpenPrs(owner: string, repo: string, limit = 20): Promise<
  { number: number; title: string; author: string; headRef: string; updatedAt: string; draft: boolean }[]
> {
  const prs = (await gh(`/repos/${owner}/${repo}/pulls?state=open&per_page=${limit}&sort=updated`)) as {
    number: number;
    title: string;
    draft: boolean;
    user?: { login: string };
    head: { ref: string };
    updated_at: string;
  }[];
  return prs.map((p) => ({
    number: p.number,
    title: p.title,
    author: p.user?.login ?? 'unknown',
    headRef: p.head.ref,
    updatedAt: p.updated_at,
    draft: p.draft,
  }));
}

/** One inline comment on a PR line (new file side). */
export interface InlineComment {
  path: string;
  /** Line number in the NEW version of the file. */
  line?: number;
  body: string;
}

const VERDICT_EVENT: Record<string, 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'> = {
  APPROVE: 'APPROVE',
  APPROVE_WITH_COMMENTS: 'COMMENT',
  REQUEST_CHANGES: 'REQUEST_CHANGES',
  BLOCK_MERGE: 'REQUEST_CHANGES',
};

/**
 * Post a review to a pull request: inline comments for findings that have a
 * file+line, plus a summary body. Falls back to an issue comment when no
 * line-anchored comments exist.
 */
export async function postPrReview(
  ref: GitHubRef,
  body: string,
  comments: InlineComment[],
  verdict?: string,
  headSha?: string,
): Promise<{ posted: 'review' | 'comment'; commentCount: number; url?: string }> {
  const event = verdict ? (VERDICT_EVENT[verdict] ?? 'COMMENT') : 'COMMENT';
  const anchored = comments.filter((c) => typeof c.line === 'number');
  if (anchored.length > 0) {
    const created = (await gh(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`, {
      method: 'POST',
      body: JSON.stringify({
        event,
        body,
        commit_id: headSha,
        comments: anchored.map((c) => ({ path: c.path, side: 'RIGHT', line: c.line, body: c.body })),
      }),
    })) as { id?: number; html_url?: string };
    return { posted: 'review', commentCount: anchored.length, url: created.html_url };
  }
  const created = (await gh(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  })) as { html_url?: string };
  return { posted: 'comment', commentCount: 1, url: created.html_url };
}
