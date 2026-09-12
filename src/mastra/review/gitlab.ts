/**
 * GitLab integration: merge request metadata + diffs, and posting review
 * comments (inline when line info is available, otherwise a summary note).
 * Requires GITLAB_TOKEN for private projects; public projects work without.
 */

export interface GitLabRef {
  projectId: string | number;
  mrIid: number;
  host: string;
}

function apiBase(host: string): string {
  return `https://${host}/api/v4`;
}

export function parseGitLabMrUrl(url: string): GitLabRef | undefined {
  const m = /https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/.exec(url);
  if (!m) return undefined;
  return { host: m[1], projectId: decodeURIComponent(m[2]), mrIid: Number(m[3]) };
}

export function parseGitLabProjectUrl(url: string): { host: string; projectId: string } | undefined {
  const m = /https?:\/\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#]|$)/.exec(url);
  if (!m) return undefined;
  return { host: m[1], projectId: decodeURIComponent(m[2]) };
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': 'code-review-agent' };
  if (process.env.GITLAB_TOKEN) h['PRIVATE-TOKEN'] = process.env.GITLAB_TOKEN;
  return h;
}

async function gl(host: string, pathname: string, init?: RequestInit & { raw?: boolean }) {
  const res = await fetch(`${apiBase(host)}${pathname}`, { ...init, headers: { ...headers(), ...(init?.headers as Record<string, string>) } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitLab API ${res.status} for ${pathname}: ${body.slice(0, 300)}`);
  }
  if (init?.raw) return res.text();
  return res.json();
}

export interface GitLabMrMeta {
  ref: GitLabRef;
  title: string;
  body: string | undefined;
  author: string;
  state: string;
  headSha: string;
  sourceBranch: string;
  targetBranch: string;
  webUrl: string;
}

export async function fetchMrMeta(ref: GitLabRef): Promise<GitLabMrMeta> {
  const mr = (await gl(ref.host, `/projects/${encodeURIComponent(String(ref.projectId))}/merge_requests/${ref.mrIid}`)) as {
    title: string;
    description?: string;
    state: string;
    author: { username: string };
    sha: string;
    source_branch: string;
    target_branch: string;
    web_url: string;
  };
  return {
    ref,
    title: mr.title,
    body: mr.description ?? undefined,
    author: mr.author.username,
    state: mr.state,
    headSha: mr.sha,
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    webUrl: mr.web_url,
  };
}

export async function fetchMrDiff(ref: GitLabRef): Promise<string> {
  return (await gl(ref.host, `/projects/${encodeURIComponent(String(ref.projectId))}/merge_requests/${ref.mrIid}/diff`, {
    headers: { Accept: 'text/plain' },
    raw: true,
  })) as unknown as string;
}

export async function listOpenMrs(host: string, projectId: string | number, limit = 20): Promise<
  { iid: number; title: string; author: string; sourceBranch: string; updatedAt: string; draft: boolean }[]
> {
  const mrs = (await gl(
    host,
    `/projects/${encodeURIComponent(String(projectId))}/merge_requests?state=opened&per_page=${limit}&order_by=updated_at`,
  )) as {
    iid: number;
    title: string;
    draft: boolean;
    author: { username: string };
    source_branch: string;
    updated_at: string;
  }[];
  return mrs.map((m) => ({
    iid: m.iid,
    title: m.title,
    author: m.author.username,
    sourceBranch: m.source_branch,
    updatedAt: m.updated_at,
    draft: m.draft,
  }));
}

export interface InlineComment {
  path: string;
  line?: number;
  body: string;
}

/**
 * Post review comments on an MR. GitLab inline comments go through the
 * discussions API with position info; a plain note is used as fallback.
 */
export async function postMrComments(
  ref: GitLabRef,
  body: string,
  comments: InlineComment[],
  headSha?: string,
): Promise<{ posted: 'discussions' | 'note'; commentCount: number; url?: string }> {
  const project = encodeURIComponent(String(ref.projectId));
  const anchored = comments.filter((c) => typeof c.line === 'number' && headSha);
  let posted = 0;
  if (anchored.length > 0) {
    for (const c of anchored) {
      await gl(ref.host, `/projects/${project}/merge_requests/${ref.mrIid}/discussions`, {
        method: 'POST',
        body: JSON.stringify({
          body: c.body,
          position: {
            base_sha: headSha,
            start_sha: headSha,
            head_sha: headSha,
            position_type: 'text',
            new_path: c.path,
            new_line: c.line,
          },
        }),
      }).catch(() => null);
      posted += 1;
    }
  }
  const note = (await gl(ref.host, `/projects/${project}/merge_requests/${ref.mrIid}/notes`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  })) as { web_url?: string };
  return { posted: anchored.length > 0 ? 'discussions' : 'note', commentCount: posted + 1, url: note.web_url };
}
