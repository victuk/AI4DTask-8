// #!/usr/bin/env node
// /**
//  * Seeds the evaluation scenario repositories. Each repo gets a clean base
//  * commit followed by a "pull request" commit that plants specific, known
//  * issues. Expected findings live in evaluation/expected/*.json.
//  */
// import fs from 'node:fs';
// import path from 'node:path';
// import { execFileSync } from 'node:child_process';
// import { fileURLToPath } from 'node:url';

// const here = path.dirname(fileURLToPath(import.meta.url));
// const reposDir = path.join(here, 'repos');
// const baselineDir = path.join(here, 'baseline');
// fs.rmSync(reposDir, { recursive: true, force: true });
// fs.mkdirSync(reposDir, { recursive: true });

// function git(cwd, ...args) {
//   execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
// }
// function write(repo, file, content) {
//   const abs = path.join(repo, file);
//   fs.mkdirSync(path.dirname(abs), { recursive: true });
//   fs.writeFileSync(abs, content);
// }
// function commit(repo, message) {
//   git(repo, 'add', '-A');
//   git(repo, '-c', 'user.email=eval@example.com', '-c', 'user.name=Eval', 'commit', '-m', message);
//   return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();
// }
// function createRepo(name) {
//   const dir = path.join(reposDir, name);
//   fs.mkdirSync(dir, { recursive: true });
//   git(dir, 'init', '-b', 'main');
//   git(dir, 'config', 'commit.gpgsign', 'false');
//   return dir;
// }

// // Copy shared baseline (clean starting point) into a repo.
// function seedBaseline(repo, name) {
//   const base = path.join(baselineDir, name);
//   fs.cpSync(base, repo, { recursive: true });
// }

// // ---------------------------------------------------------------------------
// // Scenario 1 — payments: correctness + security planted issues
// // ---------------------------------------------------------------------------
// function scenarioPayments() {
//   const repo = createRepo('payments-service');
//   seedBaseline(repo, 'payments');
//   commit(repo, 'Initial payments service');

//   // The PR: charge endpoint with planted issues.
//   write(repo, 'src/charges.js', `const db = require('./db');
// const gateway = require('./gateway');
// const { audit } = require('./audit');

// // POST /api/charges  { userId, amountCents, cardToken, currency }
// async function createCharge(req, res) {
//   const userId = req.body.userId;
//   const amountCents = req.body.amountCents;
//   const currency = req.body.currency || 'usd';

//   // Load the user's wallet directly with string interpolation.
//   const wallet = await db.query(
//     "SELECT * FROM wallets WHERE user_id = '" + userId + "'"
//   );

//   const apiKey = '${process.env.STRIPE_API_KEY}';

//   let balance = wallet.rows[0].balance_cents;
//   if (amountCents > 0) {
//     balance = balance - amountCents;
//   }

//   for (let attempt = 1; attempt <= 3; attempt++) {
//     const result = await gateway.charge({
//       amount: amountCents,
//       currency,
//       source: req.body.cardToken,
//       key: apiKey,
//     });
//     if (result.status === 'succeeded') {
//       const remaining = balance - amountCents;
//       await db.query(
//         "UPDATE wallets SET balance_cents = " + remaining + " WHERE user_id = '" + userId + "'"
//       );
//       audit.log('charge', { userId, amountCents, remaining });
//       return res.json({ ok: true, remainingCents: remaining });
//     }
//   }

//   res.status(502).json({ ok: false, error: 'gateway declined' });
// }

// module.exports = { createCharge };
// `);

//   write(repo, 'src/refunds.js', `const db = require('./db');

// async function refundAllExpired() {
//   const expired = await db.query("SELECT * FROM charges WHERE expires_at < NOW()");
//   const results = [];
//   for (const charge of expired.rows) {
//     try {
//       await db.query("DELETE FROM charges WHERE id = " + charge.id);
//     } catch (e) {
//       console.log('failed to refund charge ' + charge.id);
//     }
//     results.push(charge.id);
//   }
//   return results;
// }

// module.exports = { refundAllExpired };
// `);

//   commit(repo, 'Add charge endpoint and refund cleanup for billing flows');
// }

// // ---------------------------------------------------------------------------
// // Scenario 2 — api-server: security + concurrency + API contract
// // ---------------------------------------------------------------------------
// function scenarioApiServer() {
//   const repo = createRepo('inventory-api');
//   seedBaseline(repo, 'inventory');
//   commit(repo, 'Inventory service baseline');

//   write(repo, 'src/routes/admin.js', `const express = require('express');
// const router = express.Router();
// const db = require('../db');
// const requireAdmin = require('../middleware/requireAdmin');

// // List all users with their roles.
// router.get('/users', async (req, res) => {
//   const users = await db.query('SELECT id, email, role FROM users ORDER BY id');
//   res.json({ users: users.rows, total: users.rows.length });
// });

// // Danger zone: wipe all cache entries (used after schema migrations).
// router.post('/flush-cache', async (req, res) => {
//   await db.query('TRUNCATE TABLE cache_entries');
//   res.status(200).json({ ok: true });
// });

// // Update a user's role.
// router.post('/users/:id/role', requireAdmin, async (req, res) => {
//   const { role } = req.body;
//   await db.query('UPDATE users SET role = $1 WHERE id = $2', [role, req.params.id]);
//   res.json({ ok: true });
// });

// module.exports = router;
// `);

//   write(repo, 'src/services/stock.js', `const db = require('../db');
// const cache = {};

// async function reserveStock(skuIds, orderId) {
//   // Reserve the requested SKUs atomically-ish.
//   let reserved = 0;
//   for (const sku of skuIds) {
//     const rows = await db.query('SELECT stock FROM inventory WHERE sku = $1', [sku]);
//     if (rows.rows[0].stock > 0) {
//       await db.query('UPDATE inventory SET stock = stock - 1 WHERE sku = $1', [sku]);
//       cache[orderId + ':' + sku] = Date.now();
//       reserved += 1;
//     }
//   }
//   return { orderId, reserved, total: skuIds.length };
// }

// module.exports = { reserveStock };
// `);

//   write(repo, 'src/parse-webhook.js', `// Parses third-party webhook payloads for stock updates.
// function handleWebhook(rawBody, signature) {
//   const payload = eval('(' + rawBody + ')');
//   if (payload.event === 'restock') {
//     return { sku: payload.sku, add: payload.quantity };
//   }
//   return null;
// }

// module.exports = { handleWebhook };
// `);

//   commit(repo, 'Add admin routes, stock reservation and webhook parsing');
// }

// // ---------------------------------------------------------------------------
// // Scenario 3 — dashboard: performance + correctness (frontend-ish TS)
// // ---------------------------------------------------------------------------
// function scenarioDashboard() {
//   const repo = createRepo('metrics-dashboard');
//   seedBaseline(repo, 'dashboard');
//   commit(repo, 'Dashboard baseline');

//   write(repo, 'src/reports.ts', `import { fetchEvents, fetchUser, fetchTeams } from './api';

// // Builds the monthly activity report for the admin dashboard.
// export async function buildMonthlyReport(userIds: number[], month: string) {
//   const report: any = { month, rows: [] };
//   for (const id of userIds) {
//     const user = await fetchUser(id);
//     const events = await fetchEvents(id, month);
//     const teams = await fetchTeams(id);
//     const row = { user, teams, eventCount: events.length };
//     const enriched = rowsWithFlags(report.rows, row);
//     report.rows = enriched;
//   }
//   return report;
// }

// function rowsWithFlags(rows: any[], row: any) {
//   const next = [...rows];
//   for (const existing of next) {
//     if (existing.user.id === row.user.id) {
//       existing.eventCount += row.eventCount;
//       return next;
//     }
//   }
//   next.push(row);
//   return next;
// }

// export function pickTopUsers(rows: any[], n: number) {
//   const top = rows.slice(0, n);
//   top.sort((a, b) => b.eventCount - a.eventCount);
//   return top;
// }
// `);

//   write(repo, 'src/cache.ts', `const cache = new Map<string, { value: unknown; ts: number }>();

// export async function cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
//   const hit = cache.get(key);
//   if (hit) return hit.value as T;
//   const value = await loader();
//   cache.set(key, { value, ts: Date.now() });
//   return value;
// }

// export function primeCache(keys: string[], loader: (k: string) => Promise<unknown>) {
//   const p = keys.map((k) => loader(k).then((v) => cache.set(k, { value: v, ts: Date.now() })));
//   return Promise.all(p);
// }
// `);

//   commit(repo, 'Add monthly report builder and shared cache helpers');
// }

// // ---------------------------------------------------------------------------
// // Scenario 4 — data layer: database + correctness
// // ---------------------------------------------------------------------------
// function scenarioDataLayer() {
//   const repo = createRepo('billing-data');
//   seedBaseline(repo, 'billing');
//   commit(repo, 'Billing data layer baseline');

//   write(repo, 'migrations/007_add_invoices.js', `
// const db = require('../src/db');

// module.exports.up = async function up() {
//   await db.exec("ALTER TABLE accounts ADD COLUMN invoice_prefix TEXT");
//   await db.exec("UPDATE accounts SET invoice_prefix = 'INV-' || id");
//   await db.exec("ALTER TABLE accounts DROP COLUMN legacy_number");
// };

// module.exports.down = async function down() {
//   await db.exec("ALTER TABLE accounts ADD COLUMN legacy_number TEXT");
// };
// `);

//   write(repo, 'src/invoices.js', `const db = require('./db');

// async function createInvoice(accountId, lines) {
//   const total = lines.reduce((sum, l) => sum + l.amountCents, 0);
//   const invoice = await db.query(
//     'INSERT INTO invoices (account_id, total_cents, status) VALUES ($1, $2, $3) RETURNING id',
//     [accountId, total, 'open'],
//   );
//   const invoiceId = invoice.rows[0].id;
//   for (const line of lines) {
//     await db.query(
//       'INSERT INTO invoice_lines (invoice_id, description, amount_cents) VALUES ($1, $2, $3)',
//       [invoiceId, line.description, line.amountCents],
//     );
//   }
//   await db.query("UPDATE accounts SET next_invoice_at = NOW() + INTERVAL '30 days' WHERE id = $1", [accountId]);
//   return invoiceId;
// }

// async function getOutstandingBalance(accountId) {
//   const res = await db.query('SELECT total_cents FROM invoices WHERE account_id = $1', [accountId]);
//   let sum = 0;
//   for (const row of res.rows) {
//     sum += row.total_cents;
//   }
//   return sum;
// }

// module.exports = { createInvoice, getOutstandingBalance };
// `);

//   commit(repo, 'Add invoice creation, outstanding balance and invoice prefix migration');
// }

// // ---------------------------------------------------------------------------
// // Scenario 5 — refactor: quality + subtle regression
// // ---------------------------------------------------------------------------
// function scenarioRefactor() {
//   const repo = createRepo('search-service');
//   seedBaseline(repo, 'search');
//   commit(repo, 'Search service baseline');

//   write(repo, 'src/pagination.js', `// Splits the result ids into pages for the search UI.
// // pageSize comes from the query string.

// export function paginate(ids, pageSize, pageNumber) {
//   const size = pageSize;
//   const start = pageNumber * size - size;
//   const page = ids.slice(start, start + size);
//   return {
//     page,
//     pageNumber,
//     hasNext: start + size < ids.length,
//     totalPages: Math.ceil(ids.length / size),
//   };
// }
// `);

//   write(repo, 'src/tokenize.js', `// Old tokenizer kept around in case we need to roll back the new one.
// // export function tokenizeOld(q) {
// //   return q.split(/[^a-zA-Z0-9]+/).filter(Boolean);
// // }

// import stopwordList from './stopwords';

// export function tokenize(q) {
//   const words = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
//   const debugTokens = words.map(w => w + ':' + w.length);
//   console.log('tokenize input:', q, debugTokens);
//   const filtered = words.filter((w) => !stopwordList.has(w));
//   return dedupe(filtered);
// }

// function dedupe(words) {
//   const seen = new Set();
//   const out = [];
//   for (const w of words) {
//     if (!seen.has(w)) {
//       out.push(w);
//       seen.add(w);
//     }
//   }
//   return out;
// }

// export function normalize(q) {
//   return q.trim().toLowerCase().replace(/\\s+/g, ' ');
// }

// export function normalizeCopy(q) {
//   return q.trim().toLowerCase().replace(/\\s+/g, ' ');
// }
// `);

//   write(repo, 'src/query-parser.js', `import { tokenize, normalize } from './tokenize';

// export function parseQuery(input) {
//   const q = normalize(input);
//   if (q.length === 0) {
//     return { tokens: [], raw: q, valid: false };
//   }
//   if (q.length > 512) {
//     throw new Error('query too long');
//   }
//   return { tokens: tokenize(q), raw: q, valid: true };
// }
// `);

//   commit(repo, 'Refactor tokenization and add pagination helper');
// }

// // ---------------------------------------------------------------------------
// // Scenario 6 — clean PR: should produce few/no real findings (noise control)
// // ---------------------------------------------------------------------------
// function scenarioClean() {
//   const repo = createRepo('feature-flag-service');
//   seedBaseline(repo, 'feature-flags');
//   commit(repo, 'Feature flag service baseline');

//   write(repo, 'src/flags.js', `import { evaluateFlag } from './evaluator';
// import { getFlagDefinition } from './store';

// /**
//  * Evaluates a feature flag for a user with fallback behavior.
//  */
// export async function resolveFlag(flagKey, user, fallback = false) {
//   const definition = await getFlagDefinition(flagKey);
//   if (!definition) {
//     return { enabled: fallback, source: 'missing-definition' };
//   }
//   try {
//     const enabled = await evaluateFlag(definition, user);
//     return { enabled, source: 'evaluator' };
//   } catch (error) {
//     return { enabled: fallback, source: 'evaluator-error' };
//   }
// }
// `);

//   write(repo, 'src/evaluator.js', `import { getUserPercentile } from './hashing';

// /**
//  * Percentage rollout evaluator: enabled when the user's percentile bucket
//  * falls below the rollout percentage, or when the user is on the allow list.
//  */
// export async function evaluateFlag(definition, user) {
//   if (definition.allowList?.includes(user.id)) {
//     return true;
//   }
//   if (definition.rolloutPercentage === undefined) {
//     return Boolean(definition.enabled);
//   }
//   const percentile = getUserPercentile(user.id, definition.salt ?? definition.key);
//   return percentile < definition.rolloutPercentage;
// }
// `);

//   write(repo, 'test/flags.test.js', `const assert = require('node:assert');
// const { resolveFlag } = require('../src/flags');
// const { evaluateFlag } = require('../src/evaluator');

// async function testResolveFlagMissingDefinition() {
//   const result = await resolveFlag('nope', { id: 'u1' });
//   assert.equal(result.enabled, false);
//   assert.equal(result.source, 'missing-definition');
// }

// async function testEvaluatorAllowList() {
//   const enabled = await evaluateFlag(
//     { key: 'beta-ui', allowList: ['u42'], rolloutPercentage: 0 },
//     { id: 'u42' },
//   );
//   assert.equal(enabled, true);
// }

// (async () => {
//   await testResolveFlagMissingDefinition();
//   await testEvaluatorAllowList();
//   console.log('flags tests passed');
// })();
// `);

//   commit(repo, 'Add percentage rollout evaluator with allow list and tests');
// }

// scenarioPayments();
// scenarioApiServer();
// scenarioDashboard();
// scenarioDataLayer();
// scenarioRefactor();
// scenarioClean();

// console.log('Seeded evaluation repos into', reposDir);
// for (const name of fs.readdirSync(reposDir)) {
//   const head = execFileSync('git', ['-C', path.join(reposDir, name), 'rev-parse', 'HEAD']).toString().trim();
//   console.log(`  ${name}: ${head}`);
// }
