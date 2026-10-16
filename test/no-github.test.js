import test, { managedReconciler } from './test-runtime.js';
import assert from 'node:assert/strict';
import { SQLiteRelayStore } from '../dist/relay-store.js';
import { LocalAuthorityDurableStore } from '../dist/local-authority-store.js';
import { DisabledGitHubClient } from '../dist/no-github.js';
import { deriveJobRuntimeStatus } from '../dist/runtime-status.js';
import { GitHubStore, InMemoryStore } from '../dist/store.js';
import { eventFor } from '../dist/events.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { deliverLocalMerge, localSourceHead } from '../dist/local-git-merge.js';

function localRepository() {
  const path=mkdtempSync(join(tmpdir(),'relay-local-merge-'));
  const git=(...args)=>execFileSync('git',['-C',path,...args],{encoding:'utf8'}).trim();
  git('init','-b','main');
  git('config','user.name','Relay Tests');
  git('config','user.email','relay@example.test');
  writeFileSync(join(path,'base.txt'),'base');
  git('add','base.txt');git('commit','-m','base');
  git('checkout','-b','feature');
  writeFileSync(join(path,'feature.txt'),'feature');
  git('add','feature.txt');git('commit','-m','feature');
  const head=git('rev-parse','HEAD');
  git('checkout','main');
  git('checkout','--detach');
  return {path,git,head,close:()=>rmSync(path,{recursive:true,force:true})};
}
const mergeRefs={sourceRef:'refs/heads/feature',targetRef:'refs/heads/main',status:'pending'};
const timestamp = () => new Date().toISOString();
const task = (state='SUCCEEDED') => ({
  jobId: 'local-job', id:'work', agentName:'implementation', kind:'work',
  state, adapter:'codex', input:'local work', dependencies:[], capabilities:[],
  attempt:0, maxAttempts:2, leaseOwner:null, leaseExpiresAt:null,
  executionId:null, threadId:null, result:null, error:null, timeoutMs:1000,
  parentTaskId:null, createdAt:timestamp(), updatedAt:timestamp(),
});
const job = (items=[task()]) => ({
  id:'local-job', title:'Local workflow', repository:'local/test', prNumber:1,
  state:'ACTIVE', executionMode:'fixed', reviewEnabled:false, autoMerge:true,
  headSha:'local-job-head', createdAt:timestamp(), updatedAt:timestamp(),
  continuation:null, tasks:items,
});
function fixture() {
  const db=new SQLiteRelayStore(':memory:');
  const github=new GitHubStore(new DisabledGitHubClient(),'local/test',1);
  return {db, store:new LocalAuthorityDurableStore(db,github,undefined,true)};
}
test('disabled GitHub adapter rejects every remote API path',async()=>{
  const client=new DisabledGitHubClient();
  await assert.rejects(client.request('repos/foo/bar'),/disabled/);
  await assert.rejects(client.graphql('{viewer{login}}'),/disabled/);
  await assert.rejects(client.currentLogin(),/disabled/);
  assert.equal(client.rateLimitStatus().calls.rest,0);
  assert.equal(client.rateLimitStatus().calls.graphql,0);
});
test('no-github Graph completes successful local Job without PR merge',async()=>{
  const {db,store}=fixture();
  const repo=localRepository();
  await store.saveJob({...job(), localMerge:{...mergeRefs}});
  const reconciler=managedReconciler(store,{owner:'no-github-test',adapters:[],
    noGitHub:true,maxConcurrent:0,projectPathForJob:()=>repo.path});
  const completed=await reconciler.reconcile('local-job');
  assert.equal(completed.state,'COMPLETED');
  assert.equal(await store.pullRequestState(),'UNKNOWN');
  assert.equal(await db.pendingProjectionCount(),0);
  assert.equal((await store.load('local-job')).localMerge.mergedCommitSha,repo.git('rev-parse','main'));
  await reconciler.reconcile('local-job');
  assert.equal((await store.load('local-job')).state,'COMPLETED');
  repo.close();db.close();
});
test('no-github approved Review completes local Job without remote merge',async()=>{
  const {db,store}=fixture();
  const repo=localRepository();
  const review={...task('RUNNING'),id:'review-local',agentName:'reviewer',
    reviewHeadSha:repo.head,dependencies:['work'],updatedAt:timestamp()};
  await store.saveJob({...job([task(),review]),localMerge:{...mergeRefs},headSha:repo.head,reviewEnabled:true,review:{
    outcome:'pending',headSha:repo.head,taskId:'review-local',evidence:null,
    updatedAt:timestamp(),
  }});
  const reconciler=managedReconciler(store,{owner:'no-github-review',adapters:[],
    noGitHub:true,maxConcurrent:0,projectPathForJob:()=>repo.path});
  const event=eventFor('local-job','review-local',null,'review.approved','succeeded',
    'approved','orchestrator',{review:{headSha:repo.head,summary:'approved',blockingFindings:[]}});
  const applied=await reconciler.applyEvent(event);
  assert.equal(applied.applied,true,applied.reason);
  const completed=await store.load('local-job');
  assert.equal(completed.review?.outcome,'approved');
  await reconciler.reconcile('local-job');
  assert.equal((await store.load('local-job')).state,'COMPLETED');
  assert.equal((await store.load('local-job')).localMerge.mergedCommitSha,repo.git('rev-parse','main'));
  assert.equal(await db.pendingProjectionCount(),0);
  repo.close();db.close();
});
test('no-github Planner context never fetches a PR head',async()=>{
  const {db,store}=fixture();
  await store.saveJob(job());
  const reconciler=managedReconciler(store,{owner:'no-github-planner',adapters:[],
    noGitHub:true,maxConcurrent:0,projectPathForJob:()=>process.cwd()});
  const context=await reconciler.plannerContext(await store.load('local-job'),task());
  assert.ok(context);
  db.close();
});

test('local Git delivery is idempotent after an acknowledged merge and after simulated receipt loss',()=>{
  const repo=localRepository();
  try {
    const request={...mergeRefs,sourceSha:repo.head};
    const first=deliverLocalMerge(repo.path,request);
    const again=deliverLocalMerge(repo.path,request);
    assert.equal(first.mergedCommitSha,again.mergedCommitSha);
    assert.equal(repo.git('rev-parse','refs/heads/main'),first.mergedCommitSha);
    assert.equal(repo.git('rev-list','--parents','-n','1',first.mergedCommitSha).split(' ').length,3);
  } finally {repo.close();}
});
test('merge conflict persists failure and leaves Job ACTIVE and target untouched',async()=>{
  const repo=localRepository();
  const {db,store}=fixture();
  try {
    repo.git('checkout','feature');
    writeFileSync(join(repo.path,'base.txt'),'conflict feature');
    repo.git('add','base.txt');repo.git('commit','-m','source conflict');
    repo.git('checkout','main');
    writeFileSync(join(repo.path,'base.txt'),'conflict target');
    repo.git('add','base.txt');repo.git('commit','-m','target conflict');
    repo.git('checkout','--detach');
    const target=repo.git('rev-parse','main');
    await store.saveJob({...job(),localMerge:{...mergeRefs}});
    const reconciler=managedReconciler(store,{owner:'conflict-review',adapters:[],
      noGitHub:true,maxConcurrent:0,projectPathForJob:()=>repo.path});
    const result=await reconciler.reconcile('local-job');
    assert.equal(result.state,'ACTIVE');
    assert.equal(result.localMerge.status,'failed');
    assert.match(result.localMerge.error,/CONFLICT|merge-tree|Auto-merging/i);
    assert.equal(repo.git('rev-parse','main'),target);
    assert.ok(result.localMerge.nextAttemptAt);
    assert.equal(await db.pendingProjectionCount(),0);
  } finally { db.close(); repo.close(); }
});
test('commit after Review produces a new local HEAD, invalidating previous approval',async()=>{
  const repo=localRepository();
  const {db,store}=fixture();
  try {
    const review={...task('SUCCEEDED'),id:'review-approved',agentName:'reviewer',
      reviewHeadSha:repo.head,dependencies:['work']};
    await store.saveJob({...job([task(),review]),localMerge:{...mergeRefs},
      reviewEnabled:true,headSha:repo.head,review:{
        outcome:'approved',taskId:review.id,headSha:repo.head,evidence:{summary:'approved'},updatedAt:timestamp(),
      }});
    repo.git('checkout','feature');
    writeFileSync(join(repo.path,'next.txt'),'changed after approval');
    repo.git('add','next.txt');repo.git('commit','-m','after review');
    repo.git('checkout','main');
    const nextHead=repo.git('rev-parse','feature');
    assert.notEqual(nextHead,repo.head);
    const reconciler=managedReconciler(store,{owner:'stale-review',adapters:[],
      noGitHub:true,maxConcurrent:0,reviewer:{adapter:'chatgpt',
        routing:{provider:'chatgpt',model:'account-defaults',decidedBy:'test',decidedAt:timestamp()}},
      projectPathForJob:()=>repo.path});
    await reconciler.reconcile('local-job');
    const saved=await store.load('local-job');
    assert.equal(saved.state,'ACTIVE');
    assert.equal(saved.headSha,nextHead);
    assert.notEqual(saved.review?.outcome,'approved');
    assert.equal(repo.git('rev-parse','main')!==repo.git('rev-parse','feature'),true);
  } finally {db.close();repo.close();}
});
test('reconciliation recovers merge delivery after SQLite reopen without duplicate commit',async()=>{
  const repo=localRepository();
  const {mkdtempSync}=await import('node:fs');
  const dbPath=join(repo.path,'relay.sqlite');
  let db=new SQLiteRelayStore(dbPath);
  const makeStore=()=>new LocalAuthorityDurableStore(db,new GitHubStore(new DisabledGitHubClient(),'local/test',1),undefined,true);
  try{
    let store=makeStore();
    await store.saveJob({...job(),localMerge:{...mergeRefs,status:'pending',sourceSha:repo.head}});
    db.close();
    db=new SQLiteRelayStore(dbPath);
    store=makeStore();
    const reconciler=managedReconciler(store,{owner:'restart-test',adapters:[],
      noGitHub:true,maxConcurrent:0,projectPathForJob:()=>repo.path});
    const result=await reconciler.reconcile('local-job');
    assert.equal(result.state,'COMPLETED');
    const head=repo.git('rev-parse','main');
    db.close();db=new SQLiteRelayStore(dbPath);
    store=makeStore();
    const rebooted=managedReconciler(store,{owner:'restart-test-2',adapters:[],
      noGitHub:true,maxConcurrent:0,projectPathForJob:()=>repo.path});
    await rebooted.reconcile('local-job');
    assert.equal(repo.git('rev-parse','main'),head);
    assert.equal((await store.load('local-job')).localMerge.mergedCommitSha,head);
  } finally {db.close();repo.close();}
});

test('non-code local artifacts complete without a Git merge; code jobs cannot',async()=>{
  const {db,store}=fixture();
  try {
    await store.saveJob(job([{...task(),output:{kind:'file',path:'runs/result.md'}}]));
    const reconciler=managedReconciler(store,{owner:'noncode-test',adapters:[],
      noGitHub:true,maxConcurrent:0,projectPathForJob:()=>process.cwd()});
    assert.equal((await reconciler.reconcile('local-job')).state,'COMPLETED');
    assert.equal(await db.pendingProjectionCount(),0);
  } finally {db.close();}
  const second=fixture();
  try {
    await second.store.saveJob(job([{...task(),output:{kind:'task_pr'}}]));
    const reconciler=managedReconciler(second.store,{owner:'unconfigured-code-test',adapters:[],
      noGitHub:true,maxConcurrent:0,projectPathForJob:()=>process.cwd()});
    assert.equal((await reconciler.reconcile('local-job')).state,'ACTIVE');
    assert.equal((await second.store.load('local-job')).localMerge,undefined);
  } finally {second.db.close();}
});
test('UNKNOWN GitHub state continues dispatch after a previous local Task succeeds',async()=>{
  const {db,store}=fixture();
  try {
    const first={...task(),id:'prior',state:'SUCCEEDED'};
    const next={...task('QUEUED'),id:'next',dependencies:['prior'],output:{kind:'file',path:'runs/next.md'}};
    await store.saveJob(job([first,next]));
    const reconciler=managedReconciler(store,{owner:'unknown-continuation',adapters:[],
      maxConcurrent:2,projectPathForJob:()=>process.cwd()});
    await reconciler.reconcile('local-job');
    const saved=await store.load('local-job');
    assert.notEqual(saved.tasks.find(t=>t.id==='next').state,'QUEUED');
    assert.equal(saved.tasks.find(t=>t.id==='prior').state,'SUCCEEDED');
    assert.equal(await store.pullRequestState(),'UNKNOWN');
  } finally {db.close();}
});

test('durable CLI requires relay service while explicit --file demo remains local',()=>{
  const repo=localRepository();
  const home=mkdtempSync(join(tmpdir(),'relay-cli-home-'));
  const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
  const env={...process.env,HOME:home};
  try {
    assert.throws(()=>execFileSync(process.execPath,[cli,'--no-github','job','create','--id','e2e-cli','--title','Offline Job','--objective','Local merge','--host','127.0.0.1','--port','1'],{cwd:repo.path,env,encoding:'utf8',timeout:5000}),/service unavailable|ECONNREFUSED/);
    const file=join(home,'demo.json');
    execFileSync(process.execPath,[cli,'--no-github','init','--file',file,'--id','demo','--title','Demo'],{cwd:repo.path,env,encoding:'utf8',timeout:5000});
    assert.equal(JSON.parse(readFileSync(file,'utf8')).id,'demo');
  } finally { repo.close();rmSync(home,{recursive:true,force:true}); }
});

test('UNKNOWN PR never masks local RUNNING, QUEUED, or terminal status on Dashboard',()=>{
  assert.equal(deriveJobRuntimeStatus(job([task('QUEUED')]),'UNKNOWN'),'QUEUED');
  assert.equal(deriveJobRuntimeStatus(job([task('RUNNING')]),'UNKNOWN'),'RUNNING');
  assert.equal(deriveJobRuntimeStatus({...job(),state:'COMPLETED'},'UNKNOWN'),'COMPLETED');
  assert.equal(deriveJobRuntimeStatus({...job(),localMerge:{...mergeRefs}},'UNKNOWN'),'MERGE_PENDING');
});

test('local merge respects autoMerge=false and never mutates target ref',async()=>{
  const repo=localRepository();
  const {db,store}=fixture();
  try{
    const target=repo.git('rev-parse','refs/heads/main');
    await store.saveJob({...job(),autoMerge:false,localMerge:{...mergeRefs}});
    const reconciler=managedReconciler(store,{owner:'local-auto-merge-optout',adapters:[],
      noGitHub:true,maxConcurrent:0,projectPathForJob:()=>repo.path});
    const result=await reconciler.reconcile('local-job');
    assert.equal(result.state,'ACTIVE');
    assert.equal(result.localMerge.status,'pending');
    assert.equal(repo.git('rev-parse','refs/heads/main'),target);
  } finally {db.close();repo.close();}
});

test('local merge retry refreshes a stale source SHA and succeeds on the new commit',async()=>{
  const repo=localRepository();
  const {db,store}=fixture();
  try{
    const stale=repo.head;
    repo.git('checkout','feature');
    writeFileSync(join(repo.path,'retry.txt'),'new source');
    repo.git('add','retry.txt');repo.git('commit','-m','advance before retry');
    repo.git('checkout','--detach');
    const fresh=repo.git('rev-parse','refs/heads/feature');
    assert.notEqual(fresh,stale);
    await store.saveJob({...job(),headSha:stale,localMerge:{...mergeRefs,sourceSha:stale,status:'failed',
      attempts:1,nextAttemptAt:'2020-01-01T00:00:00.000Z',error:'previous transient failure'}});
    const reconciler=managedReconciler(store,{owner:'refresh-local-merge-sha',adapters:[],
      noGitHub:true,maxConcurrent:0,projectPathForJob:()=>repo.path});
    const result=await reconciler.reconcile('local-job');
    assert.equal(result.state,'COMPLETED');
    assert.equal(result.localMerge.sourceSha,fresh);
    assert.equal(result.localMerge.status,'succeeded');
    assert.equal(result.localMerge.mergedCommitSha,repo.git('rev-parse','refs/heads/main'));
  } finally {db.close();repo.close();}
});

test('Review delivery merges into main while main remains checked out and stays synchronized',()=>{
  const repo=localRepository();
  try {
    repo.git('checkout','main');
    const result=deliverLocalMerge(repo.path,{...mergeRefs,sourceSha:repo.head});
    assert.equal(repo.git('symbolic-ref','HEAD'),'refs/heads/main');
    assert.equal(repo.git('rev-parse','HEAD'),result.mergedCommitSha);
    assert.equal(repo.git('rev-parse','refs/heads/main'),result.mergedCommitSha);
    assert.equal(repo.git('status','--porcelain'),'');
    assert.equal(repo.git('show','HEAD:feature.txt'),'feature');
    assert.equal(deliverLocalMerge(repo.path,{...mergeRefs,sourceSha:repo.head}).mergedCommitSha,result.mergedCommitSha);
  } finally {repo.close();}
});

test('checked-out main refuses tracked dirty target without modifying any ref or file',()=>{
  const repo=localRepository();
  try {
    repo.git('checkout','main');
    const prior=repo.git('rev-parse','main');
    writeFileSync(join(repo.path,'base.txt'),'tracked local change');
    assert.throws(()=>deliverLocalMerge(repo.path,{...mergeRefs,sourceSha:repo.head}),/tracked or index changes/);
    assert.equal(repo.git('rev-parse','HEAD'),prior);
    assert.equal(repo.git('rev-parse','main'),prior);
    assert.equal(readFileSync(join(repo.path,'base.txt'),'utf8'),'tracked local change');
  } finally {repo.close();}
});



test('checked-out main merge ignores unrelated untracked files',()=>{
  const repo=localRepository();
  try {
    repo.git('checkout','main');
    writeFileSync(join(repo.path,'notes.local'),'keep me');
    const result=deliverLocalMerge(repo.path,{...mergeRefs});
    assert.equal(result.mergedCommitSha,repo.git('rev-parse','main'));
    assert.equal(readFileSync(join(repo.path,'notes.local'),'utf8'),'keep me');
  } finally {repo.close();}
});

test('checked-out main merge refuses incoming path collision with untracked file',()=>{
  const repo=localRepository();
  try {
    repo.git('checkout','feature');
    writeFileSync(join(repo.path,'incoming-only.txt'),'from feature');
    repo.git('add','incoming-only.txt');repo.git('commit','-m','incoming path');
    repo.git('checkout','main');
    writeFileSync(join(repo.path,'incoming-only.txt'),'local untracked');
    const prior=repo.git('rev-parse','main');
    assert.throws(()=>deliverLocalMerge(repo.path,{...mergeRefs}),/untracked|would be overwritten|merge|exit/i);
    assert.equal(repo.git('rev-parse','main'),prior);
    assert.equal(readFileSync(join(repo.path,'incoming-only.txt'),'utf8'),'local untracked');
  } finally {repo.close();}
});

test('checked-out main merge conflict leaves clean main and persists no false merge',()=>{
  const repo=localRepository();
  try {
    repo.git('checkout','feature');
    writeFileSync(join(repo.path,'base.txt'),'source conflict');
    repo.git('add','base.txt');repo.git('commit','-m','conflicting source');
    repo.git('checkout','main');
    writeFileSync(join(repo.path,'base.txt'),'main conflict');
    repo.git('add','base.txt');repo.git('commit','-m','conflicting main');
    const prior=repo.git('rev-parse','main');
    assert.throws(()=>deliverLocalMerge(repo.path,{...mergeRefs}),/CONFLICT|merge|exit/i);
    assert.equal(repo.git('rev-parse','main'),prior);
    assert.equal(repo.git('rev-parse','HEAD'),prior);
    assert.equal(repo.git('status','--porcelain'),'');
    assert.equal(repo.git('show','HEAD:base.txt'),'main conflict');
  } finally {repo.close();}
});

test('Graph completes code Job only after merge into checked-out main',async()=>{
  const repo=localRepository();
  const {db,store}=fixture();
  try {
    repo.git('checkout','main');
    await store.saveJob({...job(),localMerge:{...mergeRefs}});
    const reconciler=managedReconciler(store,{owner:'main-checkedout-graph',adapters:[],
      noGitHub:true,maxConcurrent:0,projectPathForJob:()=>repo.path});
    const result=await reconciler.reconcile('local-job');
    assert.equal(result.state,'COMPLETED');
    assert.equal(result.localMerge.status,'succeeded');
    assert.equal(result.localMerge.mergedCommitSha,repo.git('rev-parse','main'));
    assert.equal(repo.git('rev-parse','HEAD'),repo.git('rev-parse','main'));
    const second=await reconciler.reconcile('local-job');
    assert.equal(second.localMerge.mergedCommitSha,result.localMerge.mergedCommitSha);
  } finally {db.close();repo.close();}
});


test('two separate processes serialize local merges into checked-out main', async()=>{
  const repo=localRepository();
  try {
    repo.git('checkout','main');
    repo.git('branch','feature-two',repo.git('rev-parse','main'));
    repo.git('checkout','feature-two');
    writeFileSync(join(repo.path,'second.txt'),'second');
    repo.git('add','second.txt');repo.git('commit','-m','second feature');
    repo.git('checkout','main');
    const modulePath=new URL('../dist/local-git-merge.js',import.meta.url).href;
    const {spawn}=await import('node:child_process');
    const child=(branch)=>new Promise((resolve,reject)=>{
      const source='import {deliverLocalMerge} from '+JSON.stringify(modulePath)+';'+
        'const result=deliverLocalMerge(process.argv[1],{sourceRef:process.argv[2],targetRef:"refs/heads/main",status:"pending"});console.log(JSON.stringify(result));';
      const proc=spawn(process.execPath,['--input-type=module','-e',source,repo.path,'refs/heads/'+branch]);
      let stdout='',stderr='';
      proc.stdout.on('data',d=>stdout+=d);proc.stderr.on('data',d=>stderr+=d);
      proc.on('error',reject);
      proc.on('close',code=>code===0?resolve(JSON.parse(stdout)):reject(new Error(stderr)));
    });
    const [a,b]=await Promise.all([child('feature'),child('feature-two')]);
    const head=repo.git('rev-parse','main');
    assert.equal(repo.git('rev-parse','HEAD'),head);
    assert.equal(repo.git('show','HEAD:feature.txt'),'feature');
    assert.equal(repo.git('show','HEAD:second.txt'),'second');
    assert.equal(repo.git('status','--porcelain'),'');
    assert.ok(a.mergedCommitSha && b.mergedCommitSha);
  } finally {repo.close();}
});

test('dead cross-process lock recovers but a preexisting manual MERGE_HEAD is never aborted',async()=>{
  const repo=localRepository();
  try{
    repo.git('checkout','main');
    const {withLocalMergeLock}=await import('../dist/local-merge-lock.js');
    const {spawn}=await import('node:child_process');
    const source='import {withLocalMergeLock} from '+JSON.stringify(new URL('../dist/local-merge-lock.js',import.meta.url).href)+
      ';withLocalMergeLock(process.argv[1],"refs/heads/main",()=>{console.log("LOCKED");while(true){};});';
    const common=repo.git('rev-parse','--git-common-dir');
    const child=spawn(process.execPath,['--input-type=module','-e',source,join(repo.path,common)]);
    await new Promise((resolve,reject)=>{
      let received='';
      child.stdout.on('data',d=>{received+=d;if(received.includes('LOCKED'))resolve();});
      child.on('error',reject);
    });
    child.kill('SIGKILL');
    await new Promise(resolve=>child.once('close',resolve));
    const result=deliverLocalMerge(repo.path,{...mergeRefs,sourceSha:repo.head});
    assert.equal(result.mergedCommitSha,repo.git('rev-parse','main'));
    // A user-started conflict is not a Relay-owned merge and must be preserved.
    repo.git('checkout','feature');
    writeFileSync(join(repo.path,'base.txt'),'source conflict');
    repo.git('add','base.txt');repo.git('commit','-m','conflict source');
    repo.git('checkout','main');
    writeFileSync(join(repo.path,'base.txt'),'manual main conflict');
    repo.git('add','base.txt');repo.git('commit','-m','manual target');
    assert.throws(()=>repo.git('merge','feature'));
    const before=repo.git('rev-parse','HEAD');
    assert.throws(()=>deliverLocalMerge(repo.path,{...mergeRefs}),/MERGE_HEAD|not clean|tracked or index changes/);
    assert.equal(repo.git('rev-parse','HEAD'),before);
    assert.ok(repo.git('rev-parse','--verify','MERGE_HEAD'));
  } finally {repo.close();}
});

test('multiple contenders safely reclaim one dead merge lock without overlapping critical sections', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-merge-recovery-race-'));
  const { createHash } = await import('node:crypto');
  const { mkdirSync } = await import('node:fs');
  const { hostname } = await import('node:os');
  const { spawn } = await import('node:child_process');
  try {
    const target = 'refs/heads/main';
    const digest = createHash('sha256').update(target).digest('hex').slice(0, 24);
    const lockDir = join(root, `agents-relay-merge-${digest}.lockdir`);
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({pid:99999999,host:hostname(),startedAt:'2026-01-01T00:00:00Z',targetRef:target}));
    const moduleUri = new URL('../dist/local-merge-lock.js', import.meta.url).href;
    const program = 'import {withLocalMergeLock} from ' + JSON.stringify(moduleUri) +
      ';import {openSync,closeSync,unlinkSync} from "node:fs";import {join} from "node:path";'+
      'withLocalMergeLock(process.argv[1],"refs/heads/main",()=>{'+
      'const marker=join(process.argv[1],"critical-section");'+
      'const fd=openSync(marker,"wx");console.log("ENTER");'+
      'const end=Date.now()+120;while(Date.now()<end){};'+
      'closeSync(fd);unlinkSync(marker);console.log("EXIT");},5000);';
    const outcomes = await Promise.all(Array.from({length:4},()=>new Promise((resolve,reject)=>{
      const child = spawn(process.execPath,['--input-type=module','-e',program,root]);
      let data=''; child.stdout.on('data',chunk=>data+=chunk);
      child.stderr.on('data',chunk=>data+=chunk);
      child.on('error',reject);
      child.on('close',code=>code===0?resolve(data):reject(new Error(data)));
    })));
    assert.equal(outcomes.length,4);
    assert.ok(outcomes.every(item=>item.includes('ENTER') && item.includes('EXIT')));
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('crash before lock owner and crash during recovery guard initialize are recoverable', async () => {
  const {createHash}=await import('node:crypto');
  const {mkdirSync,utimesSync,statSync}=await import('node:fs');
  const {withLocalMergeLock}=await import('../dist/local-merge-lock.js');
  const root=mkdtempSync(join(tmpdir(),'relay-incomplete-merge-lock-'));
  try {
    const lock=join(root,'agents-relay-merge-'+createHash('sha256').update('refs/heads/main').digest('hex').slice(0,24)+'.lockdir');
    mkdirSync(lock);
    mkdirSync(lock+'.recovery');
    const old=new Date(Date.now()-15000);
    utimesSync(lock,old,old);
    utimesSync(lock+'.recovery',old,old);
    let executed=0;
    withLocalMergeLock(root,'refs/heads/main',()=>{executed++;},12000);
    assert.equal(executed,1);
    assert.throws(()=>statSync(lock),{code:'ENOENT'});
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('authoritative local merge completion never enqueues a second GitHub merge decision', async()=>{
  const repo=localRepository();
  const db=new SQLiteRelayStore(':memory:');
  const remote=new (await import('../dist/store.js')).InMemoryStore();
  let merges=0;
  remote.mergePullRequest=async()=>{merges+=1;};
  const store=new LocalAuthorityDurableStore(db,remote,undefined,false);
  try {
    await store.saveJob({...job(),prNumber:77,headSha:repo.head,localMerge:{...mergeRefs}});
    await store.applyPullRequestFacts({state:'OPEN',head:{ref:'feature',sha:repo.head},observedAt:timestamp()});
    const reconciler=managedReconciler(store,{owner:'external-merge-after-local',adapters:[],noGitHub:false,maxConcurrent:0,projectPathForJob:()=>repo.path});
    const completed=await reconciler.reconcile('local-job');
    assert.equal(completed.state,'COMPLETED');
    const durable=await store.load('local-job');
    assert.equal(durable.state,'COMPLETED');
    assert.equal(durable.localMerge?.projectionStrategy,'target_ref_push');
    assert.equal(merges,0,'successful local merge must not ask GitHub to independently re-merge');
    assert.equal(await db.pendingProjectionCount(),0,'target-ref projection is service-owned and no merge_pull_request outbox row is allowed');
    await reconciler.close();
  } finally {db.close();repo.close();}
});

test('external merge enqueue failure cannot roll back authoritative local completion', async()=>{
  const repo=localRepository();
  const base=new InMemoryStore({...job(),prNumber:88,headSha:repo.head,localMerge:{...mergeRefs}});
  base.mergePullRequest=async()=>{throw new Error('projection transport unavailable');};
  const reconciler=managedReconciler(base,{owner:'external-merge-isolation',adapters:[],noGitHub:false,maxConcurrent:0,projectPathForJob:()=>repo.path});
  try {
    const completed=await reconciler.reconcile('local-job');
    assert.equal(completed.state,'COMPLETED');
    assert.equal((await base.load('local-job')).state,'COMPLETED');
    assert.equal((await base.load('local-job')).localMerge.status,'succeeded');
  } finally {await reconciler.close();repo.close();}
});

test('local merge failure records reason and retry, then emits a successful recovery', async()=>{
  const {reconcileLocalGitCompletion}=await import('../dist/local-merge-delivery.js');
  const repo=localRepository(); const {db,store}=fixture(); const events=[];
  try {
    repo.git('checkout','main');
    writeFileSync(join(repo.path,'base.txt'),'dirty tracked main');
    await store.saveJob({...job(),headSha:repo.head,localMerge:{...mergeRefs,sourceSha:repo.head}});
    const emit=async event=>{events.push(event)};
    let state=await store.load('local-job');
    assert.equal(await reconcileLocalGitCompletion(store,state,repo.head,true,()=>repo.path,emit),false);
    state=await store.load('local-job');
    assert.equal(state.localMerge.status,'failed');
    assert.match(state.localMerge.error,/tracked or index changes/);
    assert.ok(state.localMerge.nextAttemptAt);
    assert.equal(events.length,1);
    assert.equal(events[0].type,'job.merge.failed');
    assert.equal(events[0].data.reason,'dirty_target_worktree');
    assert.equal(events[0].data.retryable,true);
    assert.equal(events[0].data.nextAttemptAt,state.localMerge.nextAttemptAt);
    repo.git('checkout','--','base.txt');
    await new Promise(resolve=>setTimeout(resolve,2200));
    state=await store.load('local-job');
    const recovered=await reconcileLocalGitCompletion(store,state,repo.head,true,()=>repo.path,emit);
    assert.equal(recovered,true,JSON.stringify((await store.load('local-job')).localMerge));
    assert.equal(events[1].type,'job.merge.succeeded');
    assert.equal((await store.load('local-job')).state,'COMPLETED');
  } finally {db.close();repo.close()}
});
