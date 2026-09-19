import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardHtml, githubPrUrl } from '../dist/dashboard.js';

test('dashboard exposes the operations-console structure safely', () => {
  assert.match(dashboardHtml, /data-dashboard-contract="safe-dom,named-relay-events,snapshot-events,bounded-event-history"/);
  assert.match(dashboardHtml, />Usage<\/button>/);
  assert.match(dashboardHtml, /id="usage-heading">Usage<\/h2>/);
  assert.match(dashboardHtml, /id="events-panel"/);
  assert.match(dashboardHtml, /id="jobs-workspace"/);
  assert.match(dashboardHtml, /jobsWorkspace\.hidden=!isJobs/);
  assert.match(dashboardHtml, /function taskNode\(/);
  assert.match(dashboardHtml, /function renderTaskDetail\(/);
  assert.match(dashboardHtml, /sessionStorage\.setItem\('agents-relay:selected-job'/);
  assert.match(dashboardHtml, /sessionStorage\.setItem\('agents-relay:selected-task'/);
  assert.doesNotMatch(dashboardHtml, /innerHTML|document\.write/);
});

test('jobs panel supports manual refresh and unfinished-first ordering', () => {
  assert.match(dashboardHtml, /id="jobs-refresh"/);
  assert.match(dashboardHtml, /id="selected-job-refresh"/);
  assert.match(dashboardHtml, /selectedJobRefresh\.addEventListener\('click'/);
  assert.match(dashboardHtml, /loadJSON\('\/api\/job\?id='/);
  assert.match(dashboardHtml, /jobsRefresh\.addEventListener\('click'/);
  assert.match(dashboardHtml, /function isTerminalJob\(job\)/);
  assert.match(dashboardHtml, /jobs\.sort\(compareJobs\)/);
  assert.match(dashboardHtml, /COMPLETED','CANCELLED/);
  assert.match(dashboardHtml, /MERGED','CLOSED/);
});

test('selected job title appears in the panel heading', () => {
  assert.match(dashboardHtml, /id="selected-job-title"/);
  assert.match(dashboardHtml, /selectedJobTitle\.textContent='— '\+value\(job\.title\|\|job\.id\)/);
  assert.doesNotMatch(dashboardHtml, /field\('Title'/);
  assert.doesNotMatch(dashboardHtml, /field\('Description'/);
  assert.match(dashboardHtml, /field\('GitHub state',job\.githubState/);
  assert.match(dashboardHtml, /field\('Durable state',job\.state\)/);
});

test('account usage is limited to two real rate-limit percentage bars', () => {
  assert.match(dashboardHtml, /5-hour remaining/);
  assert.match(dashboardHtml, /Weekly remaining/);
  assert.match(dashboardHtml, /100-windowData\.usedPercent/);
  assert.match(dashboardHtml, /Weekly/);
  assert.match(dashboardHtml, /function usageProvider\(provider\)/);
  assert.match(dashboardHtml, /overview\.providers/);
  assert.match(dashboardHtml, /overview\.credits/);
  assert.match(dashboardHtml, /function creditProvider\(provider\)/);
  assert.match(dashboardHtml, /progressbar/);
  assert.match(dashboardHtml, /Math\.round\(percent\)\+'%'/);
  assert.doesNotMatch(dashboardHtml, /% available|% used/);
  assert.match(dashboardHtml, /Real account telemetry when available/);
  assert.doesNotMatch(dashboardHtml, /Quota \/ balance|Current durable job|requests ·|tokens ·/i);
});

test('GitHub PR links accept only validated durable repository and PR values', () => {
  assert.equal(githubPrUrl('lalalic/agents-relay', 4), 'https://github.com/lalalic/agents-relay/pull/4');
  for (const repository of ['', 'lalalic', '../evil', 'owner/.', 'owner/..', 'owner/repo?x=1']) {
    assert.equal(githubPrUrl(repository, 1), null);
  }
  for (const prNumber of [0, -1, 1.5, '1', Number.NaN]) {
    assert.equal(githubPrUrl('lalalic/agents-relay', prNumber), null);
  }
});

test('job list uses status badges with distinct state classes', () => {
  assert.match(dashboardHtml, /'badge '\+value\(job\.state\)/);
  assert.match(dashboardHtml, /\.badge\.COMPLETED/);
  assert.match(dashboardHtml, /\.badge\.OPEN/);
  assert.match(dashboardHtml, /\.badge\.CANCELLED/);
  assert.match(dashboardHtml, /\.badge\.FAILED/);
});

test('hidden dashboard views cannot be overridden by layout display rules', () => {
  assert.match(dashboardHtml, /\[hidden\] \{ display:none !important; \}/);
  assert.match(dashboardHtml, /jobsWorkspace\.hidden=!isJobs/);
});

test('credit providers render one balance value per provider row', () => {
  assert.match(dashboardHtml, /const balance=credits\.balances\[0\]/);
  assert.match(dashboardHtml, /formatCredit\(balance\.remaining,balance\.currency\)/);
  assert.doesNotMatch(dashboardHtml, /balance\.total!==null/);
  assert.doesNotMatch(dashboardHtml, /balance\.used!==null/);
});

test('job list uses PR-number title and concise state metadata', () => {
  assert.match(dashboardHtml, /text\('PR#'\+value\(job\.prNumber\)\+': '\+value\(job\.title\|\|job\.id\)\)/);
  assert.match(dashboardHtml, /'badge '\+value\(job\.state\)/);
  assert.match(dashboardHtml, /job\.draft\?'badge DRAFT':'/);
  assert.match(dashboardHtml, /job\.draft\?'DRAFT':value\(job\.githubState\|\|'UNKNOWN'\)/);
  assert.match(dashboardHtml, /\.badge\.DRAFT/);
  assert.match(dashboardHtml, /text\(relativeTime\(job\.updatedAt\)\)/);
  assert.doesNotMatch(dashboardHtml, /text\(job\.id\).*'PR #'/);
});




test('task details expose ChatGPT thread as chat link instead of raw execution identifiers', () => {
  assert.match(dashboardHtml, /function chatField\(task\)/);
  assert.match(dashboardHtml, /https:\/\/chatgpt\.com\/c\//);
  assert.match(dashboardHtml, /encodeURIComponent\(task\.threadId\)/);
  assert.match(dashboardHtml, /link\.textContent='Open chat'/);
  assert.doesNotMatch(dashboardHtml, /field\('Execution \/ thread'/);
});


test('task details omit input and result from dashboard', () => {
  assert.doesNotMatch(dashboardHtml, /markdownField\('Input'/);
  assert.doesNotMatch(dashboardHtml, /markdownField\('Result'/);
  assert.doesNotMatch(dashboardHtml, /function markdownValue\(/);
  assert.doesNotMatch(dashboardHtml, /function inlineMarkdown\(/);
});


test('selected job body does not scroll and omits task count field', () => {
  assert.match(dashboardHtml, /#jobs-workspace > \.panel:first-child \.panel-body \{ overflow:visible; max-height:none; \}/);
  assert.doesNotMatch(dashboardHtml, /field\('Tasks',String\(\(job\.tasks\|\|\[\]\)\.length\)\)/);
  assert.match(dashboardHtml, /field\('Task states'/);
});


test('job list exposes repository and quick repository/status filters', () => {
  assert.match(dashboardHtml, /id="repo-filter"/);
  assert.match(dashboardHtml, /id="status-filter"/);
  assert.match(dashboardHtml, /All repos/);
  assert.match(dashboardHtml, /All statuses/);
  assert.match(dashboardHtml, /text\(job\.repository\|\|'unknown repo'\)/);
  assert.match(dashboardHtml, /function filteredJobs\(\)/);
  assert.match(dashboardHtml, /sessionStorage\.setItem\('agents-relay:repo-filter'/);
  assert.match(dashboardHtml, /sessionStorage\.setItem\('agents-relay:status-filter'/);
});


test('dashboard warns when GitHub API is rate limited', () => {
  assert.match(dashboardHtml, /id="rate-limit-warning"/);
  assert.match(dashboardHtml, /GitHub API rate limit reached\. Showing cached job data\./);
  assert.match(dashboardHtml, /loadJSON\('\/api\/status'\)/);
  assert.match(dashboardHtml, /function renderRateLimitStatus\(status\)/);
});
