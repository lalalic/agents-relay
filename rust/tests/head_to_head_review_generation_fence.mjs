// Direct Node/Rust differential for src/review-generation-fence.ts; a pure snapshot guard, no real approval or SQLite writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {reviewGenerationMatches} from '../../dist/review-generation-fence.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let compiled=false;
function rust(req){if(!compiled){const result=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(result.status,0,result.stderr);compiled=true;}
 const res=spawnSync(bin,[],{input:JSON.stringify({op:'reviewGenerationMatches',...req})+'\n',encoding:'utf8',timeout:10000});assert.equal(res.status,0,`${res.error}: ${res.stderr}`);return JSON.parse(res.stdout.trim());}
function node(req){try{return {ok:true,value:reviewGenerationMatches(req.current,req.original,req.task,req.headSha)}}catch(e){return {ok:false,error:e.message}}}
let seed=0x321c2119;function rand(n){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;}const choice=xs=>xs[rand(xs.length)];
const scenarios=[];
function build(i){
 const id=String(i+1),head='head-'+i;
 const task={id,executionId:'ex-'+i,planningDecisionId:'decision-'+i,reviewHeadSha:head,agentName:'job-acceptance-reviewer',state:'RUNNING'};
 const current={id:'j-'+i,state:'ACTIVE',headSha:head,tasks:[{...task}],review:{taskId:id,headSha:head,outcome:'pending'}};
 const original={id:current.id,state:'ACTIVE',review:{...current.review}};
 return {task,current,original,headSha:head};
}
for(let i=0;i<1600;i++){
 const req=build(i);
 const mode=rand(22);
 switch(mode){
 case 0:req.current.tasks=[];break;
 case 1:req.current.tasks[0].reviewHeadSha='old-head';break;
 case 2:req.current.state='COMPLETED';break;
 case 3:req.current.state='FAILED';req.current.projectionRecovery={status:'repairing'};break;
 case 4:req.current.headSha='other';break;
 case 5:req.current.tasks[0].executionId='old';break;
 case 6:req.current.review.taskId='elsewhere';break;
 case 7:req.current.review.headSha='old-head';break;
 case 8:req.current.review.outcome='approved';break;
 case 9:req.original.review.outcome='approved';break;
 case 10:delete req.original.review;break;
 case 11:delete req.current.review;break;
 case 12:delete req.current.review;delete req.task.planningDecisionId;break;
 case 13:req.original.review={taskId:req.task.id,outcome:'pending'};delete req.current.review;break;
 case 14:req.current.review={outcome:'stale',headSha:'old'};req.original.review={outcome:'stale',headSha:'old'};req.current.tasks.push({...req.task,id:'r2',agentName:'reviewer',reviewHeadSha:req.headSha});break;
 case 15:req.current.review={outcome:'stale',headSha:'old'};req.original.review={outcome:'stale',headSha:'old'};req.current.tasks.push({...req.task,id:'r2',agentName:'reviewer',state:'CANCELLED'});break;
 case 16:req.current.review={outcome:'stale',headSha:'old'};req.original.review={outcome:'stale',headSha:'old'};delete req.task.planningDecisionId;break;
 case 17:req.current.tasks[0].executionId=null;delete req.task.executionId;break;
 case 18:req.current.tasks[0].executionId=null;req.task.executionId=null;break;
 case 19:req.current.tasks[0].reviewHeadSha=req.headSha;req.current.tasks.push({...req.task,agentName:'reviewer',id:'two',state:'CANCELLED'});req.current.review={outcome:'stale',headSha:'old'};req.original.review={outcome:'stale',headSha:'old'};break;
 case 20:req.current.review={taskId:req.task.id,headSha:req.headSha,outcome:'stale'};req.original.review={taskId:req.task.id,headSha:req.headSha,outcome:'stale'};break;
 case 21:req.current.review={};req.original.review={};break;
 }
 scenarios.push(req);
}
for(let i=0;i<350;i++){
 const req=build(i+2000),mode=rand(11);
 req.current.state=choice(['ACTIVE','FAILED','COMPLETED','CANCELLED']);
 if(rand(2))req.current.projectionRecovery={status:'repairing'};
 if(rand(2))req.current.headSha=choice([req.headSha,'other',null,'']);
 if(rand(2))req.current.review=choice([{taskId:req.task.id,headSha:req.headSha,outcome:'stale'},{outcome:'stale',headSha:'old'},null,undefined]);
 if(rand(2))req.original.review=choice([{outcome:'stale'}, {outcome:'pending'},{taskId:req.task.id},undefined]);
 const length=rand(5);for(let j=0;j<length;j++)req.current.tasks.push({...req.task,id:'r-'+j,agentName:choice(['reviewer','job-acceptance-reviewer','worker']),state:choice(['FAILED','CANCELLED','RUNNING']),reviewHeadSha:choice([req.headSha,'old'])});
 if(mode===0)req.task.executionId=null;
 if(mode===1)req.current.tasks[0].executionId=null;
 if(mode===2)delete req.current.tasks[0].executionId;
 scenarios.push(req);
}
test('immutable Final Review generation fencing agrees with original Node for mixed Job/Task states',()=>{
 for(const [i,req] of scenarios.entries())assert.deepEqual(rust(req),node(req),`Review generation #${i}: ${JSON.stringify(req).slice(0,430)}`);
 console.log(`Verified ${scenarios.length} Node/Rust durable Review generation and stale-Head fencing scenarios`);
});
