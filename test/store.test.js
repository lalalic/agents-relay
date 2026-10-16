import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteRelayStore, relayUnifiedStorePath } from '../dist/relay-store.js';
import { openLocalManagedStore } from '../dist/local-managed-store.js';
import { dashboardManagedJobs, GitHubStore, InMemoryStore, listManagedGitHubJobs, loadManagedGitHubPullRequestGraphql, loadManagedGitHubPullRequestSnapshotGraphql } from '../dist/store.js';
import { AGENT_MARKER, JOB_MARKER, PLAN_MARKER, marker, parseAgent, parseJob, parsePlan, parseTask, renderJobBody, TASK_MARKER } from '../dist/markers.js';

test('rendered job/task markers do not duplicate human markdown content', async () => {
  const { renderJobBody, renderJobComment, renderTaskComment } = await import('../dist/markers.js');
  const durableJob = job('dedupe');
  durableJob.objective = '# Goal\n\nKeep this visible only.';
  durableJob.description = durableJob.objective;
  durableJob.reviewerThreadId = 'reviewer-thread';
  durableJob.creatorThreadId = 'creator-thread';
  const jobBody = renderJobBody(durableJob);
  const jobMarker = jobBody.slice(0, jobBody.indexOf('-->') + 3);
  assert.doesNotMatch(jobMarker, /Keep this visible only/);
  assert.doesNotMatch(jobMarker, /description/);
  assert.equal(parseJob(jobBody)?.objective, durableJob.objective);
  assert.equal(parseJob(jobBody)?.reviewerThreadId, 'reviewer-thread');
  assert.equal(parseJob(jobBody)?.creatorThreadId, 'creator-thread');
  assert.equal(jobBody.split('Keep this visible only.').length - 1, 1);
  assert.equal(parseJob(renderJobComment(durableJob))?.objective, durableJob.objective);

  const durableTask = task('dedupe', 'work');
  durableTask.input = '```mermaid\nflowchart TD\nA --> B\n```\n\nDo the work.';
  durableTask.agentGraph = 'flowchart LR\nresearch[agent:researcher] --> review[agent:reviewer]';
  const taskBody = renderTaskComment(durableTask);
  const taskMarker = taskBody.slice(0, taskBody.indexOf('-->') + 3);
  assert.doesNotMatch(taskMarker, /Do the work/);
  assert.match(taskBody, /### Agent graph/);
  assert.match(taskBody, /research\[agent:researcher\] --> review\[agent:reviewer\]/);
  assert.equal(parseTask(taskBody)?.input, durableTask.input);
});
test('marker parser tolerates Mermaid arrows inside JSON string values', () => {
  const description = 'mermaid\\nflowchart TD\\nA --> B';
  const body = marker(JOB_MARKER, { id: 'mermaid-job', title: 'Mermaid', description, tasks: undefined });
  assert.equal(body.indexOf('-->'), body.length - 3);
  const parsed = parseJob(body);
  assert.equal(parsed?.id, 'mermaid-job');
  assert.equal(parsed?.description, description);
  assert.equal(parsed?.objective, description);
});

const now = () => new Date().toISOString();
const task = (jobId, id, state = 'QUEUED') => ({
  jobId,
  id,
  parentTaskId: null,
  dependencies: [],
  capabilities: [],
  adapter: 'orchestrator',
  input: 'stored task fixture',
  state,
  attempt: 0,
  maxAttempts: 2,
  leaseOwner: null,
  leaseExpiresAt: null,
  executionId: null,
  threadId: null,
  result: null,
  error: null,
  timeoutMs: 1000,
  createdAt: now(),
  updatedAt: now(),
  continuation: null,
  continuationDeliveredAt: null
});
const job = id => ({
  id,
  title: id,
  prNumber: 1,
  repository: 'owner/repo',
  state: 'ACTIVE',
  continuation: null,
  createdAt: now(),
  updatedAt: now(),
  tasks: undefined
});
const githubComment = (body, login = 'bot', id = Math.floor(Math.random() * 1_000_000) + 100) => ({
  id,
  body,
  updated_at: now(),
  user: { login }
});
const trustedClient = comments => ({
  request: async () => { throw new Error('REST should not be used by GitHubStore'); },
  graphql: async (query, variables = {}) => {
    if (query.includes('pullRequest(number:$number){id state merged mergedAt closedAt')) return { repository:{ pullRequest:{ id:'PR_1', state:'OPEN', merged:false, mergedAt:null, closedAt:null, headRefName:'feat/test', headRefOid:'abc123' } } };
    if (query.includes('comments(first:100')) return { repository:{ pullRequest:{ comments:{ nodes:comments.map(item=>({id:'IC_'+item.id,databaseId:item.id,body:item.body,updatedAt:item.updated_at,author:{login:item.user.login}})), pageInfo:{hasNextPage:false,endCursor:null} } } } };
    if (query.includes('addComment')) { const item=githubComment(variables.body); comments.push(item); return { addComment:{ commentEdge:{ node:{ id:'IC_'+item.id } } } }; }
    if (query.includes('updateIssueComment')) { const id=Number(String(variables.id).replace('IC_','')); const item=comments.find(row=>row.id===id); item.body=variables.body; return { updateIssueComment:{ issueComment:{id:variables.id} } }; }
    if (query.includes('deleteIssueComment')) { const id=Number(String(variables.id).replace('IC_','')); const index=comments.findIndex(row=>row.id===id); if(index>=0) comments.splice(index,1); return { deleteIssueComment:{clientMutationId:null} }; }
    throw new Error('Unhandled fake GraphQL query: '+query);
  }
});
const githubWithComments = comments => new GitHubStore(trustedClient(comments), 'owner/repo', 1, new Set(['bot']));
const memoryWithComments = comments => {
  const store = new InMemoryStore();
  for (const item of comments) {
    const parsedJob = parseJob(item.body);
    if (parsedJob) void store.saveJob(parsedJob);
    const parsedTask = parseTask(item.body);
    if (parsedTask) void store.appendTask(parsedTask);
  }
  return store;
};

test('same task id remains scoped to its job', async () => {
  const shared = 'shared-task';
  const first = task('job-a', shared, 'SUCCEEDED');
  first.result = { summary: 'first job' };
  const second = task('job-b', shared);
  const comments = [
    githubComment(marker(JOB_MARKER, job('job-a'))),
    githubComment(marker(JOB_MARKER, job('job-b'))),
    githubComment(marker(TASK_MARKER, first)),
    githubComment(marker(TASK_MARKER, second))
  ];
  const github = githubWithComments(comments);
  const memory = memoryWithComments(comments);

  assert.deepEqual((await github.load('job-a')).tasks.map(item => item.id), [shared]);
  assert.deepEqual((await memory.load('job-a')).tasks.map(item => item.id), [shared]);
  assert.deepEqual((await github.load('job-b')).tasks.map(item => item.id), [shared]);
  assert.deepEqual((await memory.load('job-b')).tasks.map(item => item.id), [shared]);

  const loaded = await github.load('job-a');
  loaded.tasks[0].state = 'CANCELLED';
  await github.saveTask(loaded.tasks[0]);
  assert.equal((await github.load('job-a')).tasks[0].state, 'CANCELLED');
  assert.equal((await github.load('job-b')).tasks[0].state, 'QUEUED');

  const loadedMemory = await memory.load('job-a');
  loadedMemory.tasks[0].state = 'CANCELLED';
  await memory.saveTask(loadedMemory.tasks[0]);
  assert.equal((await memory.load('job-a')).tasks[0].state, 'CANCELLED');
  assert.equal((await memory.load('job-b')).tasks[0].state, 'QUEUED');

  const updated = comments.find(item => item.body.includes('"jobId":"job-a"') && item.body.includes(shared));
  assert.match(updated.body, /CANCELLED/);
  assert.doesNotMatch(updated.body, /"jobId":"job-b"/);
});

test('legacy tasks join only one trusted job and are never guessed with multiple', async () => {
  const legacyMarker = marker(TASK_MARKER, { ...task('', 'legacy', 'SUCCEEDED'), jobId: undefined });
  const soleJob = [githubComment(marker(JOB_MARKER, job('solo'))), githubComment(legacyMarker)];
  const multipleJobs = [githubComment(marker(JOB_MARKER, job('one'))), githubComment(marker(JOB_MARKER, job('two'))), githubComment(legacyMarker)];
  const soleGithub = githubWithComments(soleJob);
  const soleMemory = memoryWithComments(soleJob);
  const multipleGithub = githubWithComments(multipleJobs);
  const multipleMemory = memoryWithComments(multipleJobs);

  assert.deepEqual((await soleGithub.load('solo')).tasks.map(item => item.id), ['legacy']);
  assert.deepEqual((await soleMemory.load('solo')).tasks.map(item => item.id), ['legacy']);
  assert.deepEqual((await multipleGithub.load('one')).tasks, []);
  assert.deepEqual((await multipleMemory.load('one')).tasks, []);
});

test('untrusted task markers are ignored and updates survive a fresh store', async () => {
  const durable = task('job-a', 'durable', 'SUCCEEDED');
  durable.result = { summary: 'durable' };
  const comments = [
    githubComment(marker(JOB_MARKER, job('job-a'))),
    githubComment(marker(TASK_MARKER, durable)),
    githubComment(marker(TASK_MARKER, task('job-a', 'forged')), 'attacker', 999)
  ];
  const github = githubWithComments(comments);
  const memory = memoryWithComments(comments.filter(item => item.user.login === 'bot'));
  const loaded = await github.load('job-a');

  assert.deepEqual(loaded.tasks.map(item => item.id), ['durable']);
  assert.deepEqual((await memory.load('job-a')).tasks.map(item => item.id), ['durable']);
  loaded.tasks[0].result.summary = 'updated';
  await github.saveTask(loaded.tasks[0]);

  const fresh = githubWithComments(comments);
  const reloaded = await fresh.load('job-a');
  assert.equal(reloaded.tasks[0].result.summary, 'updated');
  assert.equal(reloaded.tasks.some(item => item.id === 'forged'), false);
});

class ManagedGitHubClient {
  constructor(pulls = []) {
    this.pulls = pulls;
    this.comments = new Map();
    this.nextPr = Math.max(0, ...pulls.map(item => item.number)) + 1;
    this.nextComment = 1;
  }
  pulls;
  comments;
  nextPr;
  nextComment;
  patchCount=0;
  async graphql(query, variables = {}) {
    const pr = this.pulls.find(item => item.number === Number(variables.number)) ?? this.pulls[0];
    if (query.includes('pullRequest(number:$number){id state merged mergedAt closedAt')) return { repository:{ pullRequest: pr ? { id:'PR_'+pr.number, state:String(pr.state||'open').toUpperCase(), merged:false, mergedAt:null, closedAt:null, body:pr.body ?? '' } : null } };
    if (query.includes('pullRequest(number:$number){number title body state headRefName baseRefName}')) return { repository:{ pullRequest: pr ? {number:pr.number,title:pr.title,body:pr.body,state:String(pr.state||'open').toUpperCase(),headRefName:pr.head.ref,baseRefName:pr.base.ref} : null } };
    if (query.includes('pullRequests(first:20')) {
      const nodes=this.pulls.filter(item=>item.state==='open'&&(!variables.head||item.head.ref===variables.head)&&(!variables.base||item.base.ref===variables.base)).map(item=>({number:item.number,title:item.title,body:item.body,state:'OPEN',headRefName:item.head.ref,baseRefName:item.base.ref}));
      return {repository:{pullRequests:{nodes}}};
    }
    if (query.includes('query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}')) return {repository:{id:'REPO_owner_repo'}};
    if (query.includes('createPullRequest')) {
      const pull={number:this.nextPr++,title:variables.title,body:variables.body,state:'open',head:{ref:variables.head},base:{ref:variables.base}};
      this.pulls.push(pull);
      return {createPullRequest:{pullRequest:{number:pull.number,title:pull.title,body:pull.body,state:'OPEN',headRefName:pull.head.ref,baseRefName:pull.base.ref}}};
    }
    if (query.includes('comments(first:100')) { const values=this.comments.get(Number(variables.number)) ?? []; return { repository:{ pullRequest:{ comments:{ nodes:values.map(item=>({id:'IC_'+item.id,databaseId:item.id,body:item.body,updatedAt:item.updated_at,author:{login:item.user.login}})), pageInfo:{hasNextPage:false,endCursor:null} } } } }; }
    if (query.includes('addComment')) { const prNumber=Number(String(variables.subjectId).replace('PR_','')); const values=this.comments.get(prNumber) ?? []; const item=githubComment(variables.body,'bot',this.nextComment++); values.push(item); this.comments.set(prNumber,values); return { addComment:{commentEdge:{node:{id:'IC_'+item.id}}} }; }
    if (query.includes('updateIssueComment')) { const id=Number(String(variables.id).replace('IC_','')); for(const values of this.comments.values()){const item=values.find(row=>row.id===id); if(item){item.body=variables.body; return {updateIssueComment:{issueComment:{id:variables.id}}};}} }
    if (query.includes('deleteIssueComment')) { const id=Number(String(variables.id).replace('IC_','')); for(const values of this.comments.values()){const index=values.findIndex(row=>row.id===id); if(index>=0){values.splice(index,1); return {deleteIssueComment:{clientMutationId:null}};}} }
    throw new Error('Unhandled fake GraphQL query: '+query);
  }
  async request(path, init = {}) {
    const method = String(init.method ?? 'GET');
    if (path.includes('/compare/')) return { ahead_by: 1 };
    if (path.includes('/pulls?')) return this.pulls.filter(item => item.state === 'open');
    const pullMatch = path.match(/\/pulls\/(\d+)$/);
    if (method === 'GET' && pullMatch) return this.pulls.find(item => item.number === Number(pullMatch[1]));
    if (method === 'PATCH' && pullMatch) {
      this.patchCount += 1;
      const pull = this.pulls.find(item => item.number === Number(pullMatch[1]));
      if (!pull) throw new Error('pull not found');
      const patch = JSON.parse(String(init.body));
      if (typeof patch.body === 'string') pull.body = patch.body;
      if (typeof patch.state === 'string') pull.state = patch.state;
      return pull;
    }
    if (method === 'POST' && path.endsWith('/pulls')) {
      const body = JSON.parse(String(init.body));
      const pull = { number: this.nextPr++, title: body.title, body: body.body, state: 'open', head: { ref: body.head }, base: { ref: body.base } };
      this.pulls.push(pull);
      return pull;
    }
    const commentsMatch = path.match(/\/issues\/(\d+)\/comments/);
    if (method === 'GET' && commentsMatch) return this.comments.get(Number(commentsMatch[1])) ?? [];
    if (method === 'POST' && commentsMatch) {
      const pr = Number(commentsMatch[1]);
      const values = this.comments.get(pr) ?? [];
      const body = JSON.parse(String(init.body));
      const comment = githubComment(body.body, 'bot', this.nextComment++);
      values.push(comment);
      this.comments.set(pr, values);
      return comment;
    }
    const commentMatch = path.match(/\/issues\/comments\/(\d+)$/);
    if (commentMatch) {
      const id = Number(commentMatch[1]);
      for (const values of this.comments.values()) {
        const index = values.findIndex(item => item.id === id);
        if (index < 0) continue;
        if (method === 'DELETE') { values.splice(index, 1); return null; }
        const body = JSON.parse(String(init.body));
        values[index].body = body.body;
        return values[index];
      }
    }
    throw new Error('Unhandled fake GitHub request: ' + method + ' ' + path);
  }
}

test('managed no-GitHub Job creation is GitHub-independent and idempotent by immutable jobId', async () => {
  const { ensureManagedGitHubJob } = await import('../dist/cli.js');
  const root = await mkdtemp(join(tmpdir(), 'relay-local-job-create-'));
  const directory = join(root, 'stores');
  try {
    let apiCalls=0;
    const client={request:async()=>{apiCalls++;throw Error('GitHub REST forbidden');},
      graphql:async()=>{apiCalls++;throw Error('GitHub GraphQL forbidden');}};
    const options={idempotencyKey:'managed',title:'Managed work',head:'feat/managed',base:'main',
      body:'body', reviewerThreadId:'reviewer-thread',creatorThreadId:'creator-thread',
      storeDirectory:directory,noGitHub:true};
    const first=await ensureManagedGitHubJob(client,'owner/repo',new Set(),options);
    const second=await ensureManagedGitHubJob(client,'owner/repo',new Set(),options);
    assert.equal(first.pr.number,0);
    assert.equal(first.job.prNumber,0);
    assert.equal(first.job.objective,'body');
    assert.equal(second.job.id,first.job.id);
    assert.equal(first.job.autoMerge,true);
    assert.equal(first.job.reviewerThreadId,'reviewer-thread');
    assert.equal(first.job.creatorThreadId,'creator-thread');
    assert.equal(apiCalls,0);
    const sqlite=new SQLiteRelayStore(relayUnifiedStorePath(directory), first.job.id);
    assert.equal((await sqlite.loadJob(first.job.id)).title,'Managed work');
    assert.equal((await sqlite.listJobs()).length,1);
    assert.equal(await sqlite.pendingProjectionCount(),0);
    sqlite.close();
    await assert.rejects(ensureManagedGitHubJob(client,'someone/other',new Set(),{...options,id:first.job.id}),
      /different repository/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('managed head Job bootstrap is GitHub-independent and derives local merge refs', async () => {
  const { ensureManagedGitHubJob } = await import('../dist/cli.js');
  const root = await mkdtemp(join(tmpdir(), 'relay-head-job-create-'));
  const directory = join(root, 'stores');
  try {
    let apiCalls = 0;
    const client = {
      request: async () => { apiCalls++; throw new Error('GitHub REST forbidden'); },
      graphql: async () => { apiCalls++; throw new Error('GitHub GraphQL forbidden'); },
    };
    const options = {
      idempotencyKey: 'head-managed', title: 'Head managed work', objective: 'body',
      head: 'feat/head-managed', base: 'main', body: 'body', storeDirectory: directory,
    };
    const first = await ensureManagedGitHubJob(client, 'owner/repo', new Set(['bot']), options);
    const second = await ensureManagedGitHubJob(client, 'owner/repo', new Set(['bot']), options);
    assert.equal(first.pr.number, 0);
    assert.equal(first.job.prNumber, 0);
    assert.equal(apiCalls, 0);
    assert.deepEqual(first.job.localMerge, {
      sourceRef: 'refs/heads/feat/head-managed', targetRef: 'refs/heads/main', status: 'pending',
    });
    assert.equal(second.job.id, first.job.id);
    const sqlite = new SQLiteRelayStore(relayUnifiedStorePath(directory), first.job.id);
    assert.equal((await sqlite.loadJob(first.job.id)).prNumber, 0);
    sqlite.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dashboard keeps every unfinished job and only the latest ten completed jobs', () => {
  const overview = (id, state, completedAt) => ({ job: { ...job(id), state, prNumber: Number(id.replace('job-', '')) }, githubState: completedAt ? 'MERGED' : 'OPEN', draft: id === 'job-99', mergedAt: completedAt, closedAt: null });
  const unfinished = [overview('job-1', 'OPEN', null), overview('job-2', 'FAILED', null)];
  const completed = Array.from({ length: 12 }, (_, index) => overview(`job-${index + 10}`, 'COMPLETED', `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`));
  const result = dashboardManagedJobs([...completed, ...unfinished]);
  assert.deepEqual(result.slice(0, 2).map(item => item.job.id), ['job-1', 'job-2']);
  assert.equal(result.length, 12);
  assert.deepEqual(result.slice(2).map(item => item.job.id), ['job-21', 'job-20', 'job-19', 'job-18', 'job-17', 'job-16', 'job-15', 'job-14', 'job-13', 'job-12']);
  assert.equal(result.some(item => item.job.id === 'job-10'), false);
});

test('dashboard completion filtering follows durable Job lifecycle, not GitHub PR state', () => {
  const activeMerged = { job: { ...job('job-1'), state: 'ACTIVE', prNumber: 1 }, githubState: 'MERGED', draft: false, mergedAt: '2026-01-01T00:00:00.000Z', closedAt: null };
  const completed = Array.from({ length: 12 }, (_, index) => ({
    job: { ...job('job-' + (index + 10)), state: 'COMPLETED', prNumber: index + 10 },
    githubState: 'MERGED', draft: false, mergedAt: '2026-02-' + String(index + 1).padStart(2, '0') + 'T00:00:00.000Z', closedAt: null,
  }));
  const result = dashboardManagedJobs([...completed, activeMerged]);
  assert.equal(result[0].job.id, 'job-1');
  assert.equal(result[0].job.state, 'ACTIVE');
  assert.equal(result.length, 11);
});

test('dashboard terminal history uses latest durable activity for discovery ordering', () => {
  const overview = (id, updatedAt, mergedAt) => ({ job: { ...job(id), state: 'COMPLETED', updatedAt, prNumber: Number(id.replace('job-', '')) }, githubState: 'MERGED', draft: false, mergedAt, closedAt: null });
  const items = Array.from({ length: 10 }, (_, index) => overview(`job-${index + 1}`, `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`, `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`));
  items.push(overview('job-44', '2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'));
  assert.deepEqual(dashboardManagedJobs(items).slice(0, 1).map(item => item.job.id), ['job-44']);
});

test('managed Job binds a known PR number entirely offline with zero GitHub reads', async () => {
  const { ensureManagedGitHubJob } = await import('../dist/cli.js');
  const root = await mkdtemp(join(tmpdir(), 'relay-offline-adopt-'));
  const directory = join(root, 'stores');
  try {
    const client = {
      request: async () => { throw new Error('GitHub disconnected'); },
      graphql: async () => { throw new Error('GitHub disconnected'); },
    };
    const result = await ensureManagedGitHubJob(client, 'owner/repo', new Set(), {
      idempotencyKey: 'adopted', prNumber: 6, storeDirectory: directory,
    });
    assert.equal(result.pr.number, 6);
    assert.match(result.job.id, /^[1-9][0-9]*$/);
    const sqlite = new SQLiteRelayStore(relayUnifiedStorePath(directory), result.job.id);
    assert.equal((await sqlite.loadJob(result.job.id)).state, 'DRAFT');
    assert.equal(await sqlite.pendingProjectionCount(), 0);
    sqlite.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('saveJob migrates a legacy Job comment into the PR body without touching Task comments', async () => {
  const { renderJobComment } = await import('../dist/markers.js');
  const legacyJob = { ...job('legacy-body'), objective: '# Goal\n\nKeep this objective once.' };
  const child = task('legacy-body', 'child');
  const client = new ManagedGitHubClient([{ number: 6, title: 'Legacy', body: legacyJob.objective, state: 'open', head: { ref: 'feat/legacy' }, base: { ref: 'main' } }]);
  const legacyComment = githubComment(renderJobComment(legacyJob), 'bot', 1);
  const taskComment = githubComment(marker(TASK_MARKER, child), 'bot', 2);
  client.comments.set(6, [legacyComment, taskComment]);
  const store = new GitHubStore(client, 'owner/repo', 6, new Set(['bot']));

  const loaded = await store.load('legacy-body');
  assert.equal(loaded.objective, legacyJob.objective);
  await store.saveJob(loaded);

  assert.equal(parseJob(client.pulls[0].body)?.id, 'legacy-body');
  assert.equal(parseJob(client.pulls[0].body)?.objective, legacyJob.objective);
  const comments = client.comments.get(6) ?? [];
  assert.equal(comments.some(item => parseJob(item.body)?.id === 'legacy-body'), false);
  assert.equal(comments.filter(item => parseTask(item.body)?.id === 'child').length, 1);
});

test('saveJob skips identical PR body writes and patches changed job state', async () => {
  const durable = { ...job('idempotent'), executionMode: 'fixed' };
  const client = new ManagedGitHubClient([{ number: 6, title: 'Existing', body: renderJobBody(durable), state: 'open', head: { ref: 'feat/idempotent' }, base: { ref: 'main' } }]);
  const store = new GitHubStore(client, 'owner/repo', 6, new Set(['bot']));

  const loaded = await store.load('idempotent');
  assert.equal(renderJobBody(loaded), client.pulls[0].body);
  await store.saveJob(loaded);
  assert.equal(client.patchCount, 0);

  const changed = await store.load('idempotent');
  changed.state = 'COMPLETED';
  await store.saveJob(changed);
  assert.equal(client.patchCount, 1);
  assert.equal(parseJob(client.pulls[0].body)?.state, 'COMPLETED');
});

test('plain objective text mentioning the Job marker name is not treated as a malformed marker', async () => {
  const client = new ManagedGitHubClient([{ number: 6, title: 'Existing', body: 'Discuss agents-relay:job:v1 storage without embedding a marker.', state: 'open', head: { ref: 'feat/existing' }, base: { ref: 'main' } }]);
  const legacy = { ...job('mention-marker'), objective: client.pulls[0].body };
  client.comments.set(6, [githubComment(marker(JOB_MARKER, legacy), 'bot', 1)]);
  const store = new GitHubStore(client, 'owner/repo', 6, new Set(['bot']));

  await store.validateJobBinding('mention-marker');
  await store.saveJob(await store.load('mention-marker'));
  assert.equal(parseJob(client.pulls[0].body)?.id, 'mention-marker');
});

test('job update validation rejects duplicate markers instead of repairing them', async () => {
  const client = new ManagedGitHubClient([{ number: 6, title: 'Existing', body: '', state: 'open', head: { ref: 'feat/existing' }, base: { ref: 'main' } }]);
  const duplicate = marker(JOB_MARKER, job('repair'));
  client.comments.set(6, [githubComment(duplicate, 'bot', 1), githubComment(duplicate, 'bot', 2)]);
  const store = new GitHubStore(client, 'owner/repo', 6, new Set(['bot']));

  await assert.rejects(() => store.validateJobBinding('repair'), /JOB_MARKER_DUPLICATED/);
  assert.equal((client.comments.get(6) ?? []).filter(item => parseJob(item.body)?.id === 'repair').length, 2);
});

test('managed Task creation is gated on the local SQLite Job, never PR markers', async () => {
  const { ensureManagedGitHubJob } = await import('../dist/cli.js');
  const root = await mkdtemp(join(tmpdir(), 'relay-task-gate-'));
  const directory = join(root, 'stores');
  try {
    const client = {
      request: async () => { throw new Error('GitHub disconnected'); },
      graphql: async () => { throw new Error('GitHub disconnected'); },
    };
    const { store, relay } = openLocalManagedStore('owner/repo', 6, { directory, client, jobId: '1' });
    await assert.rejects(store.appendTask(task('1', 'child')), /Local authoritative Job 1 not found/);
    const created = await ensureManagedGitHubJob(client, 'owner/repo', new Set(), {
      idempotencyKey: 'gated', prNumber: 6, storeDirectory: directory,
    });
    await store.appendTask(task(created.job.id, 'child'));
    const durable = await store.load(created.job.id);
    assert.deepEqual(durable.tasks.map(item => item.id), ['child']);
    assert.equal(await relay.pendingProjectionCount(), 0);
    relay.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agent registrations persist through trusted stores and ignore forged markers', async () => {
  const agent = { id:'researcher', name:'Researcher', responsibility:'public research', role:'researcher', capabilities:['research'], boundaries:['no credentials'], endpoint:{kind:'adapter',target:'codex'}, runtime:{adapter:'codex'}, availability:'available', routing:{trustDomains:['public']}, evidence:{evaluations:[],outcomes:{succeeded:0,failed:0,timedOut:0},lastObservedAt:null}, registeredAt:now(), updatedAt:now() };
  const comments = [githubComment(marker(JOB_MARKER, job('job-a'))), githubComment(marker(AGENT_MARKER, agent)), githubComment(marker(AGENT_MARKER, {...agent, id:'forged'}), 'attacker', 1001)];
  const store = githubWithComments(comments);
  assert.deepEqual((await store.listAgents()).map(item => item.id), ['researcher']);
  agent.availability = 'degraded';
  await store.saveAgent(agent);
  const fresh = githubWithComments(comments);
  assert.equal((await fresh.listAgents())[0].availability, 'degraded');
  assert.equal(parseAgent(comments[1].body).id, 'researcher');
});


test('GitHubStore Plan append/update is job-gated, identity-stable, and fresh-store readable', async () => {
  const unmanagedComments = [];
  const unmanaged = githubWithComments(unmanagedComments);
  const orphan = { jobId:'missing', id:'plan-1', round:1, source:'model-planner', previousPlanId:null, trigger:{source:'initial'}, status:'PLANNING', assessment:'Planning in progress.', generatedTaskIds:[], createdAt:now(), updatedAt:now() };
  await assert.rejects(() => unmanaged.appendPlan(orphan), /JOB_MARKER_MISSING/);
  assert.equal(unmanagedComments.some(item => item.body.includes(PLAN_MARKER)), false);

  const durableJob = job('plan-store');
  const comments = [githubComment(marker(JOB_MARKER, durableJob), 'bot', 1)];
  const store = githubWithComments(comments);
  const createdAt = now();
  const pending = { jobId:'plan-store', id:'plan-1', round:1, source:'model-planner', previousPlanId:null, trigger:{source:'unblock',taskIds:['release'],reason:'access restored',facts:['publisher access restored'],blockedHeadShas:['abc'],currentHeadSha:'def'}, status:'PLANNING', guidance:'retry release', assessment:'Planning in progress.', generatedTaskIds:[], headSha:'def', createdAt, updatedAt:createdAt };
  await store.appendPlan(pending);
  const persistedComment = comments.find(item => parsePlan(item.body)?.id === 'plan-1');
  assert.ok(persistedComment);
  const commentId = persistedComment.id;
  const finished = { ...pending, status:'SUCCEEDED', objectiveStatus:'in_progress', assessment:'release can proceed', generatedTaskIds:['release-next'], updatedAt:now() };
  await store.savePlan(finished);
  assert.equal(comments.filter(item => parsePlan(item.body)?.id === 'plan-1').length, 1);
  assert.equal(comments.find(item => parsePlan(item.body)?.id === 'plan-1').id, commentId);
  const fresh = githubWithComments(comments);
  const loaded = await fresh.load('plan-store');
  assert.equal(loaded.plans.length, 1);
  assert.equal(loaded.plans[0].status, 'SUCCEEDED');
  assert.deepEqual(loaded.plans[0].generatedTaskIds, ['release-next']);
  assert.match(loaded.plans[0].planUrl, /issuecomment-/);
});

test('task append is idempotent by job id and task id and rejects conflicting replay', async () => {
  const durableJob = job('idem');
  const comments = [githubComment(marker(JOB_MARKER, durableJob), 'bot', 1)];
  const store = githubWithComments(comments);
  const first = task('idem', 'child');
  first.capabilities = ['coding'];
  await store.appendTask(first);
  const replay = { ...first, createdAt: now(), updatedAt: now() };
  await store.appendTask(replay);
  assert.equal(comments.filter(item => parseTask(item.body)?.id === 'child').length, 1);

  const conflict = { ...replay, input: 'different work' };
  await assert.rejects(() => store.appendTask(conflict), /different definition/);
  assert.equal(comments.filter(item => parseTask(item.body)?.id === 'child').length, 1);
});

test('saveTask collapses duplicate durable markers for one job and task id', async () => {
  const durableJob = job('dedupe');
  const child = task('dedupe', 'child');
  const comments = [
    githubComment(marker(JOB_MARKER, durableJob), 'bot', 1),
    githubComment(marker(TASK_MARKER, child), 'bot', 2),
    githubComment(marker(TASK_MARKER, child), 'bot', 3)
  ];
  const client = new ManagedGitHubClient([{ number: 6, title: 'Existing', body: '', state: 'open', head: { ref: 'feat/existing' }, base: { ref: 'main' } }]);
  client.comments.set(6, comments);
  client.nextComment = 4;
  const store = new GitHubStore(client, 'owner/repo', 6, new Set(['bot']));
  child.state = 'RUNNING';
  await store.saveTask(child);
  assert.equal((client.comments.get(6) ?? []).filter(item => parseTask(item.body)?.id === 'child').length, 1);
  assert.equal((await store.load('dedupe')).tasks[0].state, 'RUNNING');
});

test('managed Job creation never bootstraps a GitHub branch and retains local merge refs', async () => {
  const { ensureManagedGitHubJob } = await import('../dist/cli.js');
  const root=await mkdtemp(join(tmpdir(),'relay-local-merge-source-'));
  const directory=join(root,'stores');
  try {
    let apiCalls=0;
    const client={
      request:async()=>{apiCalls++;throw Error('GitHub API forbidden');},
      graphql:async()=>{apiCalls++;throw Error('GitHub API forbidden');},
    };
    const result=await ensureManagedGitHubJob(client,'owner/repo',new Set(),{
      idempotencyKey:'empty-job',title:'Local source job',head:'feat/empty',base:'main',
      localMergeSource:'refs/heads/feature',localMergeTarget:'refs/heads/main',
      body:'body',storeDirectory:directory,noGitHub:true,
    });
    assert.equal(result.pr.number,0);
    assert.equal(apiCalls,0);
    assert.equal(result.job.headSha,undefined);
    assert.deepEqual(result.job.localMerge,{
      sourceRef:'refs/heads/feature',targetRef:'refs/heads/main',status:'pending',
    });
  } finally {await rm(root,{recursive:true,force:true});}
});

test('GitHubStore closes its backing pull request explicitly', async () => {
  let seenPath = null; let seenInit = null;
  const client = { request: async (path, init) => { seenPath = path; seenInit = init; return {}; } };
  const store = new GitHubStore(client, 'owner/repo', 7, new Set(['bot']));
  await store.closePullRequest();
  assert.equal(seenPath, 'repos/owner/repo/pulls/7');
  assert.equal(seenInit.method, 'PATCH');
  assert.deepEqual(JSON.parse(seenInit.body), { state: 'closed' });
});


test('GitHubStore exposes exact pull request head ref and sha for execution isolation', async () => {
  const store = githubWithComments([]);
  assert.deepEqual(await store.pullRequestHead(), { ref: 'feat/test', sha: 'abc123' });
  assert.equal(await store.headSha(), 'abc123');
});

test('GitHubStore read-your-writes survives stale GraphQL across store instances', async () => {
  const baseJob = job('job-read-your-writes');
  const baseTask = task('job-read-your-writes', 'route-me');
  const jobBody = marker(JOB_MARKER, baseJob);
  const staleTaskBody = marker(TASK_MARKER, baseTask);
  let remoteTaskBody = staleTaskBody;
  let remoteUpdatedAt = '2026-09-26T22:00:00.000Z';
  let stale = true;
  const client = {
    request: async () => { throw new Error('REST should not be used by GitHubStore'); },
    graphql: async (query, variables = {}) => {
      if (query.includes('pullRequest(number:$number){id state merged mergedAt closedAt')) {
        return { repository:{ pullRequest:{ id:'PR_RW', state:'OPEN', merged:false, mergedAt:null, closedAt:null, body:jobBody, headRefName:'feat/rw', headRefOid:'abc123' } } };
      }
      if (query.includes('comments(first:100')) {
        return { repository:{ pullRequest:{ comments:{ nodes:[
          {id:'IC_1',databaseId:1,body:jobBody,updatedAt:'2026-09-26T21:59:00.000Z',author:{login:'bot'}},
          {id:'IC_2',databaseId:2,body:stale ? staleTaskBody : remoteTaskBody,updatedAt:stale ? '2026-09-26T22:00:00.000Z' : remoteUpdatedAt,author:{login:'bot'}},
        ], pageInfo:{hasNextPage:false,endCursor:null} } } } };
      }
      if (query.includes('updateIssueComment')) {
        remoteTaskBody = variables.body;
        remoteUpdatedAt = '2026-09-26T22:01:00.000Z';
        return { updateIssueComment:{ issueComment:{ id:'IC_2', databaseId:2, url:'https://example.test/comment/2', body:variables.body, updatedAt:remoteUpdatedAt, author:{login:'bot'} } } };
      }
      throw new Error('Unhandled fake GraphQL query: '+query);
    },
  };

  const first = new GitHubStore(client, 'owner/repo', 1, new Set(['bot']));
  const loaded = await first.load('job-read-your-writes');
  loaded.tasks[0].workerSelection = { workerId:'codex', adapter:'codex', capabilities:['model','codex'], selectedBy:'test', selectedAt:'2026-09-26T22:00:30.000Z' };
  loaded.tasks[0].routing = { provider:'openai', model:'gpt-5.6-luna', reasoning:'medium', decidedBy:'test', decidedAt:'2026-09-26T22:00:31.000Z' };
  loaded.tasks[0].updatedAt = '2026-09-26T22:00:31.000Z';
  await first.saveTask(loaded.tasks[0]);

  const second = new GitHubStore(client, 'owner/repo', 1, new Set(['bot']));
  const immediate = await second.load('job-read-your-writes');
  assert.equal(immediate.tasks[0].workerSelection?.workerId, 'codex');
  assert.equal(immediate.tasks[0].routing?.model, 'gpt-5.6-luna');

  stale = false;
  const caughtUp = await second.load('job-read-your-writes');
  assert.equal(caughtUp.tasks[0].routing?.model, 'gpt-5.6-luna');

  const newer = parseTask(remoteTaskBody);
  newer.state = 'RUNNING';
  newer.updatedAt = '2026-09-26T22:02:00.000Z';
  remoteTaskBody = marker(TASK_MARKER, newer);
  remoteUpdatedAt = '2026-09-26T22:02:00.000Z';
  const external = await new GitHubStore(client, 'owner/repo', 1, new Set(['bot'])).load('job-read-your-writes');
  assert.equal(external.tasks[0].state, 'RUNNING');
});


test('GitHub rate limit snapshot is lazy cached and single-flight by construction', async () => {
  const source = await readFile(new URL('../src/github-client.ts', import.meta.url), 'utf8');
  assert.match(source, /rateLimitCacheTtlMs = 5 \* 60_000/);
  assert.match(source, /if \(!force && this\.rateLimitCache/);
  assert.match(source, /if \(this\.rateLimitFlight\) return this\.rateLimitFlight/);
  assert.match(source, /\['api', 'rate_limit'\]/);
  assert.match(source, /resources: \{ core: bucket\(resources\?\.core\), graphql: bucket\(resources\?\.graphql\), search: bucket\(resources\?\.search\) \}/);
});


test('GitHub client exposes in-memory API call counters in rate-limit status', async () => {
  const source = await readFile(new URL('../src/github-client.ts', import.meta.url), 'utf8');
  assert.match(source, /apiDiagnostics = \{ rest: 0, graphql: 0, rateLimit: 0 \}/);
  assert.match(source, /calls: \{ \.\.\.this\.apiDiagnostics \}/);
  assert.match(source, /this\.apiDiagnostics\.graphql \+= 1/);
  assert.match(source, /this\.apiDiagnostics\.rest \+= 1/);
  assert.match(source, /this\.apiDiagnostics\.rateLimit \+= 1/);
});

test('GraphQL publication hydration accepts github-actions bot identity without trusting it for Job markers', async () => {
  const durable = job('published-job');
  durable.state = 'COMPLETED';
  const publicationBody = '<!-- agents-relay:package-published:v1 {"package":"agents-relay","version":"1.0.133","registry":"https://registry.npmjs.org","sha":"abc123"} -->';
  const forged = job('forged-by-actions');
  const client = {
    request: async () => { throw new Error('REST unavailable'); },
    graphql: async query => {
      if (!query.includes('pullRequest(number:$number)')) throw new Error('unexpected query');
      return { repository: { pullRequest: {
        state:'MERGED', isDraft:false, merged:true, mergedAt:now(), closedAt:now(), body:renderJobBody(durable),
        comments:{nodes:[
          {databaseId:1,url:'https://example/1',author:{login:'github-actions'},body:publicationBody},
          {databaseId:2,url:'https://example/2',author:{login:'github-actions'},body:marker(JOB_MARKER, forged)}
        ]}
      } } };
    }
  };
  const rows = await loadManagedGitHubPullRequestGraphql(client, 'owner/repo', 141, new Set(['bot']));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].job.id, 'published-job');
  assert.equal(rows[0].publication?.version, '1.0.133');
});

test('managed Job list hydrates publication from GraphQL github-actions author', async () => {
  const durable = job('published-list-job');
  durable.state = 'COMPLETED';
  durable.prNumber = 141;
  const publicationBody = '<!-- agents-relay:package-published:v1 {"package":"agents-relay","version":"1.0.133","registry":"https://registry.npmjs.org","sha":"abc123"} -->';
  const client = {
    request: async () => { throw new Error('REST unavailable'); },
    graphql: async query => {
      if (!query.includes('recentMerged:pullRequests')) throw new Error('unexpected query');
      return { repository:{
        open:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}},
        recentMerged:{nodes:[{number:141,body:renderJobBody(durable),state:'MERGED',isDraft:false,merged:true,mergedAt:now(),closedAt:now(),comments:{nodes:[{author:{login:'github-actions'},body:publicationBody}]}}]},
        recentClosed:{nodes:[]}
      }};
    }
  };
  const rows = await listManagedGitHubJobs(client, 'owner/repo', new Set(['bot']));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].publication?.version, '1.0.133');
});

test('GraphQL PR snapshot is complete enough to seed GitHubStore reads', async () => {
  const durableJob=job('webhook-seed');
  const durableTask=task('webhook-seed','work');
  const body=marker(TASK_MARKER,durableTask);
  let graphqlCalls=0;
  const client={request:async()=>null,graphql:async query=>{
    graphqlCalls+=1;
    assert.match(query,/headRefName headRefOid comments\(last:100\)\{totalCount/);
    return {repository:{pullRequest:{id:'PR_seed',state:'OPEN',isDraft:false,merged:false,mergedAt:null,closedAt:null,body:renderJobBody(durableJob),headRefName:'feat/seed',headRefOid:'seed-sha',comments:{totalCount:1,nodes:[{id:'IC_seed',databaseId:9,url:'https://example/9',updatedAt:now(),author:{login:'bot'},body}]}}}};
  }};
  const snapshot=await loadManagedGitHubPullRequestSnapshotGraphql(client,'owner/repo',9,new Set(['bot']));
  assert.equal(graphqlCalls,1);
  assert.equal(snapshot.overviews[0].job.id,'webhook-seed');
  const store=new GitHubStore({request:async()=>null,graphql:async()=>{throw new Error('seeded store re-read GraphQL');}},'owner/repo',9,new Set(['bot']),snapshot.seed);
  const loaded=await store.load('webhook-seed');
  assert.equal(loaded.tasks[0].id,'work');
  assert.equal(await store.pullRequestState(),'OPEN');
  assert.deepEqual(await store.pullRequestHead(),{ref:'feat/seed',sha:'seed-sha'});
});

test('GitHubStore reuses one PR snapshot per reconciliation-style store instance', async () => {
  const durableJob = job('snapshot-budget');
  const durableTask = task('snapshot-budget', 'work', 'QUEUED');
  const taskBody = marker(TASK_MARKER, durableTask);
  let graphqlCalls = 0;
  let currentTaskBody = taskBody;
  const client = {
    request: async () => null,
    graphql: async (query, variables = {}) => {
      graphqlCalls += 1;
      if (query.includes('pullRequest(number:$number){id state merged mergedAt closedAt')) {
        return { repository:{ pullRequest:{ id:'PR_1', state:'OPEN', merged:false, mergedAt:null, closedAt:null, body:renderJobBody(durableJob), headRefName:'feat/test', headRefOid:'abc123' } } };
      }
      if (query.includes('comments(first:100')) {
        return { repository:{ pullRequest:{ comments:{ nodes:[{id:'IC_1',databaseId:1,url:'https://example/1',body:currentTaskBody,updatedAt:now(),author:{login:'bot'}}], pageInfo:{hasNextPage:false,endCursor:null} } } } };
      }
      if (query.includes('updateIssueComment')) {
        currentTaskBody = variables.body;
        return { updateIssueComment:{ issueComment:{ id:'IC_1', databaseId:1, url:'https://example/1', body:currentTaskBody, updatedAt:now(), author:{login:'bot'} } } };
      }
      throw new Error('Unhandled fake GraphQL query: '+query);
    }
  };
  const store = new GitHubStore(client, 'owner/repo', 1, new Set(['bot']));
  const first = await store.load('snapshot-budget');
  await store.pullRequestState();
  await store.pullRequestHead();
  await store.load('snapshot-budget');
  first.tasks[0].state = 'RUNNING';
  first.tasks[0].updatedAt = now();
  await store.saveTask(first.tasks[0]);
  const afterWrite = await store.load('snapshot-budget');
  assert.equal(afterWrite.tasks[0].state, 'RUNNING');
  assert.equal(graphqlCalls, 3, 'one comments read + one PR node read + one task mutation; repeated reads must reuse snapshot');
});

test('GitHub GraphQL diagnostics live in the dedicated GitHub client implementation', async () => {
  const storeSource = await readFile(new URL('../src/store.ts', import.meta.url), 'utf8');
  const clientSource = await readFile(new URL('../src/github-client.ts', import.meta.url), 'utf8');
  assert.match(storeSource, /export \{ GhApiClient, createGitHubAppJwt, type GitHubAppAuthOptions \} from '\.\/github-client\.js'/);
  assert.doesNotMatch(storeSource, /class GhApiClient/);
  assert.match(clientSource, /graphqlDiagnostics: GitHubGraphqlDiagnostics/);
  assert.match(clientSource, /requestContext = new AsyncLocalStorage<string>\(\)/);
  assert.match(clientSource, /graphqlDiagnostics\.operations\[operation\]/);
  assert.match(clientSource, /graphqlDiagnostics\.contexts\[context\]/);
  assert.match(clientSource, /'pr\.comments'/);
  assert.match(clientSource, /'pr\.node'/);
});


test('job tag contract and task tag round-trip through trusted markers', async () => {
  const { renderJobComment, renderTaskComment, parseJob, parseTask } = await import('../dist/markers.js');
  const base = job('task-tag');
  base.tag = { description: 'E2E outcome after deterministic test.', values: { pass: '✅', fail: '❌' } };
  assert.deepEqual(parseJob(renderJobComment(base))?.tag, base.tag);
  const child = task('hour-17', 'work');
  child.tag = 'pass';
  assert.equal(parseTask(renderTaskComment(child))?.tag, 'pass');
});


test('default managed store honors AGENTS_RELAY_STORE_DIR isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-store-isolation-'));
  const stores = join(root, 'stores');
  const previous = process.env.AGENTS_RELAY_STORE_DIR;
  process.env.AGENTS_RELAY_STORE_DIR = stores;
  const client = {
    request: async () => { throw new Error('GitHub REST forbidden'); },
    graphql: async () => { throw new Error('GitHub GraphQL forbidden'); },
  };
  try {
    const { ensureManagedGitHubJob } = await import('../dist/cli.js');
    const result = await ensureManagedGitHubJob(client, 'owner/repo', new Set(), {
      idempotencyKey: 'fixture-isolation-regression', title: 'fixture isolation regression',
      objective: 'fixture isolation regression', head: 'feat/fixture-isolation', noGitHub: true,
    });
    assert.equal(result.job.repository, 'owner/repo');
    const { readdir } = await import('node:fs/promises');
    assert.ok((await readdir(root)).includes('relay.sqlite'));
  } finally {
    if (previous === undefined) delete process.env.AGENTS_RELAY_STORE_DIR;
    else process.env.AGENTS_RELAY_STORE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
