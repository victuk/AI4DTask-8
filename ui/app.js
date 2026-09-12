/* CodeMind UI — vanilla JS single-page app. Talks to the Mastra server API. */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const SEV_ORDER = ['critical', 'high', 'medium', 'low'];
const SEV_COLOR = { critical: '#f85149', high: '#db6d28', medium: '#d29922', low: '#8b949e' };
const STAGES = ['preparing', 'planning', 'specialists', 'cross-validation', 'consolidation', 'completed'];
const STAGE_LABEL = {
  preparing: 'Preparing', planning: 'Supervisor planning', specialists: 'Specialist reviews',
  'cross-validation': 'Cross-validation', consolidation: 'Consolidation', completed: 'Complete', failed: 'Failed',
};

const state = {
  source: 'commit',
  repo: null,           // { repoPath, info }
  currentReviewId: null,
  pollTimer: null,
  lastRecord: null,
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showView(name) {
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $(`#view-${name}`).classList.remove('hidden');
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
}

// ---------------- Tabs ----------------
$$('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    const view = tab.dataset.view;
    if (view === 'history') loadHistory();
    showView(view);
  }),
);

// ---------------- Health ----------------
async function refreshHealth() {
  try {
    const h = await api('/system-info');
    $('#health-chip').classList.add('ok');
    $('#model-chip').textContent = `model: ${h.model}`;
    $('#model-chip').title = h.openrouterKeyConfigured
      ? 'OPENROUTER_API_KEY configured'
      : '⚠ OPENROUTER_API_KEY missing — reviews will fail';
    $('#pr-token-hint').textContent = h.githubTokenConfigured || h.gitlabTokenConfigured
      ? '' : 'No GITHUB_TOKEN/GITLAB_TOKEN — public repos only';
  } catch {
    $('#health-chip').classList.remove('ok');
  }
}

// ---------------- Source selector ----------------
function fieldVisible(el) {
  const srcs = (el.dataset.forSrc || '').split(/\s+/);
  return srcs.includes(state.source);
}
function refreshFields() {
  $$('.field[data-for-src]').forEach((el) => el.classList.toggle('hidden', !fieldVisible(el)));
  $$('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.src === state.source));
}
$$('.seg-btn').forEach((btn) =>
  btn.addEventListener('click', () => {
    state.source = btn.dataset.src;
    refreshFields();
  }),
);
refreshFields();

// ---------------- Repo loading ----------------
$('#btn-load-repo').addEventListener('click', async () => {
  const repoPath = $('#repo-path').value.trim();
  if (!repoPath) return toast('Enter a repository path', true);
  try {
    const data = await api('/repos/info', { method: 'POST', body: { repoPath } });
    state.repo = data;
    renderRepoInfo();
    await loadCommits();
  } catch (e) {
    $('#repo-info').classList.add('hidden');
    toast(e.message, true);
  }
});

function renderRepoInfo() {
  const { info, repoPath } = state.repo;
  $('#repo-info').innerHTML =
    `<b>${esc(info.name)}</b> — ${esc(repoPath)}<br>` +
    `branch <b>${esc(info.branch ?? '?')}</b> · HEAD <b>${esc(info.headCommit ?? '?')}</b> · ${info.commitCount} commits` +
    (info.dirty ? ' · <span style="color:var(--yellow)">dirty worktree</span>' : '');
  $('#repo-info').classList.remove('hidden');
}

async function loadCommits() {
  const data = await api('/repos/commits', { method: 'POST', body: { repoPath: state.repo.repoPath, limit: 30 } });
  const sel = $('#commit-select');
  sel.innerHTML = data.commits
    .map((c) => `<option value="${esc(c.hash)}">${esc(c.short)} — ${esc(c.subject)} <span class="dim">(${esc(c.author)}, ${esc((c.date || '').slice(0, 10))})</span></option>`)
    .join('');
}

// ---------------- PR listing ----------------
$('#btn-load-prs').addEventListener('click', async () => {
  const url = $('#pr-url').value.trim().replace(/\/pull\/\d+.*$/, '').replace(/\/-\/merge_requests\/\d+.*$/, '');
  if (!url) return toast('Paste a GitHub or GitLab repository URL first', true);
  const list = $('#pr-list');
  list.classList.remove('hidden');
  list.innerHTML = '<div class="pr-item dim">Loading…</div>';
  try {
    const data = await api('/prs', { method: 'POST', body: { url } });
    list.innerHTML = data.prs.length === 0
      ? '<div class="pr-item dim">No open pull requests.</div>'
      : data.prs
          .map((p) => {
            const num = p.number ?? p.iid;
            const full = `${url.replace(/\/$/, '')}/-/merge_requests/${num}`;
            const gh = data.platform === 'github' ? `${url.replace(/\/$/, '')}/pull/${num}` : full;
            return `<div class="pr-item" data-url="${esc(data.platform === 'github' ? gh : full)}">
              <span><b>#${num}</b> ${esc(p.title)} <span class="dim">· ${esc(p.author)}</span></span>
              <span class="dim">${esc((p.updatedAt || '').slice(0, 10))}</span></div>`;
          })
          .join('');
    $$('#pr-list .pr-item').forEach((el) =>
      el.addEventListener('click', () => {
        $('#pr-url').value = el.dataset.url;
      }),
    );
  } catch (e) {
    list.innerHTML = `<div class="pr-item" style="color:var(--red)">${esc(e.message)}</div>`;
  }
});

// ---------------- Start review ----------------
$('#btn-start').addEventListener('click', async () => {
  const btn = $('#btn-start');
  const errBox = $('#new-error');
  errBox.classList.add('hidden');
  const body = { sourceType: state.source, options: {} };
  if (state.source === 'commit') {
    body.repoPath = $('#repo-path').value.trim();
    body.ref = $('#commit-select').value;
    if (!body.repoPath || !body.ref) return showError('Load a repository and pick a commit first.');
  } else if (state.source === 'repository') {
    body.repoPath = $('#repo-path').value.trim();
    if (!body.repoPath) return showError('Enter a repository path.');
  } else if (state.source === 'pr') {
    body.ref = $('#pr-url').value.trim();
    if (!body.ref) return showError('Paste a pull request URL.');
    if ($('#opt-post').checked) body.options.postComments = true;
  } else if (state.source === 'diff') {
    body.diffText = $('#diff-text').value;
    const ctxRepo = $('#diff-repo-path').value.trim();
    if (ctxRepo) body.repoPath = ctxRepo;
    if (!body.diffText.trim()) return showError('Paste a diff to review.');
  }
  if ($('#opt-skip-validation').checked) body.options.skipValidation = true;

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Starting…';
  try {
    const { reviewId } = await api('/reviews', { method: 'POST', body });
    openReview(reviewId, true);
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 Start agentic review';
  }
  function showError(msg) {
    errBox.textContent = msg;
    errBox.classList.remove('hidden');
  }
});

// ---------------- Review detail ----------------
function openReview(id, switchTab = false) {
  state.currentReviewId = id;
  showView('review');
  if (switchTab) window.scrollTo(0, 0);
  renderStepper('preparing');
  pollOnce();
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(pollOnce, 4000);
}

$('#btn-back').addEventListener('click', () => {
  clearInterval(state.pollTimer);
  showView('history');
  loadHistory();
});
$('#btn-refresh').addEventListener('click', pollOnce);

async function pollOnce() {
  const id = state.currentReviewId;
  if (!id) return;
  try {
    const record = await api(`/reviews/${id}`);
    state.lastRecord = record;
    renderReview(record);
    if (['completed', 'failed'].includes(record.stage)) {
      clearInterval(state.pollTimer);
    }
  } catch (e) {
    console.error(e);
  }
}

function renderStepper(stage) {
  const failed = stage === 'failed';
  const idx = STAGES.indexOf(stage);
  $('#stepper').innerHTML = STAGES.map((s, i) => {
    const cls = failed && i === idx ? 'failed' : i < idx ? 'done' : i === idx ? 'active' : '';
    const spinner = i === idx && !failed && stage !== 'completed' ? '<span class="spinner"></span>' : '';
    return `<div class="step ${cls}">${spinner}${STAGE_LABEL[s]}</div>`;
  }).join('');
  $('#stepper').classList.remove('hidden');
}

function agentEmoji(id) {
  const map = { correctness: '🐛', security: '🔐', architecture: '🏛️', performance: '⚡', quality: '✨', testing: '🧪', database: '🗄️', concurrency: '⏱️', dependency: '📦' };
  return map[id] || '🤖';
}
const agentName = (id) => id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function renderReview(record) {
  $('#review-title').textContent = record.title || `${record.repoName} — ${record.sourceRef}`;
  $('#review-meta').innerHTML =
    `<span class="mono">${esc(record.id)}</span> · ${esc(record.repoName)} · ${esc(record.sourceType)}: ${esc(record.sourceRef)} · model ${esc(record.model)}` +
    (record.durationMs ? ` · ${(record.durationMs / 1000).toFixed(1)}s` : '');
  renderStepper(record.stage);

  const errBox = $('#review-error');
  if (record.error) { errBox.textContent = record.error; errBox.classList.remove('hidden'); }
  else errBox.classList.add('hidden');

  // Plan
  if (record.plan) {
    const p = record.plan;
    $('#plan-box').innerHTML =
      `<div style="color:var(--text)"><b>${esc(p.changeType)}</b></div>` +
      `<div style="margin:6px 0"><b>Risk:</b> ${esc(p.riskProfile)}</div>` +
      `<div><b>Selected specialists:</b></div>` +
      p.specialists.map((s) => `<div>• <b>${agentEmoji(s.agent)} ${esc(agentName(s.agent))}</b> <span class="pill conf">${esc(s.relevance)} relevance</span> — ${esc(s.focus)}</div>`).join('') +
      `<div style="margin-top:8px;color:var(--dim)">${esc(p.reasoning)}</div>`;
  }

  // Agent activity
  const acts = record.agentActivities || [];
  $('#agent-activity').innerHTML = acts.length === 0
    ? '<span class="dim">Waiting for the supervisor plan…</span>'
    : acts
        .map((a) => {
          const st = a.status === 'pending' ? 'pending' : a.status;
          const detail = a.status === 'done'
            ? `${a.findingCount ?? 0} findings${a.filesInspected?.length ? ` · inspected ${a.filesInspected.length} files` : ''}`
            : a.status === 'error'
              ? esc(a.error || 'failed')
              : a.status === 'running' ? 'reviewing the change…' : 'queued';
          return `<div class="agent-row"><span>${agentEmoji(a.agent)}</span><span class="name">${esc(agentName(a.agent))}</span><span class="status ${st}">${st}</span><span class="detail">${detail}</span></div>`;
        })
        .join('');

  // Verdict
  const banner = $('#verdict-banner');
  if (record.report) {
    const r = record.report;
    banner.className = `verdict ${r.recommendation}`;
    banner.innerHTML = `${r.recommendation.replace(/_/g, ' ')}<span class="risk">overall risk: ${esc(r.overallRisk)} · ${r.findings.length} findings</span>`;
    $('#report-summary').classList.remove('hidden');
    $('#report-summary').textContent = r.summary;
    const pos = $('#positives');
    if (r.positives?.length) {
      pos.classList.remove('hidden');
      pos.innerHTML = `<b>Looks good:</b><ul>${r.positives.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
    } else pos.classList.add('hidden');
    $('#btn-post-pr').classList.toggle('hidden', record.sourceType !== 'pr');
  } else {
    banner.classList.add('hidden');
    $('#report-summary').classList.add('hidden');
    $('#positives').classList.add('hidden');
    $('#btn-post-pr').classList.add('hidden');
  }

  // Findings
  renderFindings(record);
  renderDiff(record);
}

function populateFilters(record) {
  const cats = [...new Set((record.report?.findings || []).map((f) => f.category))].sort();
  const files = [...new Set((record.report?.findings || []).map((f) => f.location.file))].sort();
  const sevSel = $('#filter-severity');
  const catSel = $('#filter-category');
  const fileSel = $('#filter-file');
  const keep = (el, items, label) => {
    const cur = el.value;
    el.innerHTML = `<option value="">${label}</option>` + items.map((i) => `<option>${esc(i)}</option>`).join('');
    if (items.includes(cur)) el.value = cur;
  };
  keep(sevSel, SEV_ORDER, 'All severities');
  keep(catSel, cats, 'All categories');
  keep(fileSel, files, 'All files');
}

function renderFindings(record) {
  const findings = record.report?.findings || [];
  populateFilters(record);
  $('#finding-count').textContent = findings.length ? `${findings.length}` : '';
  const sv = $('#filter-severity').value;
  const cat = $('#filter-category').value;
  const file = $('#filter-file').value;
  const filtered = findings.filter(
    (f) => (!sv || f.severity === sv) && (!cat || f.category === cat) && (!file || f.location.file === file),
  );
  const list = $('#findings-list');
  if (!findings.length) {
    list.innerHTML = record.stage === 'completed'
      ? '<div class="dim">No findings — clean change. 🎉</div>'
      : '<div class="dim">Findings appear here as the report is consolidated…</div>';
    return;
  }
  if (!filtered.length) { list.innerHTML = '<div class="dim">No findings match the current filters.</div>'; return; }
  const sorted = [...filtered].sort(
    (a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }),
  );
  list.innerHTML = sorted
    .map((f) => {
      const loc = f.location?.file || '?';
      const line = f.location?.line ? `:${f.location.line}` : '';
      return `<div class="finding ${esc(f.severity)}">
        <h4><span class="pill ${esc(f.severity)}">${esc(f.severity)}</span> ${esc(f.title)}</h4>
        <div class="file" data-file="${esc(loc)}" data-line="${f.location?.line || ''}">${esc(loc)}${line}</div>
        <div style="margin-top:6px">
          <span class="pill cat">${esc(f.category)}</span>
          <span class="pill conf">confidence: ${esc(f.confidence)}</span>
          ${f.reportedBy?.length ? `<span class="pill conf">by ${esc(f.reportedBy.join(', '))}</span>` : ''}
        </div>
        ${f.location?.snippet ? `<pre>${esc(f.location.snippet)}</pre>` : ''}
        <p><span class="label">What:</span>${esc(f.explanation)}</p>
        <p><span class="label">Impact:</span>${esc(f.impact)}</p>
        <p><span class="label">Fix:</span>${esc(f.recommendation)}</p>
        ${f.validation ? `<div class="validation">Cross-validation: <b class="v-${esc(f.validation.verdict)}">${esc(f.validation.verdict)}</b> by ${esc(agentName(f.validation.validatorAgent))} — ${esc(f.validation.rationale)}</div>` : ''}
      </div>`;
    })
    .join('');
  $$('#findings-list .file').forEach((el) =>
    el.addEventListener('click', () => showDiffFor(el.dataset.file, Number(el.dataset.line) || null, record)),
  );
}

function renderDiff(record) {
  $('#diff-stats').textContent = record.diffStats ? record.diffStats.trim().split('\n').pop() : `${record.changedFiles?.length || 0} files`;
  const box = $('#diff-view');
  if (!record.diff) { box.textContent = 'Diff appears here once the review starts.'; return; }
  box.innerHTML = record.diff
    .split('\n')
    .map((l) => {
      const e = esc(l);
      if (l.startsWith('@@')) return `<span class="fh">${e}</span>`;
      if (l.startsWith('+')) return `<span class="add">${e}</span>`;
      if (l.startsWith('-')) return `<span class="del">${e}</span>`;
      return e;
    })
    .join('\n');
}

function showDiffFor(file, line, record) {
  renderDiff(record);
  const box = $('#diff-view');
  box.scrollTop = 0;
  const lines = box.innerHTML.split('\n');
  // crude highlight: find the diff line containing the file then scan forward N add-lines
  const plain = record.diff.split('\n');
  let idx = -1, count = 0;
  for (let i = 0; i < plain.length; i++) {
    if (plain[i].startsWith('diff --git') && plain[i].includes(file)) { idx = i; break; }
  }
  if (idx >= 0) {
    box.scrollTop = 0;
    // approximate: 17px per line
    box.scrollTop = idx * 16.4;
    if (line) box.scrollTop += line * 10;
    box.style.outline = '2px solid var(--accent)';
    setTimeout(() => (box.style.outline = ''), 1200);
  }
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------------- Post to PR ----------------
$('#btn-post-pr').addEventListener('click', async () => {
  const id = state.currentReviewId;
  if (!id) return;
  if (!confirm('Post these findings as comments on the pull request?')) return;
  try {
    const res = await api(`/reviews/${id}/post-to-pr`, { method: 'POST', body: {} });
    toast(`Posted to PR (${res.commentCount} comments${res.url ? '' : ''})`);
    if (res.url) window.open(res.url, '_blank');
  } catch (e) {
    toast(e.message, true);
  }
});

// ---------------- Download markdown ----------------
$('#btn-download').addEventListener('click', () => {
  if (state.currentReviewId) window.open(`/reviews/${state.currentReviewId}/markdown`, '_blank');
});

// ---------------- History ----------------
async function loadHistory() {
  try {
    const { reviews } = await api('/reviews?limit=100');
    const box = $('#history-list');
    if (!reviews.length) { box.innerHTML = '<div class="dim">No reviews yet — start one from the “New review” tab.</div>'; fillCompareSelects([]); return; }
    box.innerHTML = reviews
      .map((r) => {
        const dots = SEV_ORDER.map(
          (s) => `<span class="sev-dot" style="background:${SEV_COLOR[s]}22;color:${SEV_COLOR[s]}" title="${r.severityCounts?.[s] ?? 0} ${s}">${r.severityCounts?.[s] ?? 0}</span>`,
        ).join('');
        const badge = r.recommendation
          ? `<span class="pill" style="background:var(--accent-soft);color:var(--accent)">${esc(r.recommendation.replace(/_/g, ' '))}</span>`
          : `<span class="status ${r.stage === 'failed' ? 'error' : 'running'}">${esc(r.stage)}</span>`;
        return `<div class="history-item" data-id="${esc(r.id)}">
          <div>
            <div class="title">${esc(r.sourceRef)}</div>
            <div class="meta">${esc(r.repoName)} · ${esc(r.sourceType)} · ${new Date(r.createdAt).toLocaleString()}${r.durationMs ? ` · ${(r.durationMs / 1000).toFixed(0)}s` : ''}</div>
          </div>
          <div class="row"><div class="sev-dots">${dots}</div>${badge}</div>
        </div>`;
      })
      .join('');
    $$('#history-list .history-item').forEach((el) => el.addEventListener('click', () => openReview(el.dataset.id)));
    fillCompareSelects(reviews);
  } catch (e) {
    toast(e.message, true);
  }
}

function fillCompareSelects(reviews) {
  const a = $('#compare-a');
  const b = $('#compare-b');
  const opts = reviews
    .filter((r) => r.stage === 'completed')
    .map((r) => `<option value="${esc(r.id)}">${esc(r.repoName)} · ${esc(r.sourceRef.slice(0, 40))} · ${new Date(r.createdAt).toLocaleDateString()}</option>`)
    .join('');
  a.innerHTML = opts;
  b.innerHTML = opts;
  if (opts) b.selectedIndex = Math.min(1, reviews.length - 1);
}

$('#btn-compare').addEventListener('click', async () => {
  const a = $('#compare-a').value;
  const b = $('#compare-b').value;
  if (!a || !b || a === b) return toast('Pick two different completed reviews', true);
  try {
    const diff = await api(`/reviews/${b}/compare?against=${a}`);
    showView('compare');
    $('#compare-title').textContent = 'Review comparison';
    const section = (title, items, color) =>
      `<div class="cmp-section"><h3>${title} (${items.length})</h3>${
        items.length === 0 ? '<div class="dim">none</div>' : items.map((f) => `<div class="cmp-item" style="border-left:4px solid ${SEV_COLOR[f.severity] || '#888'}"><b>${esc(f.title)}</b> <span class="pill ${esc(f.severity)}">${esc(f.severity)}</span><br><span class="mono dim">${esc(f.file)}${f.line ? ':' + f.line : ''}</span></div>`).join('')
      }</div>`;
    $('#compare-body').innerHTML =
      section('🆕 New in the later review', diff.newFindings) +
      section('🔁 Persistent in both', diff.persistentFindings) +
      section('✅ Resolved since the earlier review', diff.resolvedFindings, '#3fb950');
  } catch (e) {
    toast(e.message, true);
  }
});
$('#btn-back-compare').addEventListener('click', () => { showView('history'); loadHistory(); });

// ---------------- Agents tab ----------------
const AGENT_META = [
  ['supervisor', '🧠', 'Code Review Supervisor', 'Plans the review, selects relevant specialists with focus notes, cross-checks high severity findings, consolidates the final report and recommendation.'],
  ['correctness', '🐛', 'Correctness & Logic', 'Logic errors, broken edge cases, wrong conditionals, exception-handling failures, and behavior that contradicts the stated intent.'],
  ['security', '🔐', 'Security', 'Injection, broken authn/authz, secret exposure, insecure configuration, input validation gaps.'],
  ['architecture', '🏛️', 'Architecture & Design', 'Layering violations, coupling, weak abstractions, deviations from the repository’s established patterns.'],
  ['performance', '⚡', 'Performance & Scalability', 'N+1 queries, O(n²) loops, blocking hot paths, unbounded memory growth, scalability limits.'],
  ['quality', '✨', 'Code Quality & Maintainability', 'Duplication, dead code, debug leftovers, confusing structure and naming that slows maintenance.'],
  ['testing', '🧪', 'Testing', 'Missing unit/integration/edge-case/failure tests; tests that cannot fail; invalidated test assumptions.'],
];
$('#agents-grid').innerHTML = AGENT_META.map(
  ([id, emoji, name, desc], i) =>
    `<div class="agent-card"><div class="emoji">${emoji}</div>${i === 0 ? '<div class="sup">Coordinator</div>' : '<div class="sup" style="color:var(--dim)">Specialist</div>'}<h4>${name}</h4><p>${desc}</p></div>`,
).join('');

// ---------------- Init ----------------
refreshHealth();
setInterval(refreshHealth, 30000);
loadHistory();
