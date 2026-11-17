// Direct Node/Rust differential for src/relay-job-merge.ts, src/store-task-definition.ts and src/relay-create.ts, using isolated in-memory SQLite and immutable Job fixtures.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {mergeInboundJobSnapshot} from '../../dist/relay-job-merge.js';
import {createJobIfAbsent} from '../../dist/relay-create.js';
import {sameTaskDefinition,samePlanDefinition,taskDefinitionDivergence,planDefinitionDivergence,divergingDefinitionFields,isTaskForJob,isDurableDefinitionConflict} from '../../dist/store-task-definition.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let compiled=false;
function rust(req){if(!compiled){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);compiled=true;}
 const r=spawnSync(bin,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:15000,maxBuffer:6*1024*1024});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim());}
function node(req){try{let value;
 switch(req.op){case 'mergeInboundJobSnapshot':value=mergeInboundJobSnapshot(structuredClone(req.local),structuredClone(req.remote));break;
 case 'sameTaskDefinition':value=sameTaskDefinition(req.left,req.right);break;
 case 'samePlanDefinition':value=samePlanDefinition(req.left,req.right);break;
 case 'taskDefinitionDivergence':value=taskDefinitionDivergence(req.left,req.right);break;
 case 'planDefinitionDivergence':value=planDefinitionDivergence(req.left,req.right);break;
 case 'divergingDefinitionFields':value=divergingDefinitionFields(req.kind,req.left,req.right);break;
 case 'isTaskForJob':value=isTaskForJob(req.task,req.jobId,req.soleTrustedJob);break;
 case 'isDurableDefinitionConflict':value=isDurableDefinitionConflict(req.error);break;
 case 'relayCreateScenario':{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);');
  for(const row of req.existing)db.prepare('INSERT INTO job_snapshot VALUES (?,?,?)').run(row.jobId,row.json,'preexisting');
  const results=[];
  for(const job of req.jobs){try{results.push({ok:true,value:createJobIfAbsent(db,job)});}catch(e){results.push({ok:false,error:e.message});}}
  const rows=db.prepare('SELECT job_id,json FROM job_snapshot ORDER BY job_id').all().map(row=>({jobId:row.job_id,json:row.json}));
  db.close();value={results,rows};break;
 }
 default:throw Error('unknown op '+req.op);
 }
 return {ok:true,value:JSON.parse(JSON.stringify(value))};}catch(e){return {ok:false,error:e.message}}
}
let seed=0x41d71f13;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};const pick=xs=>xs[rand(xs.length)];
function mkTask(i){return {id:`t-${i}`,jobId:'job',updatedAt:pick(['2026-11-15','2026-11-16','2026-11-17']),priority:pick(['P1','P2','P3']),agentName:pick(['editor','builder']),kind:'work',state:pick(['RUNNING','FAILED','SUCCEEDED']),input:'Task '+i,
 comments:pick([undefined,[],[{id:'c'+i,text:'comment '+i,author:'human',createdAt:'2026-11-15'}]]),
 routing:pick([null,undefined,{provider:'openrouter',model:'gpt-6'}]),continuation:pick([undefined,null,{type:'again'}]),dependencies:[]};}
function mkJob(i){const tasks=Array.from({length:rand(6)},(_,j)=>mkTask(j));
 const plans=Array.from({length:rand(4)},(_,j)=>({id:`p-${j}`,round:j+1,updatedAt:'2026-11-16',status:pick(['PLANNING','FAILED','COMPLETED'])}));
 return {id:`job-${i}`,repository:'repo',title:'Job '+i,prNumber:0,objective:'Objective',updatedAt:pick(['2026-11-15','2026-11-16','2026-11-17']),state:'ACTIVE',tasks,plans:pick([undefined,...[plans]]),reviewRevisionRequests:pick([undefined,[],[{id:'rr',status:'stale'}]]),reviewRevisionRounds:pick([undefined,[],[{id:'r1'}]])};}
const mergeCases=[];
for(let i=0;i<440;i++){
 const local=mkJob(i),remote=structuredClone(local);
 remote.updatedAt=pick(['2026-11-14','2026-11-17','2026-11-18']);remote.tasks=Array.from({length:rand(6)},(_,j)=>mkTask(j+rand(3)));
 remote.plans=Array.from({length:rand(3)},(_,j)=>({id:`p-${j}`,round:1+j,updatedAt:pick(['2026-11-15','2026-11-18']),status:'COMPLETED'}));
 remote.reviewRevisionRequests=[{id:'remote-not-authoritative'}];
 if(i%8===0)local.tasks.push({...mkTask(70),id:'shared',comments:[{id:'old',text:'append-only'}]});
 if(i%8===0)remote.tasks.push({...mkTask(80),id:'shared',updatedAt:'2026-11-18',comments:[{id:'new',text:'new comment'}]});
 mergeCases.push({op:'mergeInboundJobSnapshot',local,remote});
}
test('inbound Job merge retains immutable local review provenance and comments',()=>{
 for(const [i,req] of mergeCases.entries())assert.deepEqual(rust(req),node(req),`merge ${i}`);
 console.log(`Verified ${mergeCases.length} direct Node/Rust inbound local Job, Plan and Task merges`);
});
const defs=[];
for(let i=0;i<900;i++){
 const left=mkTask(i),right=structuredClone(left);
 const mode=rand(12);
 if(mode===0)right.input+=' updated';if(mode===1)right.updatedAt='2026-11-19';if(mode===2)right.comments=[{id:'new'}];
 if(mode===3)right.routing={provider:'openai',model:'other'};if(mode===4)right.storySize='S';
 if(mode===5)right.dependencies=['a'];if(mode===6)delete right.kind;if(mode===7)right.review={enabled:true};
 if(mode===8)right.continuation=null;if(mode===9)right.workerRequirements={memory:'4GB'};
 for(const op of ['sameTaskDefinition','taskDefinitionDivergence','divergingDefinitionFields'])defs.push({op,kind:'task',left,right});
 const planA={id:'p'+i,round:i,planUrl:pick([undefined,'http://url']),updatedAt:'2026-11-16',assessment:'base'};
 const planB={...planA,assessment:rand(3)?'base':'different',planUrl:'https://different'};
 for(const op of ['samePlanDefinition','planDefinitionDivergence','divergingDefinitionFields'])defs.push({op,kind:'plan',left:planA,right:planB});
 defs.push({op:'isTaskForJob',task:{jobId:pick([undefined,null,'','job','other'])},jobId:'job',soleTrustedJob:rand(2)===1});
}
test('immutable task and plan definition identity matches source Node output',()=>{
 for(const [i,req] of defs.entries())assert.deepEqual(rust(req),node(req),`definition ${i}: ${JSON.stringify(req)}`);
 console.log(`Verified ${defs.length} Node/Rust task and plan immutable definition cases`);
});
const creates=[];
for(let i=0;i<180;i++){
 const job=mkJob(i),other={...mkJob(i),title:'forged new title'};
 const existing=i%4===0?[{jobId:job.id,json:JSON.stringify(job)}]:[];
 const jobs=i%3===0?[job,other]:[job];
 creates.push({op:'relayCreateScenario',existing,jobs});
}
test('SQLite Job create-if-absent returns original metadata and normalizes old stored Job',()=>{
 for(const [i,req] of creates.entries()){
   const actual=rust(req),expected=node(req);
   if(actual.ok&&expected.ok){
    const strip=out=>({...out,rows:out.rows.map(row=>({...row,json:JSON.parse(row.json)}))});
    assert.deepEqual(strip(actual.value),strip(expected.value),`Job creation ${i}`);
   }else assert.deepEqual(actual,expected,`Job creation ${i}`);
 }
 console.log(`Verified ${creates.length} Node/Rust in-memory SQLite create-if-absent histories`);
});
