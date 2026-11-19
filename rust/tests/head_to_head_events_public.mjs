// Independent differential for src/events.ts (PROVENANCE QUARANTINE cleared):
// subject-token/prefix validation, eventFor shape, MemoryEventBus fan-out and
// NatsEventBus constructor validation — no NATS server required.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {MemoryEventBus,NatsEventBus,subjectToken,eventFor} from '../../dist/events.js';

const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');

function jsonable(value){
  if(typeof value==='string'){
    if(/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value))return '<iso>';
    if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))return '<uuid>';
    return value;
  }
  if(Array.isArray(value))return value.map(jsonable);
  if(value&&typeof value==='object')
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,jsonable(v)]));
  return value;
}
const TOKENS=['a','A','0','_','-','job_3-X','a.b','','a b','a/b','á','job.1','*','>',
  'x'.repeat(64),'中文'];
const PREFIXES=['relay.events.job','a','A','0','.','-','_','a b','a/b','','relay..job',
  'á','x'.repeat(200)];
const EVENT_FOR_CASES=[
  {jobId:'17',taskId:'t1',parentTaskId:'p1',type:'task.completed',status:'succeeded',
    message:'done',visibility:'worker',data:{a:1},source:{id:'s1'}},
  {jobId:'17',taskId:'t1',parentTaskId:null,type:'task.failed',status:'failed',
    message:'boom'},
  {jobId:'17',taskId:'t1',parentTaskId:null,type:'task.blocked',status:'blocked',
    message:'stuck'},
  {jobId:'17',taskId:'t1',parentTaskId:null,type:'task.started',status:'running',
    message:'go',visibility:'cli'},
  {jobId:'17',taskId:'t1',parentTaskId:'p2',type:'x',status:'weird',message:'',
    visibility:'',data:null,source:{}},
];
function nodeEventFor(fixture){
  try{
    const event=eventFor(fixture.jobId,fixture.taskId,fixture.parentTaskId,
      fixture.type,fixture.status,fixture.message,fixture.visibility,
      fixture.data,fixture.source);
    return {ok:true,event:jsonable(event)};
  }catch(error){return {ok:false,error:error?.message??String(error)};}
}
async function nodeMemoryBus(steps){
  const bus=new MemoryEventBus();
  const received=[];
  const unsubscribers=[];
  const handlers=[];
  for(const step of steps){
    if(step.kind==='subscribe'||step.kind==='subscribeFailing'){
      const wake=async event=>{
        received.push(jsonable(event));
        if(step.kind==='subscribeFailing')throw new Error('handler exploded');
      };
      handlers.push(wake);
      unsubscribers.push(step.kind==='subscribeAll'
        ?await bus.subscribeAll(wake)
        :await bus.subscribe(step.jobId,wake));
      continue;
    }
    if(step.kind==='subscribeAll'){
      const wake=async event=>{received.push(jsonable(event));};
      handlers.push(wake);
      unsubscribers.push(await bus.subscribeAll(wake));
      continue;
    }
    if(step.kind==='unsubscribe'){
      const handle=unsubscribers.splice(step.index,1)[0];
      if(handle)await handle();
      continue;
    }
    if(step.kind==='publish'){
      try{await bus.publish(step.event);}
      catch(error){return {ok:false,error:error?.message??String(error)};}
      continue;
    }
  }
  return {ok:true,received};
}
const event=(job_id,type)=>({version:1,event_id:'e',job_id,task_id:'t1',
  parent_task_id:null,type,status:'succeeded',timestamp:'2026-11-18T12:00:00.000Z',
  visibility:'orchestrator',level:'info',message:'m'});
const BUS_SCENARIOS=[
  [{kind:'subscribe',jobId:'17'},{kind:'publish',event:event('17','a')}],
  [{kind:'subscribe',jobId:'17'},{kind:'publish',event:event('18','a')}],
  [{kind:'subscribe',jobId:'17'},{kind:'subscribeAll'},{kind:'publish',event:event('17','a')},
    {kind:'publish',event:event('18','b')}],
  [{kind:'subscribe',jobId:'17'},{kind:'unsubscribe',index:0},{kind:'publish',event:event('17','a')}],
  [{kind:'subscribe',jobId:'17'},{kind:'subscribe',jobId:'17'},{kind:'publish',event:event('17','a')}],
  [{kind:'subscribeFailing',jobId:'17'},{kind:'subscribe',jobId:'17'},
    {kind:'publish',event:event('17','a')}],
  [{kind:'subscribeAll'},{kind:'publish',event:event('x','a')}],
];
const NATS_CONFIG_CASES=[
  {url:undefined,prefix:undefined},
  {url:'nats://127.0.0.1:4222',prefix:'relay.events.job'},
  {prefix:'relay.custom'},
  {prefix:''},{prefix:'a b'},{prefix:'a/b'},{prefix:'á'},
  {prefix:'ok.token'},{prefix:'x'.repeat(200)},
];
test('original Node/Rust events.ts differential (quarantine cleared)',async()=>{
  const cases=[];
  for(const value of TOKENS)cases.push({method:'subjectToken',value});
  for(const value of PREFIXES)cases.push({method:'subjectPrefix',value});
  for(const fixture of EVENT_FOR_CASES)
    cases.push({method:'eventFor',...JSON.parse(JSON.stringify(fixture))});
  for(const steps of BUS_SCENARIOS)cases.push({method:'memoryBus',steps});
  for(const fixture of NATS_CONFIG_CASES)
    cases.push({method:'natsConfig',url:fixture.url,prefix:fixture.prefix});
  const expected=[];
  for(const fixture of cases){
    if(fixture.method==='subjectToken'){
      try{const value=subjectToken(fixture.value);expected.push({ok:true,value});}
      catch(error){expected.push({ok:false,error:error?.message??String(error)});}
      continue;
    }
    if(fixture.method==='subjectPrefix'){
      try{new NatsEventBus('nats://127.0.0.1:4222',fixture.value);
        expected.push({ok:true,value:fixture.value});}
      catch(error){expected.push({ok:false,error:error?.message??String(error)});}
      continue;
    }
    if(fixture.method==='eventFor'){expected.push(nodeEventFor(fixture));continue;}
    if(fixture.method==='memoryBus'){
      expected.push(await nodeMemoryBus(fixture.steps));continue;
    }
    if(fixture.method==='natsConfig'){
      try{new NatsEventBus(fixture.url,fixture.prefix);
        expected.push({ok:true,value:fixture.prefix??'relay.events.job'});}
      catch(error){expected.push({ok:false,error:error?.message??String(error)});}
    }
  }
  const stdout=await new Promise((resolve,reject)=>{
    const child=spawn(binary,[],{cwd:root});
    let out='',err='';
    child.stdout.on('data',chunk=>out+=chunk);
    child.stderr.on('data',chunk=>err+=chunk);
    child.on('error',reject);
    child.on('close',code=>{
      if(code!==0)reject(new Error(err||`parity binary exited ${code}`));
      else resolve(out);
    });
    child.stdin.end(cases.map(f=>JSON.stringify({op:'certEvents',...f})).join('\n')+'\n');
    const timer=setTimeout(()=>{child.kill();reject(new Error('parity timeout'));},300000);
    timer.unref();
  });
  const outputs=stdout.trim().split('\n').map(line=>{
    const parsed=JSON.parse(line);
    if(!parsed.ok)throw new Error('parity error: '+parsed.error);
    return jsonable(parsed.value);
  });
  assert.equal(outputs.length,cases.length);
  const failures=[];
  for(let i=0;i<cases.length;i++){
    const want=expected[i],got=outputs[i];
    if(want.ok!==got.ok){failures.push({i,method:cases[i].method,want,got});continue;}
    if(want.ok===false&&want.error!==got.error)
      {failures.push({i,method:cases[i].method,want,got});continue;}
    if(want.ok===true&&JSON.stringify(want)!==JSON.stringify(got))
      failures.push({i,method:cases[i].method,want,got});
  }
  for(const f of failures.slice(0,10))console.log('EV_DIFF',f.i,f.method,
    JSON.stringify(f.want).slice(0,200),JSON.stringify(f.got).slice(0,200));
  assert.deepEqual(failures.map(f=>f.i),[],
    `${failures.length} original Node/Rust events.ts mismatches`);
  console.log('Verified',cases.length,'original Node/Rust events.ts cases');
});
