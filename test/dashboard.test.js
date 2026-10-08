import test, { managedDashboard } from './test-runtime.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { Script } from 'node:vm';
import { readFileSync } from 'node:fs';
import { dashboardHtml, dashboardVersion, dashboardWorkflowGraphs, githubPrUrl, serveDashboard } from '../dist/dashboard.js';
import { InMemoryStore } from '../dist/store.js';


test('dashboard inline JavaScript parses before publication', () => {
  const scripts = [...dashboardHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).filter(Boolean);
  assert.ok(scripts.length > 0);
  for (const source of scripts) assert.doesNotThrow(() => new Script(source));
});

test('dashboard polls the live package version and reloads only when it changes', () => {
  assert.match(dashboardHtml, /const DASHBOARD_VERSION=/);
  assert.match(dashboardHtml, /loadJSON\('\/api\/version'\)/);
  assert.match(dashboardHtml, /live\?\.version&&live\.version!==DASHBOARD_VERSION\)location\.reload\(\)/);
  assert.match(dashboardHtml, /setInterval\(\(\)=>void refreshVersion\(\),30000\)/);
});

test('dashboard exposes the live package version without caching', async () => {
  const server = managedDashboard(new InMemoryStore({ id: 'version-job', title: 'Version job', executionMode: 'fixed', prNumber: 1, repository: 'owner/repo', state: 'ACTIVE', continuation: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: [] }), 0, undefined, 300000, 'version-job');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/version`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { version: dashboardVersion });
});

test('dashboard switches jobs list and detail into a mobile drill-down flow', () => {
  assert.match(dashboardHtml, /id="mobile-jobs-back"/);
  assert.match(dashboardHtml, /body\[data-mobile-jobs-view="list"\] #jobs-workspace/);
  assert.match(dashboardHtml, /body\[data-mobile-jobs-view="detail"\] #jobs-view/);
  assert.match(dashboardHtml, /function syncMobileJobsView\(\)/);
  assert.match(dashboardHtml, /location\.hash='#\/jobs';syncMobileJobsView\(\)/);
});

test('mobile jobs view keeps only the repository filter and hides runtime summary', () => {
  assert.match(dashboardHtml, /\.runtime-summary \{ display:none; \}/);
  assert.match(dashboardHtml, /#jobs-view \.job-search,[\s\S]*#jobs-view #quick-status,[\s\S]*#jobs-view #quick-autonomous,[\s\S]*#jobs-view #quick-draft \{ display:none; \}/);
  assert.match(dashboardHtml, /id="repo-filter"/);
});

test('mobile usage view uses compact single-column cards', () => {
  assert.match(dashboardHtml, /#usage-view \.usage-provider \{[\s\S]*grid-template-columns:1fr;/);
  assert.match(dashboardHtml, /#usage-view \.usage-track \{ height:\.48rem;/);
  assert.match(dashboardHtml, /#usage-view \.panel-head \.subtle \{ display:none; \}/);
  assert.match(dashboardHtml, /#usage-view \.usage-details \{ padding-top:\.35rem; \}/);
});

test('mobile Router Rules removes the nested scroll trap and exposes touch-sized actions', () => {
  assert.match(dashboardHtml, /#rules-view \.panel-body\{max-height:none;overflow:visible;/);
  assert.match(dashboardHtml, /#rules-view \.rules-footer>div\{width:100%;display:grid;grid-template-columns:1fr 1fr;/);
  assert.match(dashboardHtml, /#rules-view \.rules-save\{min-height:44px;width:100%;/);
  assert.match(dashboardHtml, /#rules-view \.audit-log\{max-height:none\}/);
  assert.match(dashboardHtml, /#rules-view \.router-test-results\{max-height:none;width:100%;max-width:100%;overflow-x:hidden\}/);
  assert.match(dashboardHtml, /#rules-view \.router-test-panel\{min-width:0;max-width:100%;overflow:hidden\}/);
  assert.match(dashboardHtml, /#rules-view \.router-test-results pre\{width:100%;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font-size:11px;/);
});

test('task tree rows stay within the mobile viewport and ellipsize long ids', () => {
  assert.match(dashboardHtml, /ul\.tree li \{ min-width:0; max-width:100%; \}/);
  assert.match(dashboardHtml, /\.task-row \{ width:100%; max-width:100%; overflow:hidden;/);
  assert.match(dashboardHtml, /\.task-row \.badge \{ flex:0 0 auto; \}/);
  assert.match(dashboardHtml, /\.task-id \{ min-width:0; max-width:100%; flex:1 1 0; overflow:hidden; text-overflow:ellipsis;/);
});

test('primary task tree excludes planner-history records', () => {
  assert.match(dashboardHtml, /const work=tasks\.filter\(task=>task\.kind!=='planner'\)/);
  assert.match(dashboardHtml, /No work tasks in durable state/);
});

test('task rows append optional Job-defined tag display without replacing lifecycle', () => {
  assert.match(dashboardHtml, /function taskTagDisplay\(job,task\)/);
  assert.match(dashboardHtml, /job\?\.tag\?\.values\?\.\[task\.tag\]/);
  assert.match(dashboardHtml, /'task-tag'/);
  assert.match(dashboardHtml, /'badge '\+value\(task\.state\)/);
});

test('task tree branches default-collapse complete subtrees and preserve manual fold overrides', () => {
  assert.match(dashboardHtml, /const collapsedTasks=new Set\(\)/);
  assert.match(dashboardHtml, /const expandedTasks=new Set\(\)/);
  assert.match(dashboardHtml, /function taskSubtreeComplete\(task,children\)\{return \['SUCCEEDED','CANCELLED'\]\.includes\(task\.state\)&&\(children\.get\(task\.id\)\|\|\[\]\)\.every\(child=>taskSubtreeComplete\(child,children\)\);\}/);
  assert.match(dashboardHtml, /collapsedTasks\.has\(key\)\|\|\(!expandedTasks\.has\(key\)&&taskSubtreeComplete\(task,children\)\)/);
  assert.match(dashboardHtml, /className='task-fold'/);
  assert.match(dashboardHtml, /fold\.setAttribute\('aria-expanded',String\(!collapsed\)\)/);
  assert.match(dashboardHtml, /ul\.hidden=collapsed/);
  assert.match(dashboardHtml, /collapsedTasks\.add\(key\);expandedTasks\.delete\(key\)/);
  assert.match(dashboardHtml, /collapsedTasks\.delete\(key\);expandedTasks\.add\(key\)/);
  assert.match(dashboardHtml, /if\(nested\.length\)\{/);
});

test('dashboard exposes a top-level Graphs browser backed by the workflow graph API', () => {
  assert.match(dashboardHtml, /id="graphs-tab"[\s\S]*>Graphs<\/button>/);
  assert.match(dashboardHtml, /id="shortcuts-tab"[\s\S]*>Shortcuts<\/button>[\s\S]*id="graphs-tab"[\s\S]*>Graphs<\/button>/);
  assert.match(dashboardHtml, /id="graphs-view"/);
  assert.match(dashboardHtml, /loadJSON\('\/api\/graphs'\)/);
  assert.match(dashboardHtml, /function renderSelectedGraph\(\)/);
  assert.match(dashboardHtml, /window\.mermaid\.render/);
  assert.match(dashboardHtml, /new DOMParser\(\)\.parseFromString\(rendered\.svg,'image\/svg\+xml'\)/);
  assert.match(dashboardHtml, /id="graph-source"/);
});

test('dashboard discovers workflow Mermaid files dynamically', async () => {
  const graphs = await dashboardWorkflowGraphs();
  assert.ok(graphs.length >= 10);
  assert.ok(graphs.some(graph => graph.id === 'job-lifecycle' && graph.name === 'Job Lifecycle'));
  assert.ok(graphs.every(graph => graph.path.startsWith('workflow/') && graph.path.endsWith('.mmd')));
  assert.ok(graphs.every(graph => graph.source.trim().length > 0));
});

test('dashboard exposes workflow graphs through a no-store API', async () => {
  const job = { id: 'graphs-job', title: 'Graphs', executionMode: 'fixed', prNumber: 1, repository: 'owner/repo', state: 'ACTIVE', continuation: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: [] };
  const server = managedDashboard(new InMemoryStore(job), 0, undefined, 300000, job.id);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/graphs`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const graphs = await response.json();
  assert.ok(graphs.some(graph => graph.id === 'task-lifecycle' && graph.name === 'Task Lifecycle'));
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('dashboard exposes a top-level ChatGPT Shortcuts editor beside Router Rules', () => {
  assert.match(dashboardHtml, /id="rules-tab"[\s\S]*>Router Rules<\/button>[\s\S]*id="shortcuts-tab"[\s\S]*>Shortcuts<\/button>/);
  assert.match(dashboardHtml, /id="shortcuts-view"/);
  assert.match(dashboardHtml, /id="shortcuts-text"/);
  assert.match(dashboardHtml, /id="shortcuts-save"/);
  assert.match(dashboardHtml, /localStorage\.setItem\(CHAT_SHORTCUTS_KEY/);
});

test('job detail exposes ChatGPT shortcuts as an empty-first select that resets after launch', () => {
  assert.match(dashboardHtml, /function chatShortcutField\(job\)/);
  assert.match(dashboardHtml, /select\.append\(new Option\('',''\)\)/);
  assert.match(dashboardHtml, /job-chat-shortcut-select/);
  assert.match(dashboardHtml, /const CHAT_SHORTCUT_TARGET='agents-relay-shortcut';/);
  assert.match(dashboardHtml, /window\.open\(chatShortcutUrl\(prompt\),CHAT_SHORTCUT_TARGET,'noopener'\)/);
  assert.doesNotMatch(dashboardHtml, /window\.open\(chatShortcutUrl\(prompt\),'_blank','noopener'\)/);
  assert.match(dashboardHtml, /select\.value='';/);
  assert.match(dashboardHtml, /chatShortcutField\(job\)/);
});

test('dashboard applies lifecycle state patches from relay SSE without refetching jobs', () => {
  assert.match(dashboardHtml, /function applyStatePatch\(patch\)/);
  assert.match(dashboardHtml, /if\(patch\.jobState\)job\['state'\]=patch\.jobState/);
  assert.match(dashboardHtml, /task\['state'\]=patch\.taskState/);
  assert.match(dashboardHtml, /payload\?\.statePatch\)applyStatePatch\(payload\.statePatch\)/);
  assert.doesNotMatch(dashboardHtml, /payload\?\.statePatch[\s\S]{0,120}refresh\(/);
});

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


test('SSE connection health stays out of the durable job event feed', () => {
  assert.match(dashboardHtml, /stream\.onopen=\(\)=>\{connection\.textContent='';connection\.setAttribute\('aria-label','Event stream connected'\);connection\.className='status-pill ok';\}/);
  assert.match(dashboardHtml, /stream\.onerror=\(\)=>\{connection\.textContent='';connection\.setAttribute\('aria-label','Event stream reconnecting'\);connection\.className='status-pill warn';\}/);
  assert.doesNotMatch(dashboardHtml, /addEvent\(\{type:'connection'/);
});

test('jobs panel supports manual refresh and unfinished-first ordering', () => {
  assert.match(dashboardHtml, /id="jobs-refresh"/);
  assert.match(dashboardHtml, /id="selected-job-refresh"/);
  assert.match(dashboardHtml, /selectedJobRefresh\.addEventListener\('click'/);
  assert.match(dashboardHtml, /new URLSearchParams\(\{id:job\.id,repo:job\.repository,pr:String\(job\.prNumber\)\}\)/);
  assert.match(dashboardHtml, /loadJSON\('\/api\/job\?'\+params\.toString\(\)\)/);
  assert.match(dashboardHtml, /jobsRefresh\.addEventListener\('click',\(\)=>void refresh\(true\)\)/);
  assert.match(dashboardHtml, /\/api\/jobs'\+\(force\?'\?refresh=1'/);
  assert.match(dashboardHtml, /function isTerminalJob\(job\)/);
  assert.match(dashboardHtml, /jobs\.sort\(compareJobs\)/);
  assert.match(dashboardHtml, /COMPLETED','CANCELLED/);
  assert.match(dashboardHtml, /MERGED','CLOSED/);
});

test('events follow selected job/task and can return to all tasks', () => {
  assert.match(dashboardHtml, /id="events-all-tasks"/);
  assert.match(dashboardHtml, /let eventTaskId=selectedTaskId/);
  assert.match(dashboardHtml, /const deselect=selectedTaskId===task\.id/);
  assert.match(dashboardHtml, /eventTaskId=deselect\?null:task\.id/);
  assert.match(dashboardHtml, /eventTaskId&&event\.task_id!==eventTaskId/);
  assert.match(dashboardHtml, /eventsAllTasks\.addEventListener\('click'/);
  assert.match(dashboardHtml, /eventTaskId=null;clearEvents\(\);renderEventScope\(\)/);
  assert.match(dashboardHtml, /eventTaskId=null;rememberSelection\(\);clearEvents\(\)/);
});

test('dashboard labels relay and worker lifecycle phases distinctly', () => {
  assert.match(dashboardHtml, /function eventLabel\(type\)/);
  assert.match(dashboardHtml, /Process launched/);
  assert.match(dashboardHtml, /Worker started/);
  assert.match(dashboardHtml, /Sync process exited/);
  assert.match(dashboardHtml, /Async process exited/);
  assert.match(dashboardHtml, /task\.process\.async_exited/);
});

test('events replay canonical history when job or task selection changes', () => {
  assert.match(dashboardHtml, /loadJSON\('\/api\/events\?'/);
  assert.match(dashboardHtml, /async function loadEventHistory\(\)/);
  assert.match(dashboardHtml, /void loadEventHistory\(\)/);
  assert.match(dashboardHtml, /displayedEventIds\.has\(event\.event_id\)/);
});


test('task attempts display as cumulative count over three-attempt windows', () => {
  assert.match(dashboardHtml, /function attemptBudget\(task\)/);
  assert.match(dashboardHtml, /Math\.max\(max,Math\.ceil\(attempt\/3\)\*3\)/);
  assert.match(dashboardHtml, /field\('Attempt',attemptBudget\(task\)\)/);
});

test('selected job heading is title-only and single-line', () => {
  assert.match(dashboardHtml, /id="selected-job-title"/);
  assert.doesNotMatch(dashboardHtml, />Selected job </);
  assert.match(dashboardHtml, /selectedJobTitle\.textContent=value\(job\.title\|\|job\.id\)/);
  assert.match(dashboardHtml, /#workspace-heading \{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; \}/);
  assert.match(dashboardHtml, /#selected-job-title \{ display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; \}/);
  assert.doesNotMatch(dashboardHtml, /field\('Title'/);
  assert.doesNotMatch(dashboardHtml, /field\('Description'/);
  assert.match(dashboardHtml, /field\('PR state',job\.githubState/);
  assert.match(dashboardHtml, /jobStateField\(job\)/);
  assert.match(dashboardHtml, /field\('Runtime status',job\.runtimeStatus\|\|'IDLE'\)/);
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
  assert.match(dashboardHtml, /function resetText\(windowData\)/);
  assert.match(dashboardHtml, /Resets /);
  assert.match(dashboardHtml, /toLocaleString\(\)/);
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

test('job rows show lifecycle and runtime without PR state or quick actions', () => {
  assert.match(dashboardHtml, /'job-row'/);
  assert.match(dashboardHtml, /element\('div','job-primary'\)/);
  assert.match(dashboardHtml, /job\.state/);
  assert.match(dashboardHtml, /job\.runtimeStatus\|\|'IDLE'/);
  assert.doesNotMatch(dashboardHtml, /states\.append\([^;]*job\.githubState/);
  assert.match(dashboardHtml, /field\('PR state',job\.githubState\|\|'UNKNOWN'\)/);
  assert.doesNotMatch(dashboardHtml, /actionButton\(job/);
  assert.doesNotMatch(dashboardHtml, /className='job-action'/);
  assert.match(dashboardHtml, /const primary=element\('div','job-primary'\);primary\.append\(states\)/);
});

test('job rows keep autonomous and review flags in the status row', () => {
  assert.match(dashboardHtml, /job\.executionMode==='autonomous'/);
  assert.match(dashboardHtml, /text\('AUTONOMOUS'\)/);
  assert.match(dashboardHtml, /job\.reviewEnabled!==false/);
  assert.match(dashboardHtml, /text\('REVIEW REQUIRED'\)/);
  assert.doesNotMatch(dashboardHtml, /job-meta/);
  assert.doesNotMatch(dashboardHtml, /mode-\+value\(job\.executionMode/);
});

test('job list groups ordinary, autonomous, draft, and terminal jobs', () => {
  assert.match(dashboardHtml, /function jobGroup\(job\)/);
  assert.match(dashboardHtml, /if\(isTerminalJob\(job\)\)return 3/);
  assert.match(dashboardHtml, /if\(job\.executionMode==='autonomous'\)return 1/);
  assert.match(dashboardHtml, /if\(job\.draft\|\|job\.state==='DRAFT'\)return 2/);
  assert.match(dashboardHtml, /const groupDelta=jobGroup\(a\)-jobGroup\(b\)/);
});

test('job row selection uses repository, PR, and durable id as one UI identity', () => {
  assert.match(dashboardHtml, /function jobSelectionKey\(job\)/);
  assert.match(dashboardHtml, /String\(job\.repository\|\|''\).*String\(job\.prNumber\|\|''\).*String\(job\.id\|\|''\)/);
  assert.match(dashboardHtml, /function jobForSelection\(selection\).*jobSelectionKey\(job\)===selection.*job\.id===selection/);
  assert.match(dashboardHtml, /row\.setAttribute\('aria-current',String\(jobSelectionKey\(job\)===selectedJob\)\)/);
  assert.match(dashboardHtml, /row\.addEventListener\('click',\(\)=>selectJob\(job\)\)/);
  assert.match(dashboardHtml, /select\.addEventListener\('click',event=>\{event\.stopPropagation\(\);selectJob\(job\);\}\)/);
  assert.match(dashboardHtml, /new URLSearchParams\(\{job:job\.id,limit:String\(MAX_EVENTS\)\}\)/);
  assert.match(dashboardHtml, /jobSelectionKey\(job\)===jobSelectionKey\(payload\.job\)/);
});

test('dashboard job actions invoke the supplied runtime handler', async () => {
  const job = { id: 'action-job', title: 'Actions', executionMode: 'fixed', prNumber: 1, repository: 'owner/repo', state: 'ACTIVE', continuation: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: [] };
  let invoked = '';
  const server = managedDashboard(new InMemoryStore(job), 0, undefined, 300000, job.id, undefined, undefined, undefined, undefined, undefined, {
    reconcile: async jobId => { invoked = jobId; return job; }
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/job-action?id=${job.id}&action=reconcile`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(invoked, job.id);
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});


test('selected job exposes one direct durable lifecycle selector while runtime status stays derived', () => {
  assert.match(dashboardHtml, /const JOB_STATES=\['DRAFT','ACTIVE','COMPLETED','CANCELLED'\]/);
  assert.match(dashboardHtml, /job-state-select/);
  assert.match(dashboardHtml, /new URLSearchParams\(\{id:job\.id,state,repo:job\.repository,pr:String\(job\.prNumber\)\}\)/);
  assert.match(dashboardHtml, /field\('Runtime status',job\.runtimeStatus\|\|'IDLE'\)/);
});

test('selected task exposes one direct durable state selector instead of retry and cancel buttons', () => {
  assert.match(dashboardHtml, /const TASK_STATES=\['DRAFT','QUEUED','RUNNING','BLOCKED','UNBLOCKED','SUCCEEDED','FAILED','CANCELLED'\]/);
  assert.match(dashboardHtml, /task-state-select/);
  assert.match(dashboardHtml, /new URLSearchParams\(\{id:job\.id,task:task\.id,state,repo:job\.repository,pr:String\(job\.prNumber\)\}\)/);
  assert.doesNotMatch(dashboardHtml, /taskActionButton\(task,'retry'/);
  assert.doesNotMatch(dashboardHtml, /taskActionButton\(task,'cancel'/);
});

test('dashboard job state override invokes the supplied runtime handler', async () => {
  const job = { id: 'job-state-job', title: 'Job state', executionMode: 'fixed', prNumber: 1, repository: 'owner/repo', state: 'ACTIVE', continuation: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: [] };
  let invoked = '';
  let target;
  const server = managedDashboard(new InMemoryStore(job), 0, undefined, 300000, job.id, undefined, undefined, undefined, undefined, undefined, {
    jobSetState: async (jobId, state, receivedTarget) => { invoked = jobId + '/' + state; target = receivedTarget; return { ...job, state }; }
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/job-state?id=${job.id}&state=COMPLETED&repo=${encodeURIComponent(job.repository)}&pr=${job.prNumber}`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(invoked, `${job.id}/COMPLETED`);
  assert.deepEqual(target, { repository: job.repository, prNumber: job.prNumber });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('dashboard task state override invokes the supplied runtime handler', async () => {
  const task = { id: 'manual-task', jobId: 'task-state-job', parentTaskId: null, dependencies: [], capabilities: [], adapter: 'codex', input: 'work', output: { kind: 'task_pr' }, state: 'FAILED', attempt: 1, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, error: 'failed', timeoutMs: 1000, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), continuation: null, continuationDeliveredAt: null };
  const job = { id: 'task-state-job', title: 'Task state', executionMode: 'fixed', prNumber: 1, repository: 'owner/repo', state: 'ACTIVE', continuation: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: [task] };
  let invoked = '';
  let target;
  const server = managedDashboard(new InMemoryStore(job), 0, undefined, 300000, job.id, undefined, undefined, undefined, undefined, undefined, {
    taskSetState: async (jobId, taskId, state, receivedTarget) => { invoked = jobId + '/' + taskId + '/' + state; target = receivedTarget; return job; }
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/task-state?id=${job.id}&task=${task.id}&state=SUCCEEDED&repo=${encodeURIComponent(job.repository)}&pr=${job.prNumber}`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(invoked, `${job.id}/${task.id}/SUCCEEDED`);
  assert.deepEqual(target, { repository: job.repository, prNumber: job.prNumber });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('dashboard renders job clipboard, publication, merge-review, and commit-link contracts', () => {
  assert.match(dashboardHtml, /navigator\.clipboard\.writeText\(repoName\(job\.repository\)\+'\/pr#'\+job\.prNumber\)/);
  assert.match(dashboardHtml, /job\.githubState==='MERGED'&&job\.publication\?\.version/);
  assert.match(dashboardHtml, /text\('v'\+job\.publication\.version\)/);
  assert.doesNotMatch(dashboardHtml, /PUBLISHED v/);
  assert.match(dashboardHtml, /job\.reviewEnabled!==false&&job\.githubState!=='MERGED'/);
  assert.match(dashboardHtml, /function safeCommitUrl\(repository,sha\)/);
  assert.match(dashboardHtml, /link\.textContent=sha\.slice\(0,7\)/);
  assert.match(dashboardHtml, /commitField\('HEAD commit',job,task\.reviewHeadSha\)/);
});

test('dashboard task actions invoke the supplied runtime handler', async () => {
  const task = { id: 'failed-task', jobId: 'task-action-job', parentTaskId: null, dependencies: [], capabilities: [], adapter: 'codex', input: 'work', output: { kind: 'task_pr' }, state: 'FAILED', attempt: 1, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, error: 'failed', timeoutMs: 1000, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), continuation: null, continuationDeliveredAt: null };
  const job = { id: 'task-action-job', title: 'Task actions', executionMode: 'fixed', prNumber: 1, repository: 'owner/repo', state: 'ACTIVE', continuation: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: [task] };
  let invoked = '';
  const server = managedDashboard(new InMemoryStore(job), 0, undefined, 300000, job.id, undefined, undefined, undefined, undefined, undefined, {
    taskRetry: async (jobId, taskId) => { invoked = jobId + '/' + taskId; return job; }
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/task-action?id=${job.id}&task=${task.id}&action=retry`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(invoked, `${job.id}/${task.id}`);
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('dashboard task controls preserve durable task ids with spaces and brackets', async () => {
  const task = { id: '[2026-09-29 17]', jobId: 'task-control-job', parentTaskId: null, dependencies: [], capabilities: [], adapter: 'codex', input: 'work', output: { kind: 'task_pr' }, state: 'FAILED', attempt: 1, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, error: 'failed', timeoutMs: 1000, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), continuation: null, continuationDeliveredAt: null };
  const job = { id: 'task-control-job', title: 'Task controls', executionMode: 'fixed', prNumber: 1, repository: 'owner/repo', state: 'ACTIVE', continuation: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: [task] };
  const invocations = [];
  const server = managedDashboard(new InMemoryStore(job), 0, undefined, 300000, job.id, undefined, undefined, undefined, undefined, undefined, {
    taskRetry: async (jobId, taskId) => { invocations.push(['retry', jobId, taskId]); return job; },
    taskSetState: async (jobId, taskId, state) => { invocations.push(['state', jobId, taskId, state]); return job; }
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const commandResponse = await fetch(`http://127.0.0.1:${address.port}/api/task-command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: job.id, taskId: task.id, action: 'retry' })
  });
  assert.equal(commandResponse.status, 200);

  const actionResponse = await fetch(`http://127.0.0.1:${address.port}/api/task-action?id=${job.id}&task=${encodeURIComponent(task.id)}&action=retry`, { method: 'POST' });
  assert.equal(actionResponse.status, 200);

  const stateResponse = await fetch(`http://127.0.0.1:${address.port}/api/task-state?id=${job.id}&task=${encodeURIComponent(task.id)}&state=QUEUED`, { method: 'POST' });
  assert.equal(stateResponse.status, 200);

  assert.deepEqual(invocations, [
    ['retry', job.id, task.id],
    ['retry', job.id, task.id],
    ['state', job.id, task.id, 'QUEUED']
  ]);
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
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

test('job list uses repo-prefixed PR title and keeps time on the final line', () => {
  assert.match(dashboardHtml, /function repoName\(repository\)/);
  assert.match(dashboardHtml, /text\(repoName\(job\.repository\)\+'\/PR#'\+value\(job\.prNumber\)\+': '\+value\(job\.title\|\|job\.id\)\)/);
  assert.match(dashboardHtml, /'badge '\+value\(job\.state\)/);
  assert.match(dashboardHtml, /element\('div','job-last-line'\)/);
  assert.match(dashboardHtml, /lastLine\.append\(element\('span','subtle',text\(compactCounts\(counts\(job\.tasks\)\)\)\),element\('span','subtle',text\(relativeTime\(job\.updatedAt\)\)\)\)/);
  assert.doesNotMatch(dashboardHtml, /text\(job\.repository\|\|'unknown repo'\)/);
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
  assert.doesNotMatch(dashboardHtml, /function inlineMarkdown\(/);
  assert.match(dashboardHtml, /function taskCommentField\(task\)/);
  assert.match(dashboardHtml, /Open task comment/);
  assert.match(dashboardHtml, /function agentGraphField\(task\)/);
  assert.match(dashboardHtml, /Task agent graph/);
});


test('selected job body does not scroll and omits task count field', () => {
  assert.match(dashboardHtml, /#jobs-workspace > \.panel:first-child \.panel-body \{ overflow:visible; max-height:none; \}/);
  assert.doesNotMatch(dashboardHtml, /field\('Tasks',String\(\(job\.tasks\|\|\[\]\)\.length\)\)/);
  assert.match(dashboardHtml, /field\('Task states'/);
});


test('job list keeps repository quick filter without a separate repository metadata line', () => {
  assert.match(dashboardHtml, /id="repo-filter"/);
  assert.doesNotMatch(dashboardHtml, /id="status-filter"/);
  assert.match(dashboardHtml, /All repos/);
  assert.doesNotMatch(dashboardHtml, /All statuses/);
  assert.match(dashboardHtml, /repoName\(job\.repository\)/);
  assert.doesNotMatch(dashboardHtml, /text\(job\.repository\|\|'unknown repo'\)/);
  assert.match(dashboardHtml, /function filteredJobs\(\)/);
  assert.match(dashboardHtml, /sessionStorage\.setItem\('agents-relay:repo-filter'/);
  assert.doesNotMatch(dashboardHtml, /agents-relay:status-filter/);
  assert.doesNotMatch(dashboardHtml, /id="job-count"/);
});



test('job list quick filters let autonomous and draft toggle back off', () => {
  assert.doesNotMatch(dashboardHtml, /id="quick-jobs"/);
  assert.match(dashboardHtml, /id="quick-status"/);
  assert.match(dashboardHtml, /id="quick-autonomous"/);
  assert.match(dashboardHtml, /id="quick-draft"/);
  assert.match(dashboardHtml, /function setQuickMode\(mode,status=''\)/);
  assert.match(dashboardHtml, /function toggleQuickMode\(mode\)/);
  assert.match(dashboardHtml, /quickMode==='autonomous'/);
  assert.match(dashboardHtml, /quickMode==='draft'/);
  assert.match(dashboardHtml, /quickMode==='status'/);
  assert.match(dashboardHtml, /\(job\.runtimeStatus\|\|'IDLE'\)===selectedRuntimeStatus/);
  assert.doesNotMatch(dashboardHtml, /quickJobs/);
  assert.match(dashboardHtml, /quickAutonomous\.setAttribute\('aria-pressed',String\(quickMode==='autonomous'\)\)/);
  assert.match(dashboardHtml, /quickDraft\.setAttribute\('aria-pressed',String\(quickMode==='draft'\)\)/);
  assert.match(dashboardHtml, /quickStatus\.addEventListener\('change',\(\)=>setQuickMode\(quickStatus\.value\?'status':'jobs',quickStatus\.value\)\)/);
  assert.match(dashboardHtml, /toggleQuickMode\('autonomous'\)/);
  assert.match(dashboardHtml, /toggleQuickMode\('draft'\)/);
});

test('job list supports title and PR-number wildcard search', () => {
  assert.match(dashboardHtml, /id="job-search"/);
  assert.match(dashboardHtml, /Search title or PR #/);
  assert.match(dashboardHtml, /function matchesSearch\(job\)/);
  assert.match(dashboardHtml, /agents-relay:job-search/);
});

test('dashboard periodic snapshots stay cache-only until an explicit refresh', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/dashboard.ts', import.meta.url), 'utf8'));
  assert.match(source, /forceRefresh && requestedJobId && resolvedExactJobProvider/);
  assert.match(source, /snapshot\(requestedJobId, true, \{ repository, prNumber \}\)/);
  assert.match(source, /if \(clients\.size === 0\) return;/);
});

test('dashboard SSE sends short keepalive comments independent of durable snapshots', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/dashboard.ts', import.meta.url), 'utf8'));
  assert.match(source, /const SSE_HEARTBEAT_MS = 15000/);
  assert.match(source, /client\.write\(': heartbeat\\n\\n'\)/);
  assert.match(source, /clearInterval\(heartbeat\)/);
});

test('dashboard webhook accepts only self-contained facts and does not refresh GitHub', async () => {
  const job = { id: 'webhook-job', title: 'Webhook state', executionMode: 'fixed', prNumber: 50, repository: 'owner/repo', state: 'ACTIVE', continuation: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: [] };
  let wakes=0;
  const server = managedDashboard(new InMemoryStore(job), 0, undefined, 300000, job.id, undefined, undefined, {
    secret: 'test-secret',
    repositories: new Set(['owner/repo']),
    wake: async event => { wakes+=1; assert.equal(event.pullRequestFacts?.head?.sha,'new-sha'); }
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const body = Buffer.from(JSON.stringify({ action: 'synchronize', repository: { full_name: 'owner/repo' }, pull_request: { number: 50, head: { ref: 'feat/test', sha: 'new-sha' } } }));
  const signature = 'sha256=' + createHmac('sha256', 'test-secret').update(body).digest('hex');
  const webhook = await fetch(`${base}/webhooks/github`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-delivery': 'delivery-1', 'x-github-event': 'pull_request', 'x-hub-signature-256': signature }, body });
  assert.equal(webhook.status, 202);
  for(let i=0;i<20&&wakes===0;i+=1) await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(wakes,1);

  const edited = Buffer.from(JSON.stringify({ action: 'edited', repository: { full_name: 'owner/repo' }, pull_request: { number: 50, head: { ref: 'feat/test', sha: 'newer-sha' } } }));
  const editedSignature = 'sha256=' + createHmac('sha256', 'test-secret').update(edited).digest('hex');
  const ignored = await fetch(`${base}/webhooks/github`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-delivery': 'delivery-2', 'x-github-event': 'pull_request', 'x-hub-signature-256': editedSignature }, body: edited });
  assert.equal(ignored.status,202);
  assert.equal(await ignored.text(),'Ignored');
  assert.equal(wakes,1);
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('dashboard warns when GitHub API is rate limited', () => {
  assert.match(dashboardHtml, /id="rate-limit-warning"/);
  assert.match(dashboardHtml, /GitHub API rate limit reached\. Showing cached job data\./);
  assert.match(dashboardHtml, /loadJSON\('\/api\/status'\)/);
  assert.match(dashboardHtml, /function renderRateLimitStatus\(status\)/);
});

test('dashboard shows the current package version at the top right', () => {
  assert.match(dashboardHtml, /class="version">v\d+\.\d+\.\d+<\/span>/);
  assert.match(dashboardHtml, /\.version \{ margin-left:auto;/);
});


test('completed but unmerged jobs are pinned and highlighted for merge follow-up', () => {
  assert.match(dashboardHtml, /function isCompleteUnmerged\(job\)/);
  assert.match(dashboardHtml, /MERGE PENDING/);
  assert.match(dashboardHtml, /complete-unmerged/);
  assert.match(dashboardHtml, /mergePendingDelta/);
  assert.match(dashboardHtml, /job\.runtimeStatus==='MERGE_PENDING'/);
});
test('dashboard exposes reviewer approval, changes-required, stale, and merge-ready states', () => {
  assert.match(dashboardHtml, /MERGE READY · approved/);
  assert.match(dashboardHtml, /STALE · awaiting review/);
  assert.match(dashboardHtml, /Review changes required/);
  assert.match(dashboardHtml, /Review head SHA/);
});


test('dashboard exposes one free-text Execution Router rules editor', () => {
  assert.match(dashboardHtml, /id="rules-tab"[^>]*>Router Rules</);
  assert.match(dashboardHtml, /id="rules-text"[^>]*class="rules-textarea"/);
  assert.match(dashboardHtml, /Execution Router rules with an explicit <code>\[choices\]<\/code> section/);
  assert.match(dashboardHtml, /fetch\('\/api\/execution-router-rules'/);
  assert.match(dashboardHtml, /method:'PUT'/);
  assert.match(dashboardHtml, /New routing decisions will load these rules/);
  assert.doesNotMatch(dashboardHtml, /worker-rules-tab|model-router-rules|worker-router-rules/);
});

test('dashboard header exposes in-memory runtime summary', () => {
  assert.match(dashboardHtml, /id="runtime-summary"[^>]*aria-label="Runtime summary"/);
  assert.match(dashboardHtml, /api\/runtime-summary/);
  assert.match(dashboardHtml, /runtimePill\('ChatGPT'/);
  assert.match(dashboardHtml, /runtimePill\('Codex'/);
});


test('dashboard Usage renders only the lowest available GitHub quota', () => {
  assert.match(dashboardHtml, /GitHub API/);
  assert.match(dashboardHtml, /githubBucket\('Available',effective\)/);
  assert.match(dashboardHtml, /overview\.githubEffective/);
  assert.match(dashboardHtml, /bucket\.remaining\+' \/ '\+bucket\.limit/);
  assert.doesNotMatch(dashboardHtml, /Secondary cooldown|Secondary protection|Request-time X-RateLimit headers|Primary quota \(\/rate_limit\)|Cooldown active|Throttled ·/);
});


test('dashboard Usage folds GitHub diagnostics behind details', () => {
  assert.match(dashboardHtml, /element\('details','usage-details'\)/);
  assert.match(dashboardHtml, /text\('Diagnostics'\)/);
  assert.match(dashboardHtml, /Calls · GraphQL/);
  assert.match(dashboardHtml, /Reads · scans/);
});

test('dashboard keeps GitHub API card visible when only githubStatus is available', () => {
  assert.match(dashboardHtml, /if\(overview\.githubEffective\|\|overview\.githubStatus\)grid\.append\(githubUsageCard/);
  assert.match(dashboardHtml, /Quota unavailable/);
});

test('dashboard usage remains available when GitHub quota telemetry fails', async () => {
  const usageRegistry={snapshot:async()=>({providers:[],credits:[]})};
  const server=managedDashboard(new InMemoryStore(),0,undefined,300000,undefined,usageRegistry,undefined,undefined,()=>({limited:true,cooldownUntil:'2026-09-27T15:00:00.000Z'}),async()=>{throw new Error('GitHub cooldown');});
  await once(server,'listening');
  const address=server.address();
  const response=await fetch(`http://127.0.0.1:${address.port}/api/usage`);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.githubEffective,null);
  assert.equal(body.githubStatus.limited,true);
});

test('dashboard usage API includes runtime-observed availability separately', async () => {
  const usageRegistry={snapshot:async()=>({providers:[],credits:[]})};
  const github={resources:{graphql:{limit:5000,used:2,remaining:4998,reset:1893456000}}};
  const githubStatus={
    limited:false,
    cooldownUntil:null,
    runtimeRateUsage:{
      resources:{graphql:{resource:'graphql',observedAt:'2026-09-29T00:00:00.000Z',status:429,available:false,throttled:true,limit:null,used:null,remaining:null,reset:null,resetAt:null,retryAfterSeconds:30,reason:'graphql_rate_limit',headersCaptured:false}},
      rejection:{resource:'graphql',kind:'secondary',observedAt:'2026-09-29T00:00:00.000Z',status:429,retryAfterSeconds:30,cooldownUntil:'2026-09-29T00:00:30.000Z',reason:'graphql_rate_limit'},
    },
  };
  const server=managedDashboard(new InMemoryStore(),0,undefined,300000,undefined,usageRegistry,undefined,undefined,()=>githubStatus,async()=>github,async()=>null);
  await once(server,'listening');
  const address=server.address();
  const response=await fetch('http://127.0.0.1:'+address.port+'/api/usage');
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(body.githubEffective.remaining,4998);
  assert.equal(body.githubStatus.runtimeRateUsage.rejection.kind,'secondary');
  assert.equal(body.githubStatus.runtimeRateUsage.resources.graphql.throttled,true);
  server.close();
});


test('dashboard usage API selects the lowest remaining GitHub percentage across snapshot and runtime headers', async () => {
  const usageRegistry={snapshot:async()=>({providers:[],credits:[]})};
  const github={observedAt:'2026-09-30T00:00:00.000Z',resources:{core:{limit:5000,used:500,remaining:4500,reset:1893456000},graphql:{limit:5000,used:1000,remaining:4000,reset:1893456100}}};
  const githubStatus={limited:false,cooldownUntil:null,runtimeRateUsage:{resources:{graphql:{resource:'graphql',observedAt:'2026-09-30T00:00:00.000Z',status:200,available:true,throttled:false,limit:5000,used:4500,remaining:500,reset:1893456200,resetAt:null,retryAfterSeconds:null,reason:null,headersCaptured:true}},rejection:null}};
  const server=managedDashboard(new InMemoryStore(),0,undefined,300000,undefined,usageRegistry,undefined,undefined,()=>githubStatus,async()=>github,async()=>null);
  await once(server,'listening');
  const address=server.address();
  const response=await fetch('http://127.0.0.1:'+address.port+'/api/usage');
  const body=await response.json();
  assert.deepEqual(body.githubEffective,{limit:5000,remaining:500,reset:1893456200});
  server.close();
});

test('dashboard GitHub usage shows GraphQL operation and context attribution', async () => {
  assert.match(dashboardHtml, /GraphQL operations/);
  assert.match(dashboardHtml, /GraphQL contexts/);
  assert.match(dashboardHtml, /status\?\.graphql\?\.operations/);
  assert.match(dashboardHtml, /status\?\.graphql\?\.contexts/);
});

test('dashboard GitHub usage shows per-trigger refresh attribution and coalescing', () => {
  assert.match(dashboardHtml, /Refresh triggers/);
  assert.match(dashboardHtml, /Coalesced/);
  assert.match(dashboardHtml, /prRefreshesByTrigger/);
  assert.match(dashboardHtml, /prRefreshCoalescedByTrigger/);
});

test('Router Rules tab exposes current router test and latest audit log', () => {
  assert.match(dashboardHtml, /id="rules-test"[^>]*>Test Router<\/button>/);
  assert.match(dashboardHtml, /id="audit-log"/);
  assert.match(dashboardHtml, /Rules Editor/);
  assert.match(dashboardHtml, /Audit Log/);
  assert.match(dashboardHtml, /fetch\('\/api\/router-test'/);
  assert.match(dashboardHtml, /loadJSON\('\/api\/decision-audit'/);
  assert.match(dashboardHtml, /laya_input/);
  assert.match(dashboardHtml, /hard_gates/);
  assert.match(dashboardHtml, /effective_choices/);
  assert.match(dashboardHtml, /routing_instruction/);
  assert.match(dashboardHtml, /\[choices\]/);
  assert.match(dashboardHtml, /\[routing-instruction\]/);
  assert.match(dashboardHtml, /Select a Job and Task first/);
  assert.match(dashboardHtml, /const routeSelection=result\.selected\|\|\{\}/);
  assert.doesNotMatch(dashboardHtml, /const selected=result\.selected/);
  assert.match(dashboardHtml, /\.router-rules-pane\{min-width:0;max-width:100%;overflow:hidden\}/);
  assert.match(dashboardHtml, /\.audit-log\{[^}]*overflow:auto;min-width:0\}/);
});


test('dashboard applies live authoritative job and task state from SSE without polling', () => {
  assert.match(dashboardHtml, /stream.addEventListener\('relay',message=>\{const payload=parseMessage\(message\);if\(payload\?\.job\)/);
  assert.doesNotMatch(dashboardHtml, /scheduleLifecycleRefresh|streamHasOpened/);
  assert.doesNotMatch(dashboardHtml, /setInterval\(\(\)=>\{if\(location.hash!==/);
});


test('SSE resolves each event against its own repository and PR durable store', () => {
  assert.match(dashboardHtml, /stream.addEventListener\('relay'/);
  const serverSource = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');
  assert.match(serverSource, /subscribeLocalCommits\(durable =>/);
});


test('SSE lifecycle snapshot carries the computed runtime status instead of defaulting to IDLE', () => {
  const source = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');
  assert.match(source, /runtimeStatus: deriveJobRuntimeStatus\(durable, githubState\)/);
  assert.match(source, /JSON.stringify\(\{ job: current \}\)/);
});

test('dashboard SSE streams committed local state immediately without a worker event or GitHub refresh', async () => {
  const { publishLocalCommit } = await import('../dist/local-commit-events.js');
  const job = { id: 'committed-sse', title: 'Committed SSE', executionMode: 'autonomous', repository: 'owner/repo', prNumber: 91, state: 'ACTIVE', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: [] };
  const server = managedDashboard(new InMemoryStore(job), 0, undefined, 300000, job.id);
  await once(server, 'listening');
  const addr = server.address();
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${addr.port}/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    await reader.read(); // : connected
    const task = { id: 'review', jobId: job.id, kind: 'work', agentName: 'reviewer', state: 'RUNNING' };
    publishLocalCommit({ ...job, tasks: [task] });
    const received = new TextDecoder().decode((await reader.read()).value);
    assert.match(received, /"job":\{/);
    assert.match(received, /"runtimeStatus":"REVIEWING"/);
    assert.match(received, /"state":"RUNNING"/);
    assert.match(received, /"id":"review"/);
  } finally {
    controller.abort();
    await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
  }
});


test('dashboard lifecycle status has no timer-driven snapshot fallback', () => {
  const source = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Math.max\(10000, refreshMs\)/);
  assert.match(source, /subscribeLocalCommits\(durable =>/);
});
