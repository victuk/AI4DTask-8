/**
 * Parser for unified diffs (git format). Produces a structured representation
 * used for review prompts, finding location checks, and the diff viewer.
 */

export type DiffLineType = 'context' | 'add' | 'remove';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  /** 1-based line number in the old file (absent for pure additions). */
  oldLine?: number;
  /** 1-based line number in the new file (absent for pure deletions). */
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export type ChangeType = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ParsedFileDiff {
  /** New path in the repository. */
  path: string;
  /** Original path when a file was renamed/moved. */
  oldPath?: string;
  changeType: ChangeType;
  isBinary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** Full unified diff text for this file. */
  raw: string;
}

export interface ParsedDiff {
  files: ParsedFileDiff[];
}

const FILE_HEADER = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/;
const OLD_MODE = /^old mode /;
const NEW_MODE = /^new mode /;
const RENAME_FROM = /^rename from (.+)$/;
const RENAME_TO = /^rename to (.+)$/;
const OLD_PATH = /^--- (?:"?(?:a\/)?(.+?)"?)(?:\t.*)?$/;
const NEW_PATH = /^\+\+\+ (?:"?(?:b\/)?(.+?)"?)(?:\t.*)?$/;
const BINARY = /^GIT binary patch$|^Binary files .* differ$/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function stripQuotes(p: string): string {
  return p.replace(/^"|"$/g, '');
}

/** Parse a unified diff into structured per-file records. Never throws. */
export function parseUnifiedDiff(diffText: string): ParsedDiff {
  const files: ParsedFileDiff[] = [];
  const lines = diffText.split('\n');
  let i = 0;

  const currentFile: Partial<ParsedFileDiff> & { headerLines?: string[] } = {};

  const finishFile = () => {
    if (currentFile.path) {
      files.push({
        path: currentFile.path,
        oldPath: currentFile.oldPath,
        changeType: currentFile.changeType ?? 'modified',
        isBinary: currentFile.isBinary ?? false,
        additions: currentFile.additions ?? 0,
        deletions: currentFile.deletions ?? 0,
        hunks: currentFile.hunks ?? [],
        raw: (currentFile.headerLines ?? []).join('\n'),
      });
    }
    for (const key of Object.keys(currentFile)) {
      delete (currentFile as Record<string, unknown>)[key];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const match = FILE_HEADER.exec(line);
    if (!match) {
      i += 1;
      continue;
    }

    finishFile();
    const aPath = stripQuotes(match[1]);
    const bPath = stripQuotes(match[2]);
    currentFile.path = bPath;
    currentFile.oldPath = aPath;
    currentFile.hunks = [];
    currentFile.additions = 0;
    currentFile.deletions = 0;
    currentFile.headerLines = [line];
    i += 1;

    // Consume header lines until first hunk or next file header.
    let changeType: ChangeType | undefined;
    while (i < lines.length) {
      const headerLine = lines[i];
      if (FILE_HEADER.test(headerLine)) break;
      currentFile.headerLines!.push(headerLine);
      if (OLD_MODE.test(headerLine) || NEW_MODE.test(headerLine)) {
        i += 1;
        continue;
      }
      if (RENAME_FROM.test(headerLine) || RENAME_TO.test(headerLine)) {
        changeType = 'renamed';
        i += 1;
        continue;
      }
      if (NEW_FILE.test(headerLine)) {
        changeType = 'added';
        i += 1;
        continue;
      }
      if (DELETED_FILE.test(headerLine)) {
        changeType = 'deleted';
        i += 1;
        continue;
      }
      if (BINARY.test(headerLine)) {
        currentFile.isBinary = true;
        i += 1;
        continue;
      }
      const oldMatch = OLD_PATH.exec(headerLine);
      if (oldMatch) {
        const p = stripQuotes(oldMatch[1]);
        if (p === '/dev/null') changeType = 'added';
        else currentFile.oldPath = p;
        i += 1;
        continue;
      }
      const newMatch = NEW_PATH.exec(headerLine);
      if (newMatch) {
        const p = stripQuotes(newMatch[1]);
        if (p === '/dev/null') changeType = 'deleted';
        else currentFile.path = p;
        i += 1;
        continue;
      }
      const hunkMatch = HUNK.exec(headerLine);
      if (hunkMatch) break;
      i += 1;
    }

    currentFile.changeType = changeType ?? 'modified';

    // Parse hunks.
    while (i < lines.length && !FILE_HEADER.test(lines[i])) {
      const hunkMatch = HUNK.exec(lines[i]);
      if (!hunkMatch) {
        i += 1;
        continue;
      }
      const hunk: DiffHunk = {
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1,
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1,
        header: lines[i],
        lines: [],
      };
      i += 1;
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      let seenOld = 0;
      let seenNew = 0;
      while (i < lines.length && (seenOld < hunk.oldLines || seenNew < hunk.newLines || lines[i].startsWith('\\'))) {
        const content = lines[i];
        if (content.startsWith('\\')) {
          // "\ No newline at end of file"
          i += 1;
          continue;
        }
        if (content.startsWith('+')) {
          hunk.lines.push({ type: 'add', content: content.slice(1), newLine });
          currentFile.additions = (currentFile.additions ?? 0) + 1;
          newLine += 1;
          seenNew += 1;
        } else if (content.startsWith('-')) {
          hunk.lines.push({ type: 'remove', content: content.slice(1), oldLine });
          currentFile.deletions = (currentFile.deletions ?? 0) + 1;
          oldLine += 1;
          seenOld += 1;
        } else if (content.startsWith(' ') || content === '') {
          hunk.lines.push({ type: 'context', content: content.slice(1), oldLine, newLine });
          oldLine += 1;
          newLine += 1;
          seenOld += 1;
          seenNew += 1;
        } else {
          break; // Not part of this hunk.
        }
        i += 1;
      }
      currentFile.hunks!.push(hunk);
    }
  }
  finishFile();

  return { files };
}

const NEW_FILE = /^new file mode /;
const DELETED_FILE = /^deleted file mode /;

/** Render a compact numbered view of a file diff for LLM prompts. */
export function formatFileDiffForPrompt(file: ParsedFileDiff, maxLines = 400): string {
  if (file.isBinary) {
    return `Binary file ${file.changeType === 'added' ? 'added' : 'changed'}: ${file.path}`;
  }
  const out: string[] = [];
  const label =
    file.changeType === 'added'
      ? 'new file'
      : file.changeType === 'deleted'
        ? 'deleted'
        : file.changeType === 'renamed'
          ? `renamed from ${file.oldPath ?? file.path}`
          : 'modified';
  out.push(`File: ${file.path} (${label}, +${file.additions}/-${file.deletions})`);
  out.push('Lines are numbered as: <new-file line> | <content>. "+" marks added lines, "-" removed lines.');
  let emitted = 0;
  for (const hunk of file.hunks) {
    out.push(`@@ ${hunk.header}`);
    for (const dl of hunk.lines) {
      if (emitted >= maxLines) {
        out.push(`... (${file.hunks.reduce((n, h) => n + h.lines.length, 0) - emitted} more diff lines truncated)`);
        return out.join('\n');
      }
      const lineNo = dl.newLine ?? dl.oldLine ?? 0;
      const marker = dl.type === 'add' ? '+' : dl.type === 'remove' ? '-' : ' ';
      out.push(`${String(lineNo).padStart(4)} ${marker} | ${dl.content}`);
      emitted += 1;
    }
  }
  if (file.hunks.length === 0) out.push('(no line changes)');
  return out.join('\n');
}

/** All new-file line numbers touched by additions in a file. */
export function addedLineNumbers(file: ParsedFileDiff): Set<number> {
  const set = new Set<number>();
  for (const hunk of file.hunks) {
    for (const dl of hunk.lines) {
      if (dl.type === 'add' && dl.newLine !== undefined) set.add(dl.newLine);
    }
  }
  return set;
}

/** Reconstruct the post-change content of a file from its diff, when the repo snapshot is unavailable. */
export function reconstructNewContent(file: ParsedFileDiff): string | undefined {
  if (file.changeType === 'deleted' || file.isBinary) return undefined;
  const out: string[] = [];
  let lastNew = 0;
  for (const hunk of file.hunks) {
    let expected = hunk.newStart;
    if (expected > lastNew + 1) out.push('');
    for (const dl of hunk.lines) {
      if (dl.type === 'remove') continue;
      if (dl.newLine !== undefined && dl.newLine !== expected) {
        // Fill gap with blank lines (context we cannot know).
        while (expected < dl.newLine) {
          out.push('');
          expected += 1;
        }
      }
      out.push(dl.content);
      if (dl.newLine !== undefined) expected = dl.newLine + 1;
      if (dl.newLine !== undefined) lastNew = dl.newLine;
    }
  }
  return out.join('\n');
}
