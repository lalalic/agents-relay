// Head-to-head Node/Rust: src/task-context.ts and src/publication-store.ts; no production Job changes, all publication data in isolated SQLite memory.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {taskExecutionContext,taskAgentHistoryContext,taskReferencePrompt} from '../../dist/task-context.js';
import {recordPublicationInDatabase,loadPublicationFromDatabase,listPublicationEventsFromDatabase} from '../../dist/publication-store.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let compiled=false;
function rust(req){if(!compiled){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);compiled=true;}
 const r=spawnSync(bin,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:15000,maxBuffer:6*1024*1024});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim());}
function node(req){try{let value;
 if(req.op==='taskExecutionContext')value=taskExecutionContext(req.job,req.taskId,req.executionId);
 else if(req.op==='taskAgentHistoryContext')value=taskAgentHistoryContext(req.job,req.task);
 else if(req.op==='taskReferencePrompt')value=taskReferencePrompt(req.repository,req.jobId,req.taskId,req.executionId,req.managedInput);
 else if(req.op==='publicationStoreScenario'){
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE publication_state(job_id TEXT PRIMARY KEY,json TEXT NOT NULL);CREATE TABLE publication_delivery (job_id TEXT NOT NULL,delivery_id TEXT NOT NULL,type TEXT NOT NULL,json TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(job_id,delivery_id));');
  const operations=[];
  for(const op of req.operations){try{
   let result;
   if(op.action==='load')result=loadPublicationFromDatabase(db,op.jobId);
   else if(op.action==='list')result=listPublicationEventsFromDatabase(db,op.jobId);
   else result=recordPublicationInDatabase(db,op.jobId,op.deliveryId,op.publication??null,op.failure??null,op.observedAt);
   operations.push({ok:true,value:result});
  }catch(error){operations.push({ok:false,error:error.message});}}
  const states=db.prepare('SELECT job_id,json FROM publication_state ORDER BY job_id').all().map(row=>({jobId:row.job_id,json:row.json}));
  const deliveries=db.prepare('SELECT job_id,delivery_id,type,json,observed_at FROM publication_delivery ORDER BY job_id,delivery_id').all().map(row=>({jobId:row.job_id,deliveryId:row.delivery_id,type:row.type,json:row.json,observedAt:row.observed_at}));
  db.close();value={operations,states,deliveries};
 }return {ok:true,value:JSON.parse(JSON.stringify(value))};
 }catch(e){return {ok:false,error:e.message}}}
let seed=0x13432123;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n},pick=a=>a[rand(a.length)];
const contextCases=[];
for(let i=0;i<950;i++){
 const taskId=`task-${i}`,executionId=`exec-${i}`;
 const dependencies=Array.from({length:rand(5)},(_,j)=>`dep-${j}`);
 const primary={id:taskId,agentName:pick(['worker','troubleshooter','reviewer','job-acceptance-reviewer']),kind:'work',title:'Main task',state:pick(['RUNNING','QUEUED','FAILED']),
  dependencies,executionId:pick([executionId,'old',null]),planningDecisionId:pick(['p1','p2',undefined]),parentTaskId:'dep-0',attempt:1,
  resolution:pick([null,undefined,{state:'resolved',reason:'ok'}]),escalation:pick([null,undefined,{id:'escalation'}]),comments:pick([undefined,[],[{id:'c1',text:'prior'}]])};
 const job={id:`j-${i}`,repository:'repo',state:'ACTIVE',title:'Project',objective:'Complete',
  tasks:[primary,...Array.from({length:rand(5)},(_,j)=>({id:`dep-${j}`,state:pick(['SUCCEEDED','FAILED']),title:'Dependency',agentName:'worker',attempt:1,executionId:'ee',result:pick([undefined,{summary:'done'}]),comments:pick([undefined,[{id:'x',text:'keep'}]])}))],
  plans:[{id:'p1',round:1,assessment:'plan'}]};
 contextCases.push({op:'taskExecutionContext',job,taskId,executionId});
 contextCases.push({op:'taskAgentHistoryContext',job,task:primary});
 if(i%5===0)contextCases.push({op:'taskReferencePrompt',repository:'repo',jobId:job.id,taskId,executionId,
   managedInput:pick([undefined,'[Required event contracts] required','not included'])});
}
test('Task context, reviewer history and managed execution reference prompts match Node',()=>{
 for(const [i,req] of contextCases.entries())assert.deepEqual(rust(req),node(req),`Task context ${i}: ${JSON.stringify(req).slice(0,350)}`);
 console.log(`Verified ${contextCases.length} Node/Rust Task execution/historical context and prompt fixtures`);
});
const publicationCases=[];
for(let i=0;i<285;i++){
 const operations=[];
 for(let j=0;j<1+rand(16);j++){
  const jobId=pick(['job-1','job-2','job-3']);
  const observedAt=`2026-11-${String(10+rand(8))}T${String(rand(24)).padStart(2,'0')}:00:00.000Z`;
  const publication=pick([undefined,{package:'agents-relay',version:`1.0.${j}`,registry:'https://registry.npmjs.org',sha:`sha-${j}`}]);
  const failure=pick([undefined,undefined,{runId:String(j+1),attempt:j+1,stage:'publish',sha:'abc'}]);
  const action=pick(['record','record','record','load','list']);
  operations.push({action,jobId,deliveryId:pick([`d-${j}`,`d-${rand(5)}`]),publication,failure,observedAt});
 }
 publicationCases.push({op:'publicationStoreScenario',operations});
}
test('publication delivery dedupe, monotonic state and ordered SQLite event history match Node',()=>{
 for(const [i,req] of publicationCases.entries()){
  const actual=rust(req),expected=node(req);
  if(actual.ok&&expected.ok){
   const normalized=r=>({...r,states:r.states.map(row=>({...row,json:JSON.parse(row.json)})),deliveries:r.deliveries.map(row=>({...row,json:JSON.parse(row.json)}))});
   assert.deepEqual(normalized(actual.value),normalized(expected.value),`publication ${i}`);
  }else assert.deepEqual(actual,expected,`publication ${i}`);
 }
 console.log(`Verified ${publicationCases.length} complete in-memory SQLite publication state histories`);
});
