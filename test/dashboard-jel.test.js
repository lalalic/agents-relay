import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { jobJelDiagram } from '../dist/dashboard-jel.js';

const at = (hour, minute=0, second=0) =>
  `2026-11-10T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:${String(second).padStart(2,'0')}Z`;

test('JEL shows compact stage labels and retains review-driven round transitions', () => {
  const diagram=jobJelDiagram({state:'ACTIVE',reviewEnabled:true,
    createdAt:at(8), updatedAt:at(15),
    plans:[
      {id:'p1',round:1,status:'SUCCEEDED',createdAt:at(8),updatedAt:at(9),generatedTaskIds:['a']},
      {id:'p2',round:2,status:'SUCCEEDED',createdAt:at(12),updatedAt:at(13),generatedTaskIds:['b'],trigger:{source:'review'}},
    ],
    tasks:[{id:'a',title:'First',state:'SUCCEEDED',planningDecisionId:'p1',createdAt:at(9),updatedAt:at(11)},
      {id:'b',title:'Second',state:'SUCCEEDED',planningDecisionId:'p2',createdAt:at(13),updatedAt:at(14)}],
  });
  assert.match(diagram,/created\["Create \(0s\)"\]/);
  assert.match(diagram,/plan_1\["Plan 1 \(1h00m\)"\]/);
  assert.match(diagram,/execute_1\["Execute 1 \(2h00m\)"\]/);
  assert.match(diagram,/task_0\["First \(2h00m\)"\]/);
  assert.match(diagram,/task_1\["Second \(1h00m\)"\]/);
  assert.match(diagram,/review_1 -->\|changes required\| plan_2/);
  assert.match(diagram,/merge\["Merge \(—\)"\]/);
  assert.doesNotMatch(diagram,/elapsed | SUCCEEDED| CHANGES REQUIRED| tasks \/|queue |last run |attempt 2/);
});

test('JEL uses task.title first then agent name then task id, preserving Chinese', () => {
  const chart=jobJelDiagram({state:'COMPLETED',createdAt:at(8),updatedAt:at(15),tasks:[
    {id:'101',title:'影片剪辑',agentName:'editor',state:'SUCCEEDED',createdAt:at(9),updatedAt:at(10),attempt:1,
      executionHistory:[{attempt:1,startedAt:at(9,59,30)}]},
    {id:'102',agentName:'visioner',state:'SUCCEEDED',createdAt:at(9),updatedAt:at(10)},
    {id:'103',state:'SUCCEEDED',createdAt:at(9),updatedAt:at(10)},
    {id:'104',title:'Coordinator',agentName:'dag-coordinator',state:'SUCCEEDED',createdAt:at(9),updatedAt:at(13),
      attempt:1,executionHistory:[{attempt:1,startedAt:at(9)}]},
  ]});
  assert.match(chart,/task_0\["影片剪辑 \(30s\)"\]/);
  assert.match(chart,/task_1\["visioner \(1h00m\)"\]/);
  assert.match(chart,/task_2\["103 \(1h00m\)"\]/);
  assert.match(chart,/task_3\["Coordinator \(4h00m\)"\]/);
  assert.doesNotMatch(chart,/Task 101|job-acceptance-reviewer \/|DAG vision/);
});

test('JEL duration prefers last attempt start; falls back to wall time, or unknown', () => {
  const chart=jobJelDiagram({state:'COMPLETED',tasks:[
    {id:'1',title:'Editor',state:'SUCCEEDED',createdAt:at(9),updatedAt:at(10),attempt:2,
      executionHistory:[{attempt:1,startedAt:at(9,1)},{attempt:2,startedAt:at(9,59,59)}]},
    {id:'2',title:'No start',state:'SUCCEEDED',createdAt:at(9),updatedAt:at(10)},
    {id:'3',title:'No timestamps',state:'SUCCEEDED'},
  ]});
  assert.match(chart,/task_0\["Editor \(1s\)"\]/);
  assert.match(chart,/task_1\["No start \(1h00m\)"\]/);
  assert.match(chart,/task_2\["No timestamps \(—\)"\]/);
  assert.match(chart,/retry_1_0\["Retry \(1s\)"\]/);
  assert.match(chart,/Final Review 1 \(—\)/);
});

test('JEL retains DAG parent/dependency links, failed retry and Troubleshooter diagnostics', () => {
  const chart=jobJelDiagram({state:'COMPLETED',plans:[{id:'p',round:1,status:'SUCCEEDED',createdAt:at(8),generatedTaskIds:['100']}],tasks:[
    {id:'100',title:'Coordinator',agentName:'dag-coordinator',state:'SUCCEEDED',planningDecisionId:'p',createdAt:at(9),updatedAt:at(14)},
    {id:'101',title:'Visioner',state:'SUCCEEDED',dagNode:{nodeId:'vision'},parentTaskId:'100',createdAt:at(9),updatedAt:at(12),attempt:2,
      executionHistory:[{attempt:1,startedAt:at(9)},{attempt:2,startedAt:at(11)}]},
    {id:'102',title:'Editor',state:'FAILED',parentTaskId:'100',dependencies:['101'],createdAt:at(12),updatedAt:at(13),attempt:1},
    {id:'103',title:'Troubleshooter',agentName:'troubleshooter',state:'SUCCEEDED',parentTaskId:'102',recoveryForAttempt:1,createdAt:at(13),updatedAt:at(14)},
    {id:'104',title:'Final Review',agentName:'job-acceptance-reviewer',state:'SUCCEEDED',createdAt:at(14),updatedAt:at(15)},
  ]});
  assert.match(chart,/task_0 -->\|DAG child\| task_1/);
  assert.match(chart,/task_1 -->\|depends\| task_2/);
  assert.match(chart,/task_2\["Editor \(1h00m\)"\]/);
  assert.match(chart,/retry_1_0\["Retry \(1h00m\)"\]/);
  assert.match(chart,/failed_1_0\["Failed \(1h00m\)"\]/);
  assert.match(chart,/troubleshooter_1_0\["Troubleshooter \(1h00m\)"\]/);
  assert.match(chart,/task_4\["Final Review \(1h00m\)"\]/);
  assert.match(chart,/review_1 -.-> task_4/);
  for(const pair of [['task_1','retry_1_0'],['task_2','failed_1_0'],['task_2','troubleshooter_1_0']])
    assert.ok(chart.includes(`${pair[0]} -.-> ${pair[1]}`));
  for(const [node,kind] of [['task_2','jelFailed'],['retry_1_0','jelRetry'],['troubleshooter_1_0','jelTroubleshooter'],['task_4','jelReviewer']])
    assert.ok(chart.includes(`class ${node} ${kind}`));
});

test('JEL never emits executable Mermaid syntax from Task titles, IDs or status', () => {
  const chart=jobJelDiagram({state:'ACTIVE\nclick finished href',tasks:[
    {id:'evil"; click injected http://host; %%',title:'恶意<svg>\nclick target https://bad.test',state:'FAILED',attempt:2},
    {id:'ts',agentName:'troubleshooter',state:'SUCCEEDED',parentTaskId:'evil"; click injected http://host; %%',recoveryForAttempt:1},
  ]});
  assert.doesNotMatch(chart,/\n\s*click\s|https?:\/\/|<svg>|"; click/);
  assert.match(chart,/恶意svg/);
  assert.match(chart,/class failed_1_0 jelFailed/);
  assert.match(chart,/class retry_1_0 jelRetry/);
});

test('Dashboard JEL modal has only title, zoom/fit/close and graph (no screenshot controls)', async () => {
  const {dashboardHtml}=await import('../dist/dashboard-html.js');
  const {dashboardStyles}=await import('../dist/dashboard-style.js');
  for(const id of ['graph-dialog-title','graph-zoom-in','graph-zoom-out','graph-zoom-reset','graph-dialog-close','graph-dialog-viewport','jel-chart'])
    assert.match(dashboardHtml,new RegExp(`id="${id}"`));
  for(const id of ['graph-jel-meta','jel-overview','jel-search','jel-filter','jel-find-results','jel-status'])
    assert.doesNotMatch(dashboardHtml,new RegExp(`id="${id}"`));
  assert.doesNotMatch(dashboardHtml,/Agent Σ last attempt|Slowest first|Find Task \/ Agent|function renderJelOverview|function renderJelResults|buildJelHotspots/);
  assert.doesNotMatch(dashboardStyles,/\.jel-overview|\.jel-find|\.jel-legend|\.graph-jel-meta/);
  assert.match(dashboardHtml,/function showGraphViewer\(content,title\)/);
  assert.match(dashboardHtml,/showGraphViewer\(jelChart,'JEL · '/);
  assert.match(dashboardHtml,/applyGraphPalette\(svg\);\s*applyJelHighlights\(svg\);/);
  assert.match(dashboardHtml,/node\.addEventListener\('click',\(\)=>inspectJelTask\(task\.id\)\)/);
  assert.match(dashboardHtml,/function fitGraphViewer\(\)/);
  assert.match(dashboardHtml,/graphViewport\.replaceChildren\(content\)/);
  assert.match(dashboardHtml,/graphViewerHome\.insertBefore\(content,next\)/);
  assert.match(dashboardHtml,/if\(content===jelChart\)jelRenderSequence\+\+/);
});


test('JEL preserves trailing duration when a Task title is long', () => {
  const longTitle='这是一个很长的任务标题'.repeat(20);
  const diagram=jobJelDiagram({state:'COMPLETED',tasks:[{id:'long',title:longTitle,state:'SUCCEEDED',
    createdAt:at(9),updatedAt:at(9,0,4)}]});
  const line=diagram.split('\n').find(line=>line.includes('task_0["'));
  assert.match(line,/task_0\["这是一个很长的任务标题.+ \(4s\)"\]/);
  assert.ok(line.length < 140);
});
