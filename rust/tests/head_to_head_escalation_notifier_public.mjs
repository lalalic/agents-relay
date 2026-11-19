// Real original Node and Rust escalation notifier differential: environment
// validation, the durable delivery ledger over a real mutable store, and the
// real loopback HTTP transport demanding verified provider receipts
// (test-owned 127.0.0.1 server, no production network).
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import http from 'node:http';
import {
  escalationNotifierFromEnvironment,deliverPendingEscalations,
} from '../../dist/escalation-notifier.js';

const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const NOW=Date.parse('2026-11-18T12:00:00.000Z');
const now=new Date(NOW);

const task=(id,escalation,over={})=>({id,jobId:'17',state:'RUNNING',kind:'work',
  agentName:'troubleshooter',attempt:1,maxAttempts:3,timeoutMs:300000,
  result:null,error:null,createdAt:'2026-11-18T11:00:00.000Z',
  updatedAt:'2026-11-18T11:30:00.000Z',...(escalation!==undefined?{escalation}:{}),...over});
const esc=(over={})=>({id:'esc-1',requiredAction:'Owner must approve the cutover window',
  resolutionCondition:'Owner reply received in the escalation thread',
  context:'The database migration is paused awaiting the cutover window decision.',
  status:'pending',requestedAt:'2026-11-18T11:00:00.000Z',...over});
const jobWith=(tasks)=>({id:'17',projectRoot:'/tmp/r2-escalation-fixture',state:'ACTIVE',
  title:'Escalation probe',objective:'Probe',tasks,priority:'P2',
  createdAt:'2026-11-18T11:00:00.000Z',updatedAt:'2026-11-18T11:30:00.000Z',plans:[]});

function storeFixture(job,record){
  return {
    load:async()=>job,
    ...(job._mutateJob===false?{}:{mutateJob:async(jobId,mutation)=>{
      // The Node mutation callback mutates its argument in place and returns
      // it, so the pre-image must be captured before invoking it.
      const before=structuredClone(job);
      const current=structuredClone(job);
      const observed=mutation(current);
      record.push({current:before,observed});
      Object.assign(job,observed);
      return observed;
    }}),
  };
}
function nodeMutations(record){
  return record.map(({current,observed})=>{
    // The Node mutation callbacks identify their task by id then re-assign the
    // same notification shape; compare against the pre-image by task id.
    const before=new Map(current.tasks.map(t=>[t.id,JSON.stringify(t)]));
    const changed=observed.tasks.filter(t=>before.get(t.id)!==JSON.stringify(t));
    if(changed.length===0)return {kind:'no-op'};
    const after=changed[0];
    const notification=after.escalation?.notification;
    const taskId=after.id;
    const escalationId=after.escalation?.id;
    if(notification?.status==='delivered')
      return {kind:'delivered',taskId,escalationId,
        receipt:{channel:notification.channel,deliveryId:notification.deliveryId,
          deliveredAt:notification.deliveredAt}};
    if(notification?.lastError==='Notification delivery channel is not configured')
      return {kind:'missingChannel',taskId,escalationId};
    return {kind:'failed',taskId,escalationId,message:notification?.lastError,
      attempts:notification?.attempts,lastAttemptAt:notification?.lastAttemptAt,
      nextAttemptAt:notification?.nextAttemptAt};
  });
}
async function nodeDeliver(job,notifierMode){
  const record=[];
  const requests=[];
  const store=storeFixture(job,record);
  const notifier=notifierMode==='none'?undefined:async request=>{
    requests.push(request);
    if(notifierMode==='ok')return {channel:'loopback',deliveryId:'rcpt-1',deliveredAt:'2026-11-18T12:00:00.000Z'};
    if(notifierMode==='invalid')return {channel:'',deliveryId:'rcpt-1',deliveredAt:'2026-11-18T12:00:00.000Z'};
    if(notifierMode==='reject')throw new Error('Notification endpoint HTTP 500');
    throw new Error(`mode ${notifierMode} failed`);
  };
  const counts=await deliverPendingEscalations(store,'17',notifier,now);
  return {delivered:counts.delivered,pending:counts.pending,failed:counts.failed,
    mutations:nodeMutations(record),requests};
}
function firstDiff(a,b,path=''){
  if(Object.is(a,b))return null;
  if(typeof a!==typeof b||a===null||b===null||typeof a!=='object')return [path,a,b];
  if(Array.isArray(a)!==Array.isArray(b))return [path,a,b];
  if(Array.isArray(a)){
    if(a.length!==b.length)return [path+'/length',a.length,b.length];
    for(let i=0;i<a.length;i++){const d=firstDiff(a[i],b[i],path+'/'+i);if(d)return d;}
    return null;
  }
  for(const k of new Set([...Object.keys(a),...Object.keys(b)])){
    const d=firstDiff(a[k],b[k],path+'/'+k);if(d)return d;
  }
  return null;
}
const ENV_CASES=[
  {},{AGENTS_RELAY_ESCALATION_NOTIFY_URL:''},{AGENTS_RELAY_ESCALATION_NOTIFY_URL:'   '},
  {AGENTS_RELAY_ESCALATION_NOTIFY_URL:'https://notify.example.internal/receipts'},
  {AGENTS_RELAY_ESCALATION_NOTIFY_URL:'http://127.0.0.1:18471/receipts'},
  {AGENTS_RELAY_ESCALATION_NOTIFY_URL:'http://localhost:18471/receipts',AGENTS_RELAY_ESCALATION_NOTIFY_TOKEN:'tok-1'},
  {AGENTS_RELAY_ESCALATION_NOTIFY_URL:'http://[::1]:18471/receipts'},
  {AGENTS_RELAY_ESCALATION_NOTIFY_URL:'http://notify.example.internal/receipts'},
  {AGENTS_RELAY_ESCALATION_NOTIFY_URL:'https://user:pass@notify.example.internal/receipts'},
  {AGENTS_RELAY_ESCALATION_NOTIFY_URL:'https://notify.example.internal/r#frag'},
  {AGENTS_RELAY_ESCALATION_NOTIFY_URL:'not a url'},
];
const JOBS=[
  {name:'none',tasks:[task('w1',undefined,{agentName:'implementation'})]},
  {name:'single-pending',tasks:[task('t1',esc())]},
  {name:'single-pending-non-ts',tasks:[task('t1',esc(),{agentName:'implementation'})]},
  {name:'delivered-already',tasks:[task('t1',esc({notification:{status:'delivered',
    channel:'loopback',deliveryId:'rcpt-0',deliveredAt:'2026-11-18T11:45:00.000Z'}}))]},
  {name:'future-attempt',tasks:[task('t1',esc({notification:{status:'pending',
    attempts:2,nextAttemptAt:'2026-11-18T12:30:00.000Z'}}))]},
  {name:'due-attempt',tasks:[task('t1',esc({notification:{status:'pending',
    attempts:2,lastError:'previous outage',lastAttemptAt:'2026-11-18T11:40:00.000Z',
    nextAttemptAt:'2026-11-18T11:50:00.000Z'}}))]},
  {name:'missing-channel-marked',tasks:[task('t1',esc({notification:{status:'pending',
    lastError:'Notification delivery channel is not configured'}}))]},
  {name:'missing-channel-fresh',tasks:[task('t1',esc({notification:{status:'pending'}}))]},
  {name:'no-notification',tasks:[task('t1',esc())]},
  {name:'mixed',tasks:[task('t1',esc()),task('t2',esc({id:'esc-2',
    notification:{status:'pending',attempts:1,nextAttemptAt:'2026-11-18T13:00:00.000Z'}})),
    task('t3',esc({id:'esc-3'}),{agentName:'implementation'}),
    task('t4',esc({id:'esc-4',status:'delivered'}))]},
];
const LEDGER_CASES=[];
for(const fixture of JOBS){
  const job=jobWith(fixture.tasks);
  const hasAtomic=fixture._mutateJob!==false;
  if(!hasAtomic)job._mutateJob=false;
  for(const notifierMode of ['none','ok','invalid','reject']){
    LEDGER_CASES.push({method:'deliver',job,jobId:'17',notifierMode,
      hasAtomicMutation:hasAtomic,nowMs:NOW});
  }
}
async function startServer(){
  const server=http.createServer((request,response)=>{
    let body='';request.on('data',c=>body+=c);
    request.on('end',()=>{
      const parsed=JSON.parse(body||'{}');
      const kind=String(parsed.escalationId||'');
      if(kind==='esc-ok'){response.writeHead(200,{'Content-Type':'application/json'});
        response.end(JSON.stringify({delivered:true,channel:'loopback',
          deliveryId:'rcpt-http-1',deliveredAt:'2026-11-18T12:00:00.000Z'}));return;}
      if(kind==='esc-false'){response.writeHead(200,{'Content-Type':'application/json'});
        response.end(JSON.stringify({delivered:false}));return;}
      if(kind==='esc-500'){response.writeHead(500);response.end('boom');return;}
      if(kind==='esc-badjson'){response.writeHead(200,{'Content-Type':'application/json'});
        response.end('not-json{');return;}
      if(kind==='esc-redirect'){response.writeHead(302,{Location:'https://notify.example.internal/elsewhere'});
        response.end();return;}
      response.writeHead(400);response.end('{}');
    });
  });
  await new Promise(res=>server.listen(0,'127.0.0.1',res));
  return {server,port:server.address().port};
}
test('original Node/Rust escalation notifier differential',async()=>{
  const {server,port}=await startServer();
  const baseUrl=`http://127.0.0.1:${port}/receipts`;
  const cases=[];
  for(const env of ENV_CASES)cases.push({method:'envConfig',env});
  cases.push(...LEDGER_CASES);
  const HTTP_SCENARIOS=[
    {id:'esc-ok',expectOk:true},{id:'esc-false',expectOk:false},
    {id:'esc-500',expectOk:false},{id:'esc-badjson',expectOk:false},
    {id:'esc-redirect',expectOk:false},
  ];
  for(const scenario of HTTP_SCENARIOS)cases.push({method:'httpSend',
    env:{AGENTS_RELAY_ESCALATION_NOTIFY_URL:baseUrl},
    request:{jobId:'17',taskId:'t1',escalationId:scenario.id,
      idempotencyKey:`escalation/${scenario.id}`,
      requiredAction:'Owner action',resolutionCondition:'Reply',context:'ctx'}});
  // Expected values run first; the loopback server stays up for the Rust run.
  const expectedList=[];
  for(const fixture of cases){
    if(fixture.method==='envConfig'){
      try{
        const notifier=escalationNotifierFromEnvironment(fixture.env);
        if(notifier===undefined)expectedList.push({configured:false});
        else expectedList.push({configured:true,hasToken:
          Boolean(fixture.env.AGENTS_RELAY_ESCALATION_NOTIFY_TOKEN?.trim())});
      }catch{expectedList.push({error:true});}
      continue;
    }
    if(fixture.method==='deliver'){
      try{
        expectedList.push(await nodeDeliver(structuredClone(fixture.job),fixture.notifierMode));
      }catch(error){expectedList.push({error:error?.message??String(error)});}
      continue;
    }
    try{
      const notifier=escalationNotifierFromEnvironment(fixture.env);
      const receipt=await notifier(fixture.request);
      expectedList.push({ok:true,receipt});
    }catch(error){
      expectedList.push({ok:false,message:error?.message??String(error)});
    }
  }
  // The loopback server lives in this process; spawnSync would block the
  // event loop and starve it, so the parity binary must run asynchronously.
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
    child.stdin.end(cases.map(f=>JSON.stringify({op:'certEscalationNotifier',...f}))
      .join('\n')+'\n');
    const timer=setTimeout(()=>{child.kill();reject(new Error('parity binary timeout'));},300000);
    timer.unref();
  });
  server.close();
  const outputs=stdout.trim().split('\n').map(line=>{
    const parsed=JSON.parse(line);
    return parsed.ok?parsed.value:{error:parsed.error};
  });
  assert.equal(outputs.length,cases.length);
  const failures=[];
  for(let i=0;i<cases.length;i++){
    const want=expectedList[i];
    const got=outputs[i];
    let diff=null;
    if(cases[i].method==='envConfig'){
      const wantError=want.error===true;
      const gotError=got.error!==undefined;
      if(wantError!==gotError
        ||(!wantError&&JSON.stringify(want)!==JSON.stringify(got)))diff=[null,want,got];
    }else if(cases[i].method==='deliver'){
      if(want.error||got.error){
        if(!want.error||!got.error||want.error!==got.error)diff=[null,want.error,got.error??got];
      }else{
        diff=firstDiff(want,got);
      }
    }else{
      // httpSend: endpoint-semantic errors carry canonical messages;
      // transport/parse errors are HTTP-stack specific and compare by class.
      const semantic=!want.ok&&String(want.message).startsWith('Notification endpoint');
      const matched=semantic
        ?Boolean(want.ok)===Boolean(got.ok)&&(want.ok
          ?JSON.stringify(want.receipt)===JSON.stringify(got.receipt)
          :String(got.message)===String(want.message))
        :Boolean(want.ok)===Boolean(got.ok)&&(want.ok
          ?JSON.stringify(want.receipt)===JSON.stringify(got.receipt)
          :true);
      if(!matched)diff=[null,want,got];
    }
    if(!diff)continue;
    failures.push({i,method:cases[i].method,
      ledgerIndex:LEDGER_CASES.indexOf(cases[i]),diff});
  }
  for(const f of failures.slice(0,12))console.log('ESC_DIFF',f.i,f.method,f.ledgerIndex,
    JSON.stringify(f.diff).slice(0,360));
  assert.deepEqual(failures.map(f=>f.i),[],
    `${failures.length} original Node/Rust escalation notifier mismatches`);
  console.log('Verified',cases.length,'original Node/Rust escalation notifier cases');
});
