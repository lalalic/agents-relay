import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { selectRelatedTaskMutations } from '../dist/workflow/task-action-policy.js';

const task = (id, state='FAILED', extra={}) => ({
  id, state, parentTaskId:null, dependencies:[], capabilities:[], adapter:'codex', input:'x', output:{kind:'task_pr'},
  attempt:1, maxAttempts:3, leaseOwner:null, leaseExpiresAt:null, executionId:null, threadId:null,
  result:null, error:null, timeoutMs:0, createdAt:'', updatedAt:'', ...extra,
});
const job = tasks => ({ id:'j', title:'j', priority:'P1', executionMode:'fixed', autoMerge:false, reviewEnabled:false,
  repository:'o/r', prNumber:1, state:'ACTIVE', objective:'x', tasks, plans:[], createdAt:'', updatedAt:'' });

test('manual retry policy selects only active troubleshooter recoveries for the retried task', () => {
  const root=task('root');
  const child=task('troubleshoot-root-a0','RUNNING',{agentName:'troubleshooter',parentTaskId:'root'});
  const legacy=task('troubleshoot-root-a1','QUEUED',{agentName:'troubleshooter'});
  const done=task('troubleshoot-root-a2','SUCCEEDED',{agentName:'troubleshooter',parentTaskId:'root'});
  const other=task('troubleshoot-other-a0','RUNNING',{agentName:'troubleshooter',parentTaskId:'other'});
  assert.deepEqual(selectRelatedTaskMutations(job([root,child,legacy,done,other]),root,'task.retry'), [
    {taskId:'troubleshoot-root-a0',mutation:'cancel',reason:'Superseded by manual retry of root'},
    {taskId:'troubleshoot-root-a1',mutation:'cancel',reason:'Superseded by manual retry of root'},
  ]);
});

test('non-retry task actions do not select related mutations', () => {
  const root=task('root');
  const recovery=task('troubleshoot-root-a0','RUNNING',{agentName:'troubleshooter',parentTaskId:'root'});
  assert.deepEqual(selectRelatedTaskMutations(job([root,recovery]),root,'task.cancel'), []);
});
