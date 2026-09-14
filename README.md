# CodeMind — Agentic AI Code Review System

CodeMind reviews source-code changes with a **team of AI specialists**. A **Code Review Supervisor** inspects the change, decides which specialist reviewers are relevant, delegates to them, cross-validates high-severity findings with a second specialist, and consolidates everything into a single, prioritized review with an actionable recommendation (`APPROVE` / `APPROVE_WITH_COMMENTS` / `REQUEST_CHANGES` / `BLOCK_MERGE`).

Built with [Mastra](https://mastra.ai) using the Supervisor/Sub-Agent architecture. All agents use OpenRouter via the `OPENROUTER_API_KEY` environment variable and the model configured by `MODEL_NAME`.

## How it works

```
                      ┌──────────────────────────────┐
  git diff / commit ─▶│  Code Review Supervisor      │
  PR (GitHub/GitLab)  │  plans: which specialists?   │
  local repository    └──────────────┬───────────────┘
                                     │ delegates with per-agent focus notes
        ┌──────────┬──────────┬──────┴─────┬──────────┬──────────┐
        ▼          ▼          ▼            ▼          ▼          ▼
   Correctness  Security  Architecture  Performance  Quality   Testing
       &          &           &            &           &         &
       Logic                Design     Scalability  Maintain.  (each can
                                                                read the repo)
        └──────────┴──────────┴──────┬─────┴──────────┴──────────┘
                                     ▼
                    Cross-validation of critical/high findings
                          (a second specialist re-checks)
                                     ▼
                    Supervisor consolidation & final report
                    (dedup, merge, severity, recommendation)
```

- **Supervisor planning** — the supervisor reads the change (title, description, stats, repo structure) and returns a plan: relevant specialists + a concrete focus note for each. Irrelevant specialists are skipped per change.
- **Specialist review** — each specialist is a real Mastra agent with repository inspection tools (`get_review_diff`, `read_repo_file`, `list_repo_files`, `get_repo_tree`, `search_repo_text`), so it can read callers, types, config, and conventions **outside the diff** before reporting.
- **Cross-validation** — every `critical`/`high` finding is re-checked by a *different* relevant specialist, which confirms / downgrades / refutes it with a rationale. Refuted findings are dropped.
- **Consolidation** — the supervisor merges duplicate/overlapping findings, orders by severity and confidence, and emits the final report. Findings below the confidence floor and subjective style nits are filtered out.
- **History** — every review (with plan, agent activity, diffs, findings) is persisted to LibSQL and browseable in the UI; two reviews can be compared (new / persistent / resolved findings).

### Findings

Every finding carries: **title**, **category**, **severity** (critical/high/medium/low), **confidence** (high/medium/low), **file + line** (new-file line numbers), **explanation**, **impact**, and a **recommended fix**.

## Project layout

```
src/mastra/
  index.ts               Mastra instance: agents, storage, custom API routes, static UI
  types.ts               Domain types (findings, plans, reports, review records)
  service.ts             Review lifecycle: start → run → persist → (post to PR)
  agents/
    supervisor.ts        Code Review Supervisor (all specialists registered as sub-agents)
    specialists.ts       The six required specialists (+ shared prompt core)
  review/
    engine.ts            Agentic pipeline: plan → specialists → validation → consolidation
    review-context.ts    Source resolution (diff/commit/PR/repo) + safe file reads
    git-utils.ts         Git plumbing (diffs, commits, branches, clone, tree)
    github.ts / gitlab.ts  PR metadata, diffs, comment posting
    diff-parser.ts       Unified diff parser (hunks, line numbers, stats)
    prompt-utils.ts      Prompt packing/truncation helpers
    store.ts             Review history store (LibSQL)
  tools/review-tools.ts  Read-only repository inspection tools for agents
ui/                      Embedded single-page review UI (vanilla JS, served by the API)
cli/review.mjs           Terminal client
evaluation/              Seeded scenario repos + expected findings + scoring runner
```

## Install

Requires **Node 22.13+** and **git**. Uses pnpm by default (npm works too):

```bash
pnpm install        # or: npm install
```

## Configure environment variables

```bash
cp .env.example .env
# then edit .env:
#   OPENROUTER_API_KEY=sk-or-v1-…      (required)
#   MODEL_NAME=openrouter/anthropic/claude-sonnet-4.5   (required)
#   GITHUB_TOKEN=…   / GITLAB_TOKEN=…  (optional, for PR integration)
```

`MODEL_NAME` uses Mastra's `provider/model` format; through the OpenRouter provider it is the OpenRouter slug, e.g. `openrouter/openai/gpt-4o-mini`, `openrouter/anthropic/claude-sonnet-4.5`, `openrouter/google/gemini-2.5-pro`. All API keys are read from environment variables only.

## Run the backend (API + Agent UI)

```bash
npm run dev
```

This starts the Mastra server on **http://localhost:4111**:

- **Review web app** → http://localhost:4111/  (start reviews, watch agent activity, explore findings, browse history)
- **Mastra Studio** → http://localhost:4111/agents (talk to the supervisor directly; it can delegate to every specialist as a sub-agent)
- **Swagger/OpenAPI** → http://localhost:4111/swagger-ui and `/openapi.json`

For production: `npm run build` then `npm run start`.

## Run the Agent UI

The review UI is embedded and served by the same server — just open [http://localhost:4111](http://localhost:4111). No separate frontend build or port. (If you prefer to serve `ui/` yourself, point `UI_DIR` at it.)

## Connect or load a repository

Four ways, all supported in the UI's **New review** tab (and the CLI/API):

1. **Local repository** — type an absolute path (e.g. `/home/you/projects/my-repo`) and press **Load**. The UI shows branch/HEAD and lists commits.
2. **Clone from URL** — API: `POST /repos/clone {"url": "https://github.com/owner/repo.git"}` clones into `REPO_CACHE_DIR` (default `.repos/`), then review it like a local repo.
3. **GitHub / GitLab pull request** — paste the PR/MR URL (e.g. `https://github.com/owner/repo/pull/123`). The system fetches the PR diff and shallow-clones the head for context. With `GITHUB_TOKEN`/`GITLAB_TOKEN` it can also **post inline comments** on the PR (see below). Public repos work without tokens.
4. **Paste a diff** — paste any `git diff` output; optionally point at a local repo for context.

## Execute a code review

### Web UI
1. Open http://localhost:4111 → **New review**.
2. Pick a source (Commit / Working tree / Pull request / Paste diff) and load a repo or PR.
3. Optionally tick *Post findings to the pull request* (inline comments) or *Skip cross-validation*.
4. Click **Start agentic review** — watch the stage stepper (Planning → Specialists → Cross-validation → Consolidation) and live per-agent status.
5. Explore the report: filter findings by severity/category/file, click a finding to jump to its diff location, download the report as Markdown.

### CLI

```bash
# review the last commit of a local repo
npm run review -- --repo /path/to/repo --commit HEAD

# review uncommitted working-tree changes
npm run review -- --repo /path/to/repo

# review a GitHub PR and post inline comments to it
npm run review -- --pr https://github.com/owner/repo/pull/42 --post-to-pr

# review a diff file with repo context
git -C /path/to/repo diff main > /tmp/change.patch
npm run review -- --diff-file /tmp/change.patch --context-repo /path/to/repo

# other commands
npm run review -- history
npm run review -- show rev_abc123
npm run review -- compare rev_abc123 rev_def456
```

The CLI prints a live stage/agent feed to stderr and the Markdown report to stdout, so `npm run review -- … > report.md` works for piping.

### HTTP API

```bash
# start a review
curl -X POST localhost:4111/reviews -H 'content-type: application/json' \
  -d '{"sourceType":"commit","repoPath":"/abs/repo","ref":"HEAD"}'
# → {"reviewId":"rev_..."}

curl localhost:4111/reviews/rev_...            # poll status + report
curl localhost:4111/reviews?limit=20           # history
curl localhost:4111/reviews/rev_.../markdown   # report as Markdown
curl -X POST localhost:4111/reviews/rev_.../post-to-pr   # post inline comments
curl "localhost:4111/reviews/rev_B/compare?against=rev_A" # diff two reviews
```

### Posting review comments to a PR

Two ways:
- Set `postComments: true` when starting a PR review (UI checkbox or CLI `--post-to-pr`), or
- After any completed PR review: **💬 Post to PR** button in the UI, or `POST /reviews/:id/post-to-pr`.

Findings with a file+line become **inline comments** anchored to that line (GitHub review comments / GitLab discussions); a summary comment carries the verdict (`APPROVE` → approve event, `REQUEST_CHANGES`/`BLOCK_MERGE` → request-changes event).

## Review history & comparison

Every review is stored in `reviews.db` (LibSQL; override with `REVIEW_DB_URL`). The **History** tab lists all reviews with severity counts and verdicts; pick any two completed reviews and click **Compare** to see new / persistent / resolved findings between successive reviews of the same repo.

## Custom review rules

Pass repository-specific standards with `options.customRules` (UI/API), e.g.:

```json
{"sourceType":"commit","repoPath":"/abs/repo","ref":"HEAD",
 "options":{"customRules":"- All public endpoints must use our requireAuth middleware.\n- Never import from src/internal in src/public."}}
```

The supervisor embeds these rules in the plan and every specialist is told to respect them.

## Evaluation scenarios

Six seeded repositories with **known, planted issues** live in `evaluation/`. Each has a clean baseline commit and a "PR" commit introducing specific defects; `evaluation/expected.json` lists the expected findings (area, file, minimum severity, evidence keywords) and one noise-control scenario that should stay clean.

```bash
npm run eval:setup          # (re)create evaluation/repos/*
npm run dev                 # in another terminal, with .env configured
npm run eval:run            # review each PR commit and score detection
# → evaluation/results.json with per-scenario and overall detection rate
```

| Scenario | Repo | Expected detections (areas) |
|---|---|---|
| 1 | `payments-service` | SQL injection, hardcoded API key, double-charged balance, missing amount validation, swallowed refund errors, missing tests |
| 2 | `inventory-api` | Unauthenticated destructive endpoint, `eval()` on webhook payload, race condition in stock reservation, N+1 queries, no transaction |
| 3 | `metrics-dashboard` | Sequential awaits in loop (N+1 API calls), O(n²) report accumulation, sort-after-slice bug, unbounded cache, missing tests |
| 4 | `billing-data` | Non-transactional multi-write invoice creation, destructive migration column drop, missing NOT NULL constraint, per-line INSERT loop |
| 5 | `search-service` | Off-by-one pagination for page 1, commented-out dead code, leftover `console.log` debug, duplicated `normalize` helper, untested pagination |
| 6 | `feature-flag-service` | **Noise control** — clean, tested change; expect APPROVE / APPROVE_WITH_COMMENTS with no invented issues |

`npm run eval:run` prints a per-scenario score (detected/expected) and an overall detection rate, written to `evaluation/results.json`.

## Notes & design decisions

- **Relevance-driven delegation** — the supervisor plans which specialists run; a docs-only change won't spin up the Security agent. The plan (with reasoning) is visible in the UI and stored with the review.
- **Repository context** — specialists decide themselves when to inspect beyond the diff; the tools are read-only and path-guarded (no traversal outside the repo).
- **Anti-hallucination guardrails** — structured output schemas for every agent; finding locations are scope-checked against the actual diff; low-confidence+low-severity findings are dropped; cross-validation kills false positives on high severities; prompt-injection instructions inside reviewed code are explicitly ignored by the agent prompts.
- **No style nits** — agents are instructed to skip subjective formatting unless it materially affects maintainability or violates repo conventions.
- **Recommendation logic** — `BLOCK_MERGE` for confirmed criticals; `REQUEST_CHANGES` for confirmed highs or systemic mediums; `APPROVE_WITH_COMMENTS` for moderate; `APPROVE` otherwise.
- Everything runs locally: LibSQL storage, shallow clones under the OS temp dir (cleaned on exit), no data leaves your machine except the code sent to the configured LLM provider.
