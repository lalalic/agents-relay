import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { jobJelDiagram } from '../dist/dashboard-jel.js';

test('JEL chart renders persisted plan rounds, task counts and review-driven repair loop', () => {
  const diagram = jobJelDiagram({
    state:'ACTIVE', reviewEnabled:true,
    plans:[
      { id:'p1', round:1, status:'SUCCEEDED', generatedTaskIds:['a'], trigger:{source:'initial'} },
      { id:'p2', round:2, status:'SUCCEEDED', generatedTaskIds:['b'], trigger:{source:'review'} },
    ],
    tasks:[
      {id:'a',state:'FAILED',planningDecisionId:'p1'},
      {id:'b',state:'SUCCEEDED',planningDecisionId:'p2'},
      {id:'r1',state:'SUCCEEDED',agentName:'job-acceptance-reviewer'},
    ],
    review:{outcome:'pending'},
  });
  assert.match(diagram,/Plan 1 \/ SUCCEEDED/);
  assert.match(diagram,/Plan 2 \/ SUCCEEDED/);
  assert.match(diagram,/Execute 1 \/ 1 tasks \/ 0 succeeded \/ 1 failed/);
  assert.match(diagram,/Execute 2 \/ 1 tasks \/ 1 succeeded \/ 0 failed/);
  assert.match(diagram,/Final Review 1 \/ CHANGES REQUIRED/);
  assert.match(diagram,/review_1 -->\|changes required\| plan_2/);
  assert.match(diagram,/Final Review 2 \/ PENDING/);
  assert.match(diagram,/Merge \/ PENDING/);
  assert.match(diagram,/Job \/ ACTIVE/);
});

test('JEL chart handles no plans, completed merge, and shortcut-mode jobs without fictitious review', () => {
  const missing=jobJelDiagram({state:'DRAFT',tasks:[]});
  assert.match(missing,/Plan 1 \/ NOT STARTED/);
  assert.match(missing,/Final Review 1 \/ NOT STARTED/);
  const complete=jobJelDiagram({state:'COMPLETED',review:{outcome:'approved'},githubState:'MERGED',plans:[{id:'p',round:1,status:'SUCCEEDED'}]});
  assert.match(complete,/Final Review 1 \/ APPROVED/);
  assert.match(complete,/Merge \/ DONE/);
  assert.match(complete,/Job \/ COMPLETED/);
  const shortcut=jobJelDiagram({state:'ACTIVE',executionMode:'shortcut',tasks:[{state:'RUNNING'}]});
  assert.match(shortcut,/Shortcut execute \/ 1 tasks/);
  assert.doesNotMatch(shortcut,/Final Review|Plan 1|Merge/);
});

test('JEL chart rejects Mermaid syntax injection from persisted status fields', () => {
  const diagram=jobJelDiagram({state:'ACTIVE\\nclick finished href',plans:[{status:'\"]; click created https://evil.test; %%',round:1}]});
  assert.doesNotMatch(diagram,/click |https:|[;"].*click/);
  assert.match(diagram,/flowchart LR/);
});

test('JEL shows wall-clock elapsed for every node from persisted timestamps', () => {
  const createdAt='2026-11-10T10:00:00Z';
  const diagram=jobJelDiagram({
    state:'COMPLETED',createdAt,updatedAt:'2026-11-10T10:50:00Z',reviewEnabled:true,
    plans:[{id:'p1',round:1,status:'SUCCEEDED',createdAt:'2026-11-10T10:02:00Z',updatedAt:'2026-11-10T10:07:30Z',generatedTaskIds:['t1']}],
    tasks:[
      {id:'t1',state:'SUCCEEDED',planningDecisionId:'p1',createdAt:'2026-11-10T10:08:00Z',updatedAt:'2026-11-10T10:25:00Z'},
      {id:'r1',agentName:'job-acceptance-reviewer',state:'SUCCEEDED',createdAt:'2026-11-10T10:27:00Z',updatedAt:'2026-11-10T10:35:00Z'},
    ],
    review:{outcome:'approved',updatedAt:'2026-11-10T10:35:00Z'},
    localMerge:{status:'succeeded',updatedAt:'2026-11-10T10:38:00Z'},
  });
  assert.match(diagram,/Create \/ recorded \/ elapsed 2m 0s/);
  assert.match(diagram,/Plan 1 \/ SUCCEEDED \/ elapsed 5m 30s/);
  assert.match(diagram,/Execute 1 \/ 1 tasks \/ 1 succeeded \/ 0 failed \/ 0 active \/ elapsed 17m 0s/);
  assert.match(diagram,/Final Review 1 \/ APPROVED \/ elapsed 8m 0s/);
  assert.match(diagram,/Merge \/ DONE \/ elapsed 3m 0s/);
  assert.match(diagram,/Job \/ COMPLETED \/ elapsed 50m 0s/);
});

test('JEL shows unknown elapsed when data is missing and a live interval for active work', () => {
  const recent=new Date(Date.now()-90000).toISOString();
  const diagram=jobJelDiagram({state:'ACTIVE',createdAt:recent,plans:[{id:'p1',round:1,status:'PLANNING',createdAt:recent}],tasks:[]});
  assert.match(diagram,/Plan 1 \/ PLANNING \/ elapsed 1m/);
  assert.match(diagram,/Execute 1 \/ 0 tasks[^"\n]*elapsed unknown/);
  assert.match(diagram,/Final Review 1 \/ NOT STARTED \/ elapsed unknown/);
  assert.match(diagram,/Merge \/ PENDING \/ elapsed unknown/);
});

test('JEL renders distinct read-only failed, retry, and troubleshooter diagnostics from durable facts', () => {
  const chart=jobJelDiagram({
    state:'ACTIVE',
    plans:[{id:'plan-1',round:1,status:'SUCCEEDED',generatedTaskIds:['task-17']}],
    tasks:[
      {id:'task-17',state:'RUNNING',agentName:'implementation',planningDecisionId:'plan-1',attempt:5,
        executionHistory:[{attempt:4,startedAt:'2026-11-10T09:00:00Z'},{attempt:5,startedAt:'2026-11-10T10:00:00Z'}]},
      {id:'troubleshoot-17',state:'SUCCEEDED',agentName:'troubleshooter',parentTaskId:'task-17',
        recoveryForAttempt:4,createdAt:'2026-11-10T09:10:00Z',updatedAt:'2026-11-10T09:19:00Z'},
    ],
  });
  assert.match(chart,/execute_1\["Execute 1 \/ 1 tasks \/ 0 succeeded \/ 0 failed \/ 1 active/);
  assert.match(chart,/retry_1_0\["Retry task-17 \/ 4 retries \/ attempt 5 \/ elapsed /);
  assert.match(chart,/failed_1_0\["Failed task-17 \/ attempt 4 \/ elapsed unknown"\]/);
  assert.match(chart,/troubleshooter_1_0\["Troubleshooter troubleshoot-17 \/ SUCCEEDED \/ elapsed 9m 0s"\]/);
  for(const kind of ['retry','failed','troubleshooter']){
    assert.ok(chart.includes('execute_1 -.-> '+kind+'_1_0'));
  }
  assert.match(chart,/class retry_1_0 jelRetry/);
  assert.match(chart,/class failed_1_0 jelFailed/);
  assert.match(chart,/class troubleshooter_1_0 jelTroubleshooter/);
  for(const color of ['#fee2e2','#ede9fe','#fef3c7'])assert.ok(chart.includes(color));
  assert.match(chart,/execute_1 --> review_1/,'main JEL lifecycle remains unchanged');
});

test('JEL highlights currently FAILED tasks without a retry or troubleshooter, without inventing diagnostics for normal tasks', () => {
  const failed=jobJelDiagram({state:'ACTIVE',plans:[{id:'p',round:1,status:'SUCCEEDED',generatedTaskIds:['t']}],
    tasks:[{id:'t',state:'FAILED',attempt:1,planningDecisionId:'p',createdAt:'2026-11-10T09:00:00Z',updatedAt:'2026-11-10T09:03:00Z'}]});
  assert.match(failed,/Failed t \/ attempt 1 \/ elapsed 3m 0s/);
  assert.doesNotMatch(failed,/retry_1_\d+\[/);
  assert.doesNotMatch(failed,/troubleshooter_1_\d+\[/);
  const healthy=jobJelDiagram({state:'ACTIVE',tasks:[{id:'t',state:'SUCCEEDED',attempt:1}]});
  assert.doesNotMatch(healthy,/(?:failed|retry|troubleshooter)_1_\d+\[/);
});

test('JEL never embeds arbitrary Task identities into Mermaid tokens or executable markup', () => {
  const graph=jobJelDiagram({state:'ACTIVE',tasks:[
    {id:'evil"; click terminal http://host; %%',state:'FAILED',attempt:2},
    {id:'trouble<script>',agentName:'troubleshooter',state:'QUEUED',parentTaskId:'evil"; click terminal http://host; %%',recoveryForAttempt:1},
  ]});
  assert.doesNotMatch(graph,/\n\s*click\s|https?:\/\/|<script>|\"; click/);
  assert.match(graph,/class failed_1_0 jelFailed/);
  assert.match(graph,/class retry_1_0 jelRetry/);
  assert.match(graph,/class troubleshooter_1_0 jelTroubleshooter/);
});

test('dashboard JEL colors are applied AFTER sanitized graph palettes, with a visible legend', async () => {
  const {dashboardHtml} = await import('../dist/dashboard-html.js');
  assert.match(dashboardHtml,/class="jel-legend"/);
  assert.match(dashboardHtml,/applyGraphPalette\(svg\);\s*applyJelHighlights\(svg\);/);
  assert.match(dashboardHtml,/node\.classList\.add\('jel-'\+kind\)/);
  assert.match(dashboardHtml,/palette=\{failed:/);
  assert.match(dashboardHtml,/shape\.setAttribute\('fill',fill\)/);
});
