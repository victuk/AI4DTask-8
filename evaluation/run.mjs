// #!/usr/bin/env node
// /**
//  * Evaluation runner: reviews every scenario repo's PR commit through the
//  * CodeMind API and scores which expected issues were detected.
//  *
//  * Prereqs:
//  *   1. node evaluation/setup.mjs      (seeds evaluation/repos/*)
//  *   2. npm run dev                    (CodeMind server on :4111)
//  *   3. OPENROUTER_API_KEY + MODEL_NAME set in .env
//  *
//  * Usage: node evaluation/run.mjs [--only <repoName>] [--timeout <sec>]
//  */
// import fs from 'node:fs';
// import path from 'node:path';
// import { execFileSync } from 'node:child_process';
// import { fileURLToPath } from 'node:url';

// const here = path.dirname(fileURLToPath(import.meta.url));
// const SERVER = process.env.CODEMIND_URL ?? 'http://localhost:4111';
// const argv = process.argv.slice(2);
// const onlyIdx = argv.indexOf('--only');
// const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
// const timeoutIdx = argv.indexOf('--timeout');
// const TIMEOUT_SEC = timeoutIdx >= 0 ? Number(argv[timeoutIdx + 1]) : 900;

// const manifest = JSON.parse(fs.readFileSync(path.join(here, 'expected.json'), 'utf8'));
// const reposDir = path.join(here, 'repos');

// const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
// const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// async function api(pathname, opts = {}) {
//   const res = await fetch(`${SERVER}${pathname}`, {
//     headers: { 'Content-Type': 'application/json' },
//     ...opts,
//     body: opts.body ? JSON.stringify(opts.body) : undefined,
//   });
//   const text = await res.text();
//   let data;
//   try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; }
//   if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}: ${data.error ?? text.slice(0, 200)}`);
//   return data;
// }

// /** Score one scenario: match findings against expected issues by file + area + keywords. */
// function scoreScenario(expected, record) {
//   const findings = record.report?.findings ?? [];
//   const results = expected.map((exp) => {
//     const matches = findings.filter((f) => {
//       const fileOk = (f.location?.file ?? '').endsWith(exp.file.split('/').pop()) || (f.location?.file ?? '').includes(exp.file.replace(/^src\//, '').replace(/\.js$|\.ts$/, ''));
//       if (!fileOk) return false;
//       const areaOk = f.category === exp.area;
//       const sevOk = SEV_RANK[f.severity] >= SEV_RANK[exp.severityAtLeast];
//       const text = `${f.title} ${f.explanation} ${f.impact} ${f.recommendation}`.toLowerCase();
//       const kwOk = exp.keywords.some((k) => text.includes(k.toLowerCase()));
//       return areaOk && sevOk && kwOk;
//     });
//     const weakMatches = findings.filter((f) => {
//       const fileOk = (f.location?.file ?? '').endsWith(exp.file.split('/').pop());
//       if (!fileOk) return false;
//       const text = `${f.title} ${f.explanation}`.toLowerCase();
//       return exp.keywords.some((k) => text.includes(k.toLowerCase()));
//     });
//     return { ...exp, detected: matches.length > 0, weak: matches.length === 0 && weakMatches.length > 0, matchedBy: matches.map((m) => m.id) };
//   });
//   const falsePositives = findings.filter((f) => {
//     return !results.some((r) => r.matchedBy.includes(f.id));
//   });
//   const detected = results.filter((r) => r.detected).length;
//   return {
//     results,
//     falsePositives,
//     score: expected.length === 0 ? null : detected / expected.length,
//     recommendation: record.report?.recommendation,
//     totalFindings: findings.length,
//   };
// }

// async function reviewScenario(scenario) {
//   const repoPath = path.join(reposDir, scenario.repo);
//   const head = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD']).toString().trim();
//   const { reviewId } = await api('/reviews', {
//     method: 'POST',
//     body: { sourceType: 'commit', repoPath, ref: head },
//   });
//   process.stdout.write(`  review ${reviewId} started, waiting…\n`);
//   const deadline = Date.now() + TIMEOUT_SEC * 1000;
//   for (;;) {
//     await sleep(5000);
//     const record = await api(`/reviews/${reviewId}`);
//     if (record.stage === 'failed') throw new Error(`review failed: ${record.error}`);
//     if (record.stage === 'completed') return record;
//     if (Date.now() > deadline) throw new Error('timeout waiting for review');
//     process.stdout.write(`  … ${record.stage}\n`);
//   }
// }

// async function main() {
//   const scenarios = manifest.scenarios.filter((s) => !only || s.repo === only);
//   const outcomes = [];
//   for (const scenario of scenarios) {
//     process.stdout.write(`\n=== ${scenario.repo} — ${scenario.name}\n`);
//     try {
//       const record = await reviewScenario(scenario);
//       const scored = scoreScenario(scenario.expected, record);
//       outcomes.push({ repo: scenario.repo, reviewId: record.id, ...scored });
//       for (const r of scored.results) {
//         const mark = r.detected ? '✓' : r.weak ? '~' : '✗';
//         process.stdout.write(`  ${mark} ${r.id} (${r.area}, ${r.severityAtLeast}+) ${r.detected ? 'DETECTED' : r.weak ? 'weak signal' : 'MISSED'} ${r.detected ? `→ ${r.matchedBy.join(',')}` : ''}\n`);
//       }
//       if (scored.score !== null) {
//         process.stdout.write(`  score: ${scored.detected}/${scenario.expected.length} · recommendation: ${scored.recommendation} · findings: ${scored.totalFindings} · extra findings: ${scored.falsePositives.length}\n`);
//       } else {
//         process.stdout.write(`  noise-control scenario · recommendation: ${scored.recommendation} · findings: ${scored.totalFindings}\n`);
//       }
//     } catch (err) {
//       outcomes.push({ repo: scenario.repo, error: err.message });
//       process.stdout.write(`  ERROR: ${err.message}\n`);
//     }
//   }

//   const scored = outcomes.filter((o) => !o.error && o.score !== null);
//   const total = scored.reduce((n, o) => n + o.results.length, 0);
//   const detected = scored.reduce((n, o) => n + o.results.filter((r) => r.detected).length, 0);
//   const clean = outcomes.find((o) => o.repo === 'feature-flag-service' && !o.error);

//   const report = {
//     generatedAt: new Date().toISOString(),
//     totalExpected: total,
//     totalDetected: detected,
//     detectionRate: total ? (detected / total) : 0,
//     perScenario: outcomes,
//     cleanScenario: clean
//       ? { recommendation: clean.recommendation, totalFindings: clean.totalFindings, acceptable: clean.totalFindings <= 4 && ['APPROVE', 'APPROVE_WITH_COMMENTS'].includes(clean.recommendation) }
//       : null,
//   };
//   fs.writeFileSync(path.join(here, 'results.json'), JSON.stringify(report, null, 2));
//   process.stdout.write(`\n================ SUMMARY ================\n`);
//   process.stdout.write(`Expected issues detected: ${detected}/${total} (${(report.detectionRate * 100).toFixed(0)}%)\n`);
//   if (report.cleanScenario) {
//     process.stdout.write(`Clean-change noise control: ${report.cleanScenario.acceptable ? 'PASS' : 'FAIL'} (${clean.recommendation}, ${clean.totalFindings} findings)\n`);
//   }
//   process.stdout.write(`Full results written to evaluation/results.json\n`);
// }

// await main();
