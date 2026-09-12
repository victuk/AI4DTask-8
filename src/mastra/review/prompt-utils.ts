import fs from 'node:fs';
import path from 'node:path';

const FENCE = '```';
const MAX_INLINE = 4;

/**
 * Utility belt for keeping LLM prompts within budget while preserving the
 * information specialists need. Every consumer calls these helpers so size
 * policy lives in exactly one place.
 */

export function lineCount(s: string): number {
  if (!s) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

export function codeFence(snippet: string | undefined, lang = ''): string {
  if (!snippet) return '';
  const escaped = snippet.includes(FENCE) ? snippet.replaceAll(FENCE, '~~~') : snippet;
  return `${FENCE}${lang}\n${escaped}\n${FENCE}`;
}

/**
 * Truncate a string to maxChars, keeping the head and a tail so middle
 * elisions are visible.
 */
export function truncateMiddle(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head - 40;
  return `${s.slice(0, head)}\n... [${s.length - head - tail} chars truncated] ...\n${s.slice(-tail)}`;
}

export function truncateLines(s: string, maxLines: number): string {
  const lines = s.split('\n');
  if (lines.length <= maxLines) return s;
  return `${lines.slice(0, maxLines).join('\n')}\n... [${lines.length - maxLines} more lines]`;
}

/**
 * Split a plain-text diff into chunks that fit a prompt budget, splitting on
 * file boundaries. Returns at least one chunk (possibly truncated).
 */
export function chunkDiff(diff: string, maxChars = 14000): string[] {
  if (diff.length <= maxChars) return [diff];
  const fileBlocks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const line of diff.split('\n')) {
    const isFileStart = line.startsWith('diff --git ');
    if (isFileStart && currentLen > 0 && currentLen + line.length > maxChars) {
      fileBlocks.push(current.join('\n'));
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += line.length + 1;
  }
  if (current.length) fileBlocks.push(current.join('\n'));

  // Merge small adjacent blocks up to budget.
  const chunks: string[] = [];
  let acc = '';
  for (const block of fileBlocks) {
    const bounded = block.length > maxChars ? truncateMiddle(block, maxChars) : block;
    if (acc.length + bounded.length + 1 > maxChars) {
      if (acc) chunks.push(acc);
      acc = bounded;
    } else {
      acc = acc ? `${acc}\n${bounded}` : bounded;
    }
  }
  if (acc) chunks.push(acc);
  return chunks;
}

/** Render a list of findings for an LLM prompt (dedup/validation steps). */
export function findingsToText(findings: { id: string; title: string; severity: string; location: { file: string; line?: number }; explanation: string }[], maxChars = 16000): string {
  const parts = findings.map(
    (f) =>
      `[${f.id}] (${f.severity}) ${f.title} @ ${f.location.file}${f.location.line ? `:${f.location.line}` : ''}\n${f.explanation}`,
  );
  let out = parts.join('\n\n');
  while (out.length > maxChars && parts.length > 1) {
    parts.pop();
    out = `${parts.join('\n\n')}\n\n[... ${findings.length - parts.length} findings omitted]`;
  }
  return out;
}

/** Max chars of context a single agent invocation may inline. */
export const MAX_CONTEXT_CHARS = 60000;

/**
 * Pack requested file excerpts into a prompt block, respecting a global budget.
 * Each entry: { path, content }. Long files are head+tail truncated.
 */
export function packFiles(
  files: { path: string; content: string | undefined }[],
  budget = MAX_CONTEXT_CHARS,
): string {
  const perFile = Math.max(2000, Math.floor(budget / Math.max(1, files.length)));
  const blocks = files.map(({ path: p, content }) => {
    if (content === undefined) return `--- ${p} (not found in repository) ---`;
    const body = content.length > perFile ? truncateMiddle(content, perFile) : content;
    const lineCountS = lineCount(content);
    return `--- ${p} (${lineCountS} lines${content.length > perFile ? ', excerpt' : ''}) ---\n${body}`;
  });
  return blocks.join('\n\n');
}

/** Guess a highlight.js-ish language tag from a file extension (cosmetic only). */
export function langForFile(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', cs: 'csharp',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', php: 'php', sh: 'bash', bash: 'bash',
    sql: 'sql', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml', md: 'markdown',
    html: 'html', css: 'css', scss: 'scss', vue: 'vue', swift: 'swift', scala: 'scala',
  };
  return map[ext] ?? '';
}

/** Read package.json deps (best effort) for dependency-aware prompts. */
export function readManifestDeps(repoPath: string): { name: string; deps?: Record<string, string> } | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
    return { name: pkg.name, deps: { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } };
  } catch {
    return undefined;
  }
}
