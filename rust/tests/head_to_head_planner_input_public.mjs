// Original Node plannerInput JSON wire against the public Rust plannerInput.
// This is the same payload exposed by the installed `plan context` command.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {plannerInput} from '../../dist/planner.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
let seed=0x7a2f4d;
function rand(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
const choice=values=>values[rand()%values.length];
const scenarios=[];
for(let i=0;i<100;i++){
 const state=choice(['ACTIVE','DRAFT','COMPLETED','CANCELLED']);
 const job={id:'17',repository:'fixture',prNumber:choice([0,0,27]),state,
   objective:'Improve Task '+i,title:'Native Planner Input '+i,
   ...(i%3===0?{review:{outcome:'changes_required',taskId:'2',headSha:'abc',
      evidence:{data:{summary:'Found a race condition'}}}}:{}),
   ...(i%5===0?{changeCycle:{afterReview:true,consumedByPlannerTaskId:null}}:{}),
   plans:Array.from({length:rand()%4},(_,j)=>({
     id:'plan-'+j,round:j+1,status:choice(['FAILED','PLANNING','SUCCEEDED']),
     source:choice(['manual','model-planner','review']),
     trigger:{source:'manual'},assessment:'Assessment '+j,
     generatedTaskIds:[],
     ...(rand()%3===0?{error:'Failure '+j}:{}),
     ...(rand()%2===0?{objectiveStatus:'in_progress'}:{})
   }))};
 const tasks=Array.from({length:rand()%6},(_,j)=>({
   id:String(j+2),jobId:'17',kind:choice(['work','work','planner']),
   title:'Work '+j,state:choice(['SUCCEEDED','FAILED','QUEUED','RUNNING']),
   agentName:'implementation',dependencies:[],
   ...(rand()%2===0?{parentTaskId:null}:{}),
   ...(rand()%2===0?{input:'Fix a race condition '+j}:{}),
   ...(rand()%3===0?{result:{summary:'Verified result',data:{checks:[1,2]}}}:{}),
   ...(rand()%4===0?{plannerResult:{objective_status:'in_progress',
      assessment:'More work',next_tasks:[{id:'12'}]}}:{})
 }));
 job.tasks=tasks;
 const context={job,tasks,objective:job.objective,
   ...(rand()%2===0?{planExecution:{planId:'plan-1',executionId:'execution-1'}}:{}),
   ...(rand()%3===0?{forceRestate:true,restateTaskIds:['2']}:{}),
   ...(rand()%4===0?{trigger:{source:'review'},guidance:'Check review'}:{}),
   ...(rand()%2===0?{executionContext:{project:{name:'fixture',path:'/tmp/fixture'},
       agents:[{name:'implementation',capabilities:['code'],restrictions:[],
        description:'Agent for test'}]}}:{})
 };
 scenarios.push({op:'certPlannerInput',context});
}
function diff(a,b,path=''){
 if(Object.is(a,b))return null;
 if(typeof a!==typeof b||a===null||b===null||typeof a!=='object')
   return [path,a,b];
 for(const key of new Set([...Object.keys(a),...Object.keys(b)])){
   let x=diff(a[key],b[key],`${path}/${key}`);if(x)return x;
 }
 return null;
}
test('100 exact original Node/Rust PlannerInput public JSON cases',()=>{
 const expected=[];
 for(const s of scenarios){
  try{expected.push({ok:true,value:JSON.parse(plannerInput(s.context))});}
  catch(error){expected.push({ok:false,error:error.message});}
 }
 const p=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:90000,
   input:scenarios.map(JSON.stringify).join('\n')+'\n',maxBuffer:16*1024*1024});
 assert.equal(p.status,0,p.stderr);
 const outputs=p.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(outputs.length,scenarios.length);
 const mismatches=[];
 for(let i=0;i<outputs.length;i++){
  let rust=outputs[i];
  if(rust.ok)rust={ok:true,value:typeof rust.value==='string'?JSON.parse(rust.value):rust.value};
  try{assert.deepEqual(rust,expected[i]);}
  catch{mismatches.push({i,diff:diff(expected[i],rust),context:scenarios[i].context});}
 }
 for(const m of mismatches.slice(0,5))console.log('MISMATCH',m.i,JSON.stringify(m.diff)?.slice(0,450));
 assert.deepEqual(mismatches.map(m=>m.i),[],`${mismatches.length} Node/Rust PlannerInput mismatches`);
 console.log('Verified',scenarios.length,'original Node/Rust PlannerInput cases');
});
