import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readContextFile, normalizeRelPath, type ReviewContext } from '../review/review-context.js';
import { listRepoFiles, getRepoTree } from '../review/git-utils.js';
import { addedLineNumbers, formatFileDiffForPrompt } from '../review/diff-parser.js';
/**
 * Read-only repository inspection tools for review agents. Every tool resolves
 * the current ReviewContext from the request context, so the same tool set is
 * safe to share across concurrent reviews.
 */

export const REVIEW_CONTEXT_KEY = 'reviewContext';

export function getReviewContext(context: { requestContext?: { get(key: string): unknown } } | undefined): ReviewContext {
  const ctx = (context?.requestContext?.get(REVIEW_CONTEXT_KEY) ??
    context?.requestContext?.get('agentReviewNote')) as ReviewContext | undefined;
  if (!ctx) throw new Error('No review context available for this tool call');
  return ctx;
}

const MAX_OUTPUT_CHARS = 12000;
const MAX_LIST = 300;

function cap(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... [output truncated at ${max} chars]`;
}

/** Numbered rendering of a file so agents can cite line numbers accurately. */
function withLineNumbers(content: string, start = 1): string {
  const lines = content.split('\n');
  return lines
    .slice(start - 1, start - 1 + 2000)
    .map((l, i) => `${String(start + i).padStart(4)} | ${l}`)
    .join('\n');
}

export const getReviewDiffTool = createTool({
  id: 'get_review_diff',
  description:
    'Get the code changes under review. Pass file to get the numbered diff of one changed file; omit file to get the change overview with per-file stats. Line numbers are new-file lines.',
  inputSchema: z.object({
    file: z.string().optional().describe('Repository-relative path of a changed file (as listed in the overview)'),
  }),
  outputSchema: z.object({ content: z.string() }),
  execute: async ({ file }, context) => {
    const ctx = getReviewContext(context);
    if (file) {
      const parsed = ctx.parsed.files.find((f) => f.path === file || f.oldPath === file);
      if (!parsed) {
        return { content: `File ${file} is not part of this change. Changed files: ${ctx.changedFiles.join(', ')}` };
      }
      return { content: cap(formatFileDiffForPrompt(parsed, 600)) };
    }
    const lines = [
      `Change: ${ctx.title}`,
      ctx.diffStats ? `Stats:\n${ctx.diffStats.trim()}` : '',
      `Files changed (${ctx.changedFiles.length}):`,
      ...ctx.parsed.files.map(
        (f) =>
          `- ${f.path} [${f.changeType}, +${f.additions}/-${f.deletions}]${f.isBinary ? ' (binary)' : ''}`,
      ),
      '',
      'Call get_review_diff with file=<path> for the full numbered diff of a file.',
    ];
    return { content: cap(lines.filter(Boolean).join('\n')) };
  },
});

export const readRepoFileTool = createTool({
  id: 'read_repo_file',
  description:
    'Read a file from the repository under review (the post-change version). Use for context beyond the diff: callers, types, config, related modules. Returns numbered lines.',
  inputSchema: z.object({
    path: z.string().describe('Repository-relative file path'),
    startLine: z.number().int().positive().optional().describe('1-based start line (default 1)'),
    endLine: z.number().int().positive().optional().describe('1-based end line (default startLine+400)'),
  }),
  outputSchema: z.object({ content: z.string() }),
  execute: async ({ path: filePath, startLine, endLine }, context) => {
    const ctx = getReviewContext(context);
    const safe = normalizeRelPath(filePath);
    if (!safe) return { content: `Invalid path: ${filePath}` };
    const content = await readContextFile(ctx, safe);
    if (content === undefined) return { content: `File not found: ${safe}` };
    const from = startLine ?? 1;
    const to = endLine ?? from + 400;
    const slice = content
      .split('\n')
      .slice(from - 1, to)
      .map((l, i) => `${String(from + i).padStart(4)} | ${l}`)
      .join('\n');
    const total = content.split('\n').length;
    const prefix = total > to - from + 1 ? `(showing lines ${from}-${Math.min(to, total)} of ${total})\n` : '';
    return { content: cap(`${prefix}${slice}`) };
  },
});

export const listRepoFilesTool = createTool({
  id: 'list_repo_files',
  description:
    'List files in the repository under review. Optionally filter by substring/prefix (e.g. "services/" or ".ts"). Useful to discover project structure and related modules.',
  inputSchema: z.object({
    filter: z.string().optional().describe('Only include paths containing this substring'),
    limit: z.number().int().positive().max(MAX_LIST).optional().describe('Max files to return (default 150)'),
  }),
  outputSchema: z.object({ content: z.string() }),
  execute: async ({ filter, limit }, context) => {
    const ctx = getReviewContext(context);
    if (!ctx.repoPath) return { content: 'No repository available for this review (inline diff only).' };
    const all = await listRepoFiles(ctx.repoPath, 5000);
    const filtered = filter ? all.filter((f) => f.includes(filter)) : all;
    const capped = filtered.slice(0, limit ?? 150);
    const suffix = filtered.length > capped.length ? `\n... (${filtered.length - capped.length} more)` : '';
    return { content: cap(capped.join('\n') + suffix) };
  },
});

export const getRepoTreeTool = createTool({
  id: 'get_repo_tree',
  description: 'Get a compact top-level directory overview of the repository under review.',
  inputSchema: z.object({}),
  outputSchema: z.object({ content: z.string() }),
  execute: async (_input, context) => {
    const ctx = getReviewContext(context);
    if (!ctx.repoPath) return { content: 'No repository available for this review (inline diff only).' };
    return { content: cap(await getRepoTree(ctx.repoPath)) };
  },
});

export const searchRepoTextTool = createTool({
  id: 'search_repo_text',
  description:
    'Search the repository under review for a text pattern (fixed string by default, or regex). Returns matching file:line excerpts. Use to find callers, duplicated logic, config, or usages.',
  inputSchema: z.object({
    pattern: z.string().min(2).describe('Text or regex to search for'),
    isRegex: z.boolean().default(false).describe('Treat pattern as a regular expression'),
    fileFilter: z.string().optional().describe('Only search files whose path contains this substring'),
    maxResults: z.number().int().positive().max(50).optional().describe('Max matches (default 20)'),
  }),
  outputSchema: z.object({ content: z.string() }),
  execute: async ({ pattern, isRegex, fileFilter, maxResults }, context) => {
    const ctx = getReviewContext(context);
    if (!ctx.repoPath) return { content: 'No repository available for this review (inline diff only).' };
    let regex: RegExp;
    try {
      regex = isRegex ? new RegExp(pattern, 'g') : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    } catch (e) {
      return { content: `Invalid regex: ${(e as Error).message}` };
    }
    const files = (await listRepoFiles(ctx.repoPath, 8000)).filter((f) => {
      if (fileFilter && !f.includes(fileFilter)) return false;
      return /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|c|h|cpp|hpp|php|swift|scala|sql|sh|yml|yaml|json|toml|vue|svelte|env|txt|md)$/i.test(f);
    });
    const results: string[] = [];
    const max = maxResults ?? 20;
    outer: for (const file of files.slice(0, 1500)) {
      const content = await readContextFile(ctx, file);
      if (!content) continue;
      const lines = content.split('\n');
      regex.lastIndex = 0;
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          results.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (results.length >= max) break outer;
        }
      }
    }
    if (results.length === 0) return { content: `No matches for "${pattern}"` };
    return { content: cap(results.join('\n')) };
  },
});

/** Context tools bundled for review agents. */
export const reviewContextTools = {
  getReviewDiff: getReviewDiffTool,
  readRepoFile: readRepoFileTool,
  listRepoFiles: listRepoFilesTool,
  getRepoTree: getRepoTreeTool,
  searchRepoText: searchRepoTextTool,
};

/** Check whether a reported finding points at a line that actually changed. */
export function isLineInChangedRange(ctx: ReviewContext, filePath: string, line?: number): boolean {
  if (!line) return true;
  const file = ctx.parsed.files.find((f) => f.path === filePath || f.oldPath === filePath);
  if (!file) return false;
  return addedLineNumbers(file).has(line);
}
