import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { completionGateSatisfied } from '../dist/task-transitions.js';
import { requiresLocalGitMerge } from '../dist/local-git-merge.js';
const work={id:'implementation',kind:'work',agentName:'implementation',state:'SUCCEEDED'};
const reviewer={id:'previous-review',kind:'work',agentName:'reviewer',state:'SUCCEEDED'};
const job=(status,nextTasks=[],tasks=[work])=>({tasks,plans:[{id:'plan-10',round:10,status:'SUCCEEDED',objectiveStatus:status,plannerResult:{next_tasks:nextTasks}}]});
test('pre-merge delivery requires a completed Plan and successful required work, not a second satisfaction Plan',()=>{
  assert.equal(completionGateSatisfied(job('in_progress')),true);
  assert.equal(completionGateSatisfied(job('satisfied',[],[])),false,'satisfied Plan without real implementation is not completion evidence');
  assert.equal(completionGateSatisfied(job('satisfied',[],[reviewer])),false,'Reviewer-only history is not implementation evidence');
  assert.equal(completionGateSatisfied(job('satisfied',[],[{id:'plan-10',kind:'planner',state:'SUCCEEDED'}])),false,'Planner-only success is not implementation evidence');
  assert.equal(completionGateSatisfied(job('satisfied',[],[work,reviewer])),true);
  assert.equal(completionGateSatisfied(job('in_progress',[{id:'more-work'}],[work,reviewer])),true);
  assert.equal(completionGateSatisfied(job('in_progress',[],[{...work,state:'RUNNING'},reviewer])),false);
});
test('new failed plan does not reuse historical review readiness',()=>{
  const j=job('in_progress',[],[work,reviewer]);j.plans.push({id:'plan-11',round:11,status:'FAILED',objectiveStatus:'in_progress'});
  assert.equal(completionGateSatisfied(j),false);
});

test('legacy in-progress Planner Task delegates completion to Final Review when enabled',()=>{
  const legacy={id:'planner-1',kind:'planner',agentName:'planner',state:'SUCCEEDED',
    plannerResult:{objective_status:'in_progress',assessment:'initial batch',next_tasks:[]}};
  const reviewed={tasks:[work,legacy],plans:[],reviewEnabled:true};
  assert.equal(completionGateSatisfied(reviewed),true);
  assert.equal(completionGateSatisfied({...reviewed,reviewEnabled:false}),false);
  assert.equal(completionGateSatisfied({...reviewed,tasks:[{...work,state:'FAILED'},legacy]}),false);
});

test('plan-free Coordinator Graph completion requires successful Coordinator and all implementation nodes',()=>{
  const coordinator={id:'coordinator',kind:'work',agentName:'coordinator',state:'SUCCEEDED'};
  const graph={plans:[],reviewEnabled:false,tasks:[coordinator,work]};
  assert.equal(completionGateSatisfied(graph),true);
  assert.equal(completionGateSatisfied({...graph,tasks:[{...coordinator,state:'RUNNING'},work]}),false);
  assert.equal(completionGateSatisfied({...graph,tasks:[coordinator,{...work,state:'FAILED'}]}),false);
  assert.equal(completionGateSatisfied({...graph,tasks:[work]}),false);
  assert.equal(completionGateSatisfied({...graph,plans:[{round:1,status:'FAILED'}]}),false);
  assert.equal(completionGateSatisfied({...graph,tasks:[coordinator,work,{id:'recovery',kind:'work',agentName:'troubleshooter',state:'CANCELLED'}]}),true);
});

test('cancelled recovery task_pr does not force Git merge for a file-only Coordinator Graph',()=>{
  const coordinator={id:'coordinator',kind:'work',agentName:'coordinator',state:'SUCCEEDED',output:{kind:'file',path:'/tmp/result.json'}};
  const graph={plans:[],reviewEnabled:false,tasks:[coordinator,{...work,output:{kind:'file',path:'/tmp/work.json'}},{id:'recovery',kind:'work',agentName:'troubleshooter',state:'CANCELLED',output:{kind:'task_pr'}}]};
  assert.equal(requiresLocalGitMerge(graph),false);
  assert.equal(requiresLocalGitMerge({...graph,localMerge:{sourceRef:'refs/heads/source',targetRef:'refs/heads/main',status:'pending'}}),true);
  assert.equal(requiresLocalGitMerge({...graph,tasks:[...graph.tasks,{...work,id:'code',output:{kind:'task_pr'}}]}),true);
});
