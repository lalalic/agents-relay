// Original compiled Node ScriptTaskAdapter public Worker launch against the
// canonical native Rust ScriptTaskAdapter used by actual isolated daemon.
// Disposable Shortcut, local output, no external provider or live Relay DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {ScriptTaskAdapter} from '../../dist/script-task-adapter.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const fixture=mkdtempSync(join(tmpdir(),'rust2-script-adapter-'));
test.after(()=>rmSync(fixture,{recursive:true,force:true}));
const project=join(fixture,'project');
for(const p of [project,join(project,'agents','.shortcut'),join(fixture,'out')])mkdirSync(p,{recursive:true});
writeFileSync(join(project,'agents','fixture.agent.md'),'---\nname: fixture\n---\n# Isolated Script Agent\n');
writeFileSync(join(project,'agents','.shortcut','fixture.agent.mjs'),`
import {writeFile} from 'node:fs/promises';
export async function run({input}) {
 await writeFile(input.capturePath??(input.outputPath+'.capture'),JSON.stringify(input));
 if(input.scenario==='throw')throw new Error('Fixture Script raised an exception');
 if(input.scenario==='waiting')return {status:'WAITING_REVIEW'};
 if(input.scenario==='badOutput')return {status:'COMPLETED',output:'not-an-object',artifacts:[]};
 return {status:'COMPLETED',output:{caseId:input.caseId??'plain',verified:true},artifacts:[{name:'fixture'}]};
}
`);
const roots={workspaceRoot:fixture,globalRoot:fixture,sharedRoot:null};
function normalizedEvent(e){const value=structuredClone(e);delete value.timestamp;delete value.event_id;return value;}
const cases=[];
for(let i=0;i<75;i++){
 const variant=['success','success','success','waiting','badOutput','throw','noAgent','noProject','badDag','noLease','badOutputPath','plain','review'][i%13];
 const dest=join(fixture,'out',`case-${i}.json`);
 const capture=join(fixture,'out',`capture-${i}.json`);
 const data={scenario:variant==='review'?'success':variant,caseId:String(i),capturePath:capture};
 const task={id:String(i+11),jobId:'17',agentName:variant==='noAgent'?'missing':'fixture',
   adapter:'script',state:'QUEUED',executionId:variant==='noLease'?'':`run-${i}`,
   parentTaskId:null,output:{kind:'file',path:variant==='badOutputPath'?'relative/result.json':dest},
   input:variant==='plain'?`Run plain fixture ${i}`:JSON.stringify(data)};
 if(variant==='badDag')task.dagNode={parentTaskId:'4',nodeId:'fixture-node',executor:'script'};
 if(variant==='review')task.interactiveInvocation={status:'approved',decidedAt:'2026-11-18T00:00:00.000Z',
    revision:2,invocationId:'review-2',feedback:'Bounded review',comments:[]};
 const context=variant==='noProject'?{}:{executionContext:{project:{path:project}}};
 const result=variant==='waiting'?{status:'WAITING_REVIEW'}:
    variant==='badOutput'?{status:'COMPLETED',output:'not-an-object',artifacts:[]}:
    {status:'COMPLETED',output:{caseId:variant==='plain'?'plain':String(i),verified:true},
      artifacts:[{name:'fixture'}]};
 cases.push({op:'certScriptTaskAdapter',task,context,roots,scenario:variant,scriptResult:result,capture});
}
async function original(f){
 const events=[];
 const adapter=new ScriptTaskAdapter(async event=>{events.push(normalizedEvent(event));},f.roots);
 let summary=null,error=null,ok=true;
 try{
  const launch=adapter.launch(f.task,new AbortController().signal,f.context);
  const receipt=await launch.promise;
  summary=receipt.summary;
 }catch(failure){ok=false;error=failure?.message??String(failure);}
 const capturePath=existsSync(f.capture)?f.capture:f.task.output.path+'.capture';
 const capture=existsSync(capturePath)?JSON.parse(readFileSync(capturePath,'utf8')):null;
 const file=existsSync(f.task.output.path)?JSON.parse(readFileSync(f.task.output.path,'utf8')):null;
 return {ok,summary,error,invokerInput:capture,script:capture?
   realpathSync(join(project,'agents','.shortcut','fixture.agent.mjs')):null,events,file};
}
function mismatch(a,b,p=''){
 if(Object.is(a,b))return null;
 if(typeof a!==typeof b||a===null||b===null||typeof a!=='object')return [p,a,b];
 for(const k of new Set([...Object.keys(a),...Object.keys(b)])){
  const found=mismatch(a[k],b[k],p+'/'+k);if(found)return found;
 }
 return null;
}
test('75 original Node/Rust production Script Task Adapter public launch cases',async()=>{
 const adapter=new ScriptTaskAdapter(async()=>{},roots);
 const identity={name:adapter.name,id:adapter.id,capabilities:[...adapter.capabilities]};
 const expected=[];for(const fixture of cases)expected.push(await original(fixture));
 const p=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:90000,
   input:[{op:'certScriptTaskAdapter',method:'identity'},...cases].map(JSON.stringify).join('\n')+'\n',maxBuffer:12*1024*1024});
 assert.equal(p.status,0,p.stderr);
 const output=p.stdout.trim().split('\n').map(JSON.parse);
 assert.deepEqual(output[0],{ok:true,value:identity},
   'ScriptTaskAdapter public identity, name and capabilities differ');
 const rust=output.slice(1);
 assert.equal(rust.length,cases.length);
 const differences=[];
 for(let i=0;i<cases.length;i++){
  const observed=rust[i].ok?rust[i].value:{error:rust[i].error};
  const original=expected[i];
  // Node's no-script errors occur inside the asynchronous Worker promise.
  try{assert.deepEqual(observed,original);}catch{
   differences.push({index:i,variant:cases[i].scenario,
     actual:observed,original,diff:mismatch(original,observed)});
  }
 }
 for(const d of differences.slice(0,12)){
  console.log('SCRIPT DIFF',d.index,d.variant,JSON.stringify(d.diff)?.slice(0,600));
 }
 assert.deepEqual(differences.map(d=>d.index),[],`${differences.length} Script Task Adapter differences`);
 console.log('Verified',cases.length,'original Node/Rust Script Task Adapter launch scenarios');
});
