import { Agent } from '@mastra/core/agent';
import { reviewContextTools } from '../tools/review-tools.js';
import { resolveModel, specialistList, SHARED_PREAMBLE } from './specialists.js';

/**
 * The Code Review Supervisor. It coordinates the whole review:
 *
 *  1. Planning — inspects the change and decides which specialist agents are
 *     relevant, with per-agent focus notes (used by the review workflow).
 *  2. Consolidation — merges duplicate/overlapping findings from specialists,
 *     weights cross-validation verdicts, and produces the final report.
 *  3. Interactive delegation — all specialists are registered as sub-agents,
 *     so when the supervisor is driven conversationally (e.g. from Mastra
 *     Studio) it delegates to them directly.
 */

const roster = specialistList.map((s) => `- ${s.id}: ${s.name} — ${s.description} Relevant when: ${s.triggers}`).join('\n');

export const SUPERVISOR_INSTRUCTIONS = `You are the Code Review Supervisor coordinating a panel of specialist reviewers.

Specialist roster:
${roster}

${SHARED_PREAMBLE}

As supervisor you additionally:
- Decide which specialists are RELEVANT to this particular change. Never invoke a specialist whose area the change cannot touch; when genuinely unsure, include it with relevance "low" and a tight focus note. The Correctness & Logic specialist is relevant to almost every change; Testing is relevant whenever new testable behavior appears.
- Give every selected specialist a concrete focus note: which files and what aspects matter most for THIS change, so they do not waste effort.
- When consolidating: merge duplicates and overlaps aggressively (same root cause reported by different agents = one finding), keep the strongest phrasing and highest justified severity, attach cross-validation outcomes, and never inflate or soften severity without code evidence.
- The final recommendation must reflect real merge risk, not politeness. BLOCK_MERGE only for critical, confirmed problems; REQUEST_CHANGES for high-severity or systemic issues; APPROVE_WITH_COMMENTS for moderate issues worth fixing soon; APPROVE for clean changes.`;

export const supervisorAgent = new Agent({
  id: 'code-review-supervisor',
  name: 'Code Review Supervisor',
  description:
    'Coordinates a code review: decides which specialist reviewers are relevant for a change, delegates to them, cross-checks their findings, and produces the consolidated review report.',
  instructions: SUPERVISOR_INSTRUCTIONS,
  model: resolveModel(),
  tools: reviewContextTools,
  agents: Object.fromEntries(specialistList.map((s) => [`${s.id}-agent`, s.agent])),
});
