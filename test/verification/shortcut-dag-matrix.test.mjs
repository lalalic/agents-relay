/** Explicit, offline Shortcut Runner release gates: npm run test:shortcut:dags.
 * These intentionally fail when a required mixed-node capability is absent.
 * All SQLite and shortcut modules live in OS temp directories; no provider,
 * global queue, production Job, real video, or external event transport. */
import test from '../test-runtime.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentGraph } from '../../dist/agent-graph.js';
import { SQLiteRelayStore } from '../../dist/relay-store.js';
import { createJobEntity, createTaskEntity } from '../../dist/workflow/entity-creation.js';
import { applyJobActivateAction } from '../../dist/job-actions.js';
import { shortcutContentSha256 } from '../../dist/agent-shortcut.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = fileURLToPath(new URL('../fixtures/shortcut-dags/', import.meta.url));
const cases = JSON.parse(await readFile(join(fixtures, 'cases.json'), 'utf8')).cases;
const caseById = id => {const entry=cases.find(item=>item.id===id);assert.ok(entry,`missing case ${id}`);return entry;};

async function fixture(t,id) {
  const entry=caseById(id);
  const graph=await readFile(join(fixtures,entry.graph),'utf8');
  parseAgentGraph(graph);
  const directory=await mkdtemp(join(tmpdir(),`shortcut-${id}-`));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const project=join(directory,'project'),neo=join(directory,'neo'),storeDir=join(directory,'stores');
  for(const path of [join(project,'agents','.shortcut'),join(neo,'agents','.shortcut'),storeDir])await mkdir(path,{recursive:true});
  const jobId='99901';
  const now=new Date().toISOString();
  const job=createJobEntity({id:jobId,title:`${id} offline`,objective:'offline contract verification',projectPath:undefined,
    prNumber:0,repository:'local/shortcut-test',continuation:null,autoMerge:false,reviewEnabled:false,
    contentOnly:true,executionMode:'shortcut',createdAt:now,updatedAt:now,tasks:[]});
  await applyJobActivateAction(job);
  job.tasks.push(createTaskEntity(job,{jobId,id:'initial',title:id,kind:'work',agentGraph:graph,
    parentTaskId:null,dependencies:[],capabilities:[],adapter:'codex',input:'offline synthetic input',
    output:{kind:'file',path:join(directory,'result.json')},attempt:0,maxAttempts:3,
    leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:null,timeoutMs:300000,
    createdAt:now,updatedAt:now}));
  const store=new SQLiteRelayStore(join(directory,'relay.sqlite'),jobId);
  try { await store.createJobIfAbsent(job); } finally { store.close(); }
  const module=async(agent,source)=>{
    await writeFile(join(project,'agents',`${agent}.agent.md`),`---\nname: ${agent}\n---\n# ${agent}\n`);
    await writeFile(join(project,'agents','.shortcut',`${agent}.agent.mjs`),source);
  };
  const run=(...args)=>spawnSync(process.execPath,[join(root,'dist','cli.js'),'job','run','--mode','shortcut',
    '--id',jobId,'--repo','local/shortcut-test','--no-github','--store-dir',storeDir,
    '--task-id','initial','--project-path',project,'--shared-root',neo,...args],
    {encoding:'utf8',timeout:10000,env:{...process.env,AGENTS_RELAY_STORE_DIR:storeDir,AGENTS_RELAY_NO_GITHUB:'1'}});
  const receipt=(...args)=>spawnSync(process.execPath,[join(root,'dist','cli.js'),'job','shortcut-receipt',
    '--id',jobId,'--repo','local/shortcut-test','--no-github','--store-dir',storeDir,
    '--task-id','initial',...args],{encoding:'utf8',timeout:10000,
    env:{...process.env,AGENTS_RELAY_STORE_DIR:storeDir,AGENTS_RELAY_NO_GITHUB:'1'}});
  const load=async()=>{const db=new SQLiteRelayStore(join(directory,'relay.sqlite'),jobId);
    try{return await db.loadJob(jobId);}finally{db.close();}};
  const mutate=async(change)=>{const db=new SQLiteRelayStore(join(directory,'relay.sqlite'),jobId);
    try{return await db.mutateJob(jobId,change);}finally{db.close();}};
  return {entry,directory,project,module,run,receipt,load,mutate};
}
const completed=output=>`export async function run({input}) {return {status:'COMPLETED',output:${JSON.stringify(output)},artifacts:[]};}`;

test('D01: code fork/join executes parallel branches once and passes only direct predecessor data',async t=>{
  const f=await fixture(t,'D01');
  await f.module('source',completed({origin:'source'}));
  for(const [agent,other] of [['left','right'],['right','left']]){
    await f.module(agent,`import {writeFile,access} from 'node:fs/promises';
      import {join} from 'node:path';
      export async function run({input}){
        if(Object.keys(input.predecessorOutputs).join(',')!=='S')throw Error('left/right predecessor leak');
        await writeFile(join(${JSON.stringify(f.directory)},'${agent}.ready'),'1');
        let simultaneous=false;
        for(let i=0;i<150;i++){
          try{await access(join(${JSON.stringify(f.directory)},'${other}.ready'));simultaneous=true;break;}catch{}
          await new Promise(r=>setTimeout(r,3));
        }
        if(!simultaneous)throw Error('fork did not run concurrently');
        return {status:'COMPLETED',output:{branch:'${agent}'},artifacts:[]};
      }`);
  }
  await f.module('join',`export async function run({input}){
    if(Object.keys(input.predecessorOutputs).sort().join(',')!=='A,B')throw Error('join got non-parent data');
    if(input.predecessorOutputs.A.branch!=='left'||input.predecessorOutputs.B.branch!=='right')throw Error('wrong parent data');
    return {status:'COMPLETED',output:{joined:true},artifacts:[]};
  }`);
  const run=f.run('--concurrency','2');
  assert.equal(run.status,0,run.stderr);
  const job=await f.load(), task=job.tasks[0];
  assert.equal(job.state,'COMPLETED');assert.equal(task.state,'SUCCEEDED');
  assert.equal(Object.keys(task.result.data.shortcut.nodes).length,4);
  assert.match(run.stderr,/"nodeId":"J","type":"completed"/);
});

test('D02: code -> model -> code must not bypass code nodes when Worker module is missing (T004)',async t=>{
  const f=await fixture(t,'D02');
  const marker=join(f.directory,'source-ran');
  await f.module('source',`import {writeFile} from 'node:fs/promises';export async function run(){await writeFile(${JSON.stringify(marker)},'1');return {status:'COMPLETED',output:{token:'A'},artifacts:[]};}`);
  await f.module('finish',completed({last:true}));
  const run=f.run('--events','none');
  const task=(await f.load()).tasks[0];
  assert.ok(existsSync(marker),`FR-004: code node A must execute before the unavailable model node; currently Task=${task.state}, workerFallback=${task.result?.data?.shortcut?.workerFallback}, CLI=${run.stderr.slice(-500)}`);
  assert.equal(task.result?.data?.shortcut?.nodes?.A?.output?.token,'A');
});

test('D03: independent code branch must execute while parallel model branch is pending (T004)',async t=>{
  const f=await fixture(t,'D03');
  const marker=join(f.directory,'code-ran');
  await f.module('code',`import {writeFile} from 'node:fs/promises';export async function run(){await writeFile(${JSON.stringify(marker)},'done');return {status:'COMPLETED',output:{ok:true},artifacts:[]};}`);
  await f.module('join',completed({join:true}));
  const run=f.run('--events','none');
  const task=(await f.load()).tasks[0];
  assert.ok(existsSync(marker),`FR-006: parallel code branch must progress independently of missing model; workerFallback=${task.result?.data?.shortcut?.workerFallback}, CLI=${run.stderr.slice(-500)}`);
  assert.equal(task.result?.data?.shortcut?.nodes?.A?.output?.ok,true);
});

test('D04: wait preserves independent branch and resumes on exact durable receipt once',async t=>{
  const f=await fixture(t,'D04');
  const payload={status:'COMPLETED',output:{accepted:true},artifacts:[]};
  const contentHash=shortcutContentSha256(payload);
  await f.module('waiter',`export async function run(){return {status:'WAITING_EVENT',event:{kind:'nonhuman_result',nodeId:'W',id:'v1',revision:'r1',contentHash:${JSON.stringify(contentHash)}}};}`);
  const marker=join(f.directory,'independent-runs');
  await f.module('independent',`import {appendFile} from 'node:fs/promises';export async function run(){await appendFile(${JSON.stringify(marker)},'x');return {status:'COMPLETED',output:{ready:true},artifacts:[]};}`);
  await f.module('join',`export async function run({input}){if(!input.predecessorOutputs.W.accepted||!input.predecessorOutputs.I.ready)throw Error('missing predecessor');return {status:'COMPLETED',output:{joined:true},artifacts:[]};}`);
  const first=f.run();assert.equal(first.status,3,first.stderr);
  const waiting=await f.load();assert.equal(waiting.tasks[0].state,'RUNNING');
  assert.equal(await readFile(marker,'utf8'),'x');
  const file=join(f.directory,'receipt.json');await writeFile(file,JSON.stringify(payload));
  const receipt=f.receipt('--node-id','W','--wait-id','v1','--revision','r1',
    '--execution-id',waiting.tasks[0].executionId,'--output-file',file,'--content-sha256',contentHash);
  assert.equal(receipt.status,0,receipt.stderr);
  const resumed=f.run();assert.equal(resumed.status,0,resumed.stderr);
  const final=await f.load();assert.equal(final.state,'COMPLETED');
  assert.equal(final.tasks[0].result.data.shortcut.nodes.J.output.joined,true);
  assert.equal(await readFile(marker,'utf8'),'x','independent branch must not replay');
});

test('D05: invalid shortcut output fails closed without running successor or Worker fallback',async t=>{
  const f=await fixture(t,'D05');
  await f.module('source',completed({source:true}));
  await f.module('invalid',`export async function run(){return {status:'COMPLETED',output:null,artifacts:[]};}`);
  const marker=join(f.directory,'finish-ran');
  await f.module('finish',`import {writeFile} from 'node:fs/promises';export async function run(){await writeFile(${JSON.stringify(marker)},'bad');return {status:'COMPLETED',output:{bad:true},artifacts:[]};}`);
  const result=f.run();assert.equal(result.status,1,result.stderr);
  const task=(await f.load()).tasks[0];
  assert.equal(task.state,'FAILED');assert.equal(task.result?.data?.shortcut?.workerFallback,undefined);
  assert.equal(existsSync(marker),false);
});
