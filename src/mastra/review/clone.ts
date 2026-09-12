import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Shallow clone helper for PR review. Clones the default branch at a bounded
 * depth, then fetches the specific PR head commit so `git show` works for
 * context reads. Clones live under the OS temp dir and are cleaned up on exit.
 */
export async function run(url: string, headSha?: string, destDir?: string): Promise<string> {
  const base = destDir ?? path.join(os.tmpdir(), 'code-review-clones');
  fs.mkdirSync(base, { recursive: true });
  const name = url
    .replace(/\.git$/, '')
    .split('/')
    .pop()!
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .slice(0, 60);
  const dest = path.join(base, `${name}-${Date.now().toString(36)}`);

  await exec('git', ['clone', '--depth', '30', url, dest], {
    timeout: 90000,
    maxBuffer: 32 * 1024 * 1024,
  });

  if (headSha) {
    await exec('git', ['-C', dest, 'fetch', '--depth', '10', 'origin', headSha], {
      timeout: 60000,
    }).catch(() => null);
  }
  return dest;
}
