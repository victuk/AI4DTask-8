#!/usr/bin/env node
/**
 * CodeMind CLI — run agentic code reviews from the terminal.
 *
 * Requires the CodeMind server (npm run dev) to be running.
 *
 * Examples:
 *   node cli/review.mjs review --repo /path/to/repo --source commit --ref HEAD
 *   node cli/review.mjs review --repo /path/to/repo                      # working tree changes
 *   node cli/review.mjs review --pr https://github.com/owner/repo/pull/42
 *   node cli/review.mjs review --diff-file changes.patch
 *   node cli/review.mjs review --repo ./myrepo --post-to-pr              # post inline comments
 *   node cli/review.mjs history
 *   node cli/review.mjs show rev_xxx
 *   node cli/review.mjs compare rev_a rev_b
 */
import fs from 'node:fs';

const SERVER = process.env.CODEMIND_URL ?? process.env.MASTRA_URL ?? 'http://localhost:4111';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

const C = { dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', reset: '\x1b[0m' };
const dim = (s) => `${C.dim}${s}${C.reset}`;
const bold = (s) => `${C.bold}${s}${C.reset}`;

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(`${SERVER}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    console.error(`Cannot reach CodeMind server at ${SERVER}. Start it with: npm run dev`);
    process.exit(2);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 400) }; }
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${data.error ?? 'request failed'}`);
    process.exit(1);
  }
  return data;
}

function detectSource(args) {
  if (args.pr) return 'pr';
  if (args['diff-file'] || args.diff) return 'diff';
  if (args.commit) return 'commit';
  if (args.repo) return 'repository';
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cmdReview(args) {
  const sourceType = args.source ?? detectSource(args);
  const body = { sourceType, options: {} };
  if (args.repo) body.repoPath = args.repo;
  if (args.commit) { body.sourceType = 'commit'; body.ref = args.commit; }
  if (args.branch) { body.sourceType = 'commit'; body.ref = args.branch; }
  if (args.pr) { body.sourceType = 'pr'; body.ref = args.pr; }
  if (args['diff-file']) {
    body.sourceType = 'diff';
    body.diffText = fs.readFileSync(args['diff-file'], 'utf8');
  }
  if (args['context-repo']) body.repoPath = args['context-repo'];
  if (args['post-to-pr']) body.options.postComments = true;
  if (args['summary-only']) body.options.postSummaryOnly = true;
  if (args['skip-validation']) body.options.skipValidation = true;
  if (args.rules) body.options.customRules = fs.readFileSync(args.rules, 'utf8');
  if (!body.sourceType) {
    console.error('Nothing to review. Use --repo <path>, --commit <ref> --repo <path>, --pr <url>, or --diff-file <file>.');
    process.exit(1);
  }

  process.stderr.write(dim(`Starting review on ${SERVER}…\n`));
  const { reviewId } = await api('/reviews', { method: 'POST', body });
  process.stderr.write(dim(`Review id: ${reviewId}\n`));

  if (args['no-wait']) {
    console.log(reviewId);
    return;
  }

  let lastStage = '';
  let lastAgents = new Set();
  const started = Date.now();
  for (;;) {
    await sleep(2000);
    let record;
    try {
      record = await api(`/reviews/${reviewId}`);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    if (record.stage !== lastStage) {
      lastStage = record.stage;
      process.stderr.write(`${C.blue}▸${C.reset} ${record.stage}\n`);
    }
    for (const act of record.agentActivities ?? []) {
      if (!lastAgents.has(`${act.agent}:${act.status}`)) {
        lastAgents.add(`${act.agent}:${act.status}`);
        if (act.status === 'done') process.stderr.write(dim(`  ✓ ${act.agent} — ${act.findingCount ?? 0} findings\n`));
        else if (act.status === 'error') process.stderr.write(`${C.red}  ✗ ${act.agent} — ${act.error}${C.reset}\n`);
        else if (act.status === 'running') process.stderr.write(dim(`  ● ${act.agent} reviewing…\n`));
      }
    }
    if (record.stage === 'failed') {
      console.error(`${C.red}Review failed: ${record.error}${C.reset}`);
      process.exit(1);
    }
    if (record.stage === 'completed') {
      printReport(record, args, Date.now() - started);
      return;
    }
  }
}

function printReport(record, args, elapsedMs) {
  const r = record.report;
  const verdictColor = { APPROVE: C.green, APPROVE_WITH_COMMENTS: C.yellow, REQUEST_CHANGES: '\x1b[35m', BLOCK_MERGE: C.red };
  const header = [
    '',
    bold(`Code review — ${record.repoName} (${record.sourceType}: ${record.sourceRef})`),
    r ? `${verdictColor[r.recommendation]}${bold(r.recommendation.replace(/_/g, ' '))}${C.reset} · risk: ${r.overallRisk} · ${r.findings.length} findings · ${(elapsedMs / 1000).toFixed(0)}s` : '',
    '',
    r ? r.summary : '',
    '',
  ].join('\n');
  process.stderr.write(header);

  if (r) {
    const order = ['critical', 'high', 'medium', 'low'];
    for (const sev of order) {
      const list = r.findings.filter((f) => f.severity === sev);
      if (!list.length) continue;
      process.stderr.write(`${bold(sev.toUpperCase())}\n`);
      for (const f of list) {
        process.stderr.write(
          [
            `  ${C.bold}[${f.id}] ${f.title}${C.reset}`,
            dim(`  ${f.location.file}${f.location.line ? ':' + f.location.line : ''} · ${f.category} · confidence ${f.confidence} · via ${f.reportedBy.join(', ')}`),
            `  ${f.explanation}`,
            `  ${C.blue}Impact:${C.reset} ${f.impact}`,
            `  ${C.blue}Fix:${C.reset} ${f.recommendation}`,
            f.validation ? dim(`  Cross-validation: ${f.validation.verdict} by ${f.validation.validatorAgent}`) : '',
            '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }
    }
    if (!r.findings.length) process.stderr.write('No significant issues found. 🎉\n');
  }

  if (args.json) console.log(JSON.stringify(record, null, 2));
  else if (!args['no-wait'] && args.format !== 'text') {
    // markdown to stdout for piping
  }
  if (args.markdown !== false && !args.json) {
    process.stdout.write(renderMarkdown(record));
  }
  if (args['post-to-pr'] && record.sourceType === 'pr') {
    api(`/reviews/${record.id}/post-to-pr`, { method: 'POST', body: { summaryOnly: Boolean(args['summary-only']) } })
      .then((res) => process.stderr.write(dim(`\nPosted to PR (${res.commentCount} comments) ${res.url ?? ''}\n`)))
      .catch((e) => process.stderr.write(`${C.red}Failed to post to PR: ${e.message}${C.reset}\n`));
  }
}

function renderMarkdown(record) {
  const r = record.report;
  const out = [];
  out.push(`# Code review — ${record.repoName} (${record.sourceType}: ${record.sourceRef})`);
  out.push(`Recommendation: **${r?.recommendation ?? record.stage}** · risk: ${r?.overallRisk ?? '?'}`);
  out.push('');
  if (r?.summary) out.push(r.summary, '');
  for (const f of r?.findings ?? []) {
    out.push(`## [${f.severity.toUpperCase()}] ${f.title}`);
    out.push(`\`${f.location.file}${f.location.line ? ':' + f.location.line : ''}\` · ${f.category} · confidence ${f.confidence}`);
    out.push('');
    out.push(f.explanation);
    out.push('');
    out.push(`**Impact:** ${f.impact}`, '');
    out.push(`**Recommendation:** ${f.recommendation}`, '');
  }
  if (!r?.findings?.length) out.push('No significant issues found.');
  return out.join('\n');
}

async function cmdHistory() {
  const { reviews } = await api('/reviews?limit=50');
  if (!reviews.length) return console.log(dim('No reviews yet.'));
  for (const r of reviews) {
    const counts = r.severityCounts ?? {};
    console.log(
      `${bold(r.id)}  ${r.repoName} · ${r.sourceType}:${r.sourceRef.slice(0, 40)}`,
      '\n ',
      dim(`${new Date(r.createdAt).toLocaleString()} · ${r.stage}${r.recommendation ? ' · ' + r.recommendation : ''}`),
      `\n `,
      `critical:${counts.critical ?? 0} high:${counts.high ?? 0} medium:${counts.medium ?? 0} low:${counts.low ?? 0}`,
    );
  }
}

async function cmdShow(args) {
  const record = await api(`/reviews/${args._[1]}`);
  printReport(record, args, record.durationMs ?? 0);
}

async function cmdCompare(args) {
  const [, a, b] = args._;
  if (!a || !b) return console.error('Usage: compare <reviewIdA> <reviewIdB>');
  const diff = await api(`/reviews/${b}/compare?against=${a}`);
  console.log(bold('New findings'));
  for (const f of diff.newFindings) console.log(`  ${C.red}+${C.reset} [${f.severity}] ${f.title} (${f.file}${f.line ? ':' + f.line : ''})`);
  console.log(bold('\nPersistent findings'));
  for (const f of diff.persistentFindings) console.log(`  ${C.yellow}~${C.reset} [${f.severity}] ${f.title} (${f.file}${f.line ? ':' + f.line : ''})`);
  console.log(bold('\nResolved findings'));
  for (const f of diff.resolvedFindings) console.log(`  ${C.green}-${C.reset} [${f.severity}] ${f.title} (${f.file}${f.line ? ':' + f.line : ''})`);
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'review';
if (command === 'review') await cmdReview(args);
else if (command === 'history') await cmdHistory();
else if (command === 'show') await cmdShow(args);
else if (command === 'compare') await cmdCompare(args);
else {
  console.error(`Unknown command "${command}". Commands: review, history, show, compare`);
  process.exit(1);
}
