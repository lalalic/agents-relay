// Direct Node/Rust differential for src/events-bus-runtime.ts: config and real bounded HTTP history paging on a disposable localhost server, never private Events Bus files.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync,spawn} from 'node:child_process';
import {writeFileSync,mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import http from 'node:http';import {once} from 'node:events';import {tmpdir} from 'node:os';
import {dirname,resolve,join} from 'node:path';import {fileURLToPath} from 'node:url';
import {eventsBusConfigPath,resolveEventsBusRuntime,eventsBusHistoryPage,eventsBusHistory} from '../../dist/events-bus-runtime.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');const binary=resolve(root,'rust/target/debug/relay-rust2-parity');
const build=spawnSync('cargo',['build','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(build.status,0,build.stderr);
function rustSync(req){const r=spawnSync(binary,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:10000});assert.equal(r.status,0,`${r.error}: ${r.stderr}`);return JSON.parse(r.stdout.trim())}
function rustAsync(req){return new Promise((resolve,reject)=>{
 const p=spawn(binary,[],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
 p.stdout.setEncoding('utf8');p.stdout.on('data',s=>stdout+=s);p.stderr.setEncoding('utf8');p.stderr.on('data',s=>stderr+=s);
 p.on('error',reject);p.on('close',code=>{if(code!==0)return reject(new Error(`Rust parity process ${code}: ${stderr}`));try{resolve(JSON.parse(stdout.trim()))}catch(e){reject(new Error(`Rust JSON: ${e.message}: ${stdout}`))}});
 p.stdin.end(JSON.stringify(req)+'\n');
})}
function nodeConfig(req){try{
 const value=req.op==='eventsBusConfigPath'?eventsBusConfigPath(req.env):resolveEventsBusRuntime(req.env);
 return {ok:true,value};
 }catch(e){return {ok:false,error:e.message}}}
async function nodePage(req){try{
 const value=req.op==='eventsBusHistoryPage'
  ?await eventsBusHistoryPage(req.jobId,req.taskId,req.limit,req.options??{},req.env)
  :await eventsBusHistory(req.jobId,req.taskId,req.limit,req.env);
 return {ok:true,value};
 }catch(e){return {ok:false,error:e.message}}}
function normalizeNetworkError(result){
 if(!result.ok&&result.error?.startsWith('events-bus history unavailable:')&&
  !result.error.includes('HTTP '))return {ok:false,error:'events-bus history unavailable: <transport-or-decoding-failure>'};
 return result;
}
let seed=0x242300cd;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};const pick=xs=>xs[rand(xs.length)];
test('configured NATS/HTTP endpoint discovery has the exact Node defaults, precedence and fail-closed legacy subject',()=>{
 const directory=mkdtempSync(join(tmpdir(),'rust2-events-config-'));
 try{
  const saved=join(directory,'runtime.json');const missing=join(directory,'not-found.json');
  const fixtures=[{EVENTS_BUS_CONFIG:missing},{EVENTS_BUS_CONFIG:missing,EVENTS_BUS_API_URL:'http://127.0.0.1:9876'},
   {EVENTS_BUS_CONFIG:missing,EVENTS_BUS_DATA_DIR:join(directory,'alternate')},
   {EVENTS_BUS_CONFIG:missing,EVENTS_BUS_NATS_URL:'nats://localhost:9000',EVENTS_BUS_SUBJECT_PREFIX:'relay.v2'}];
  for(let i=0;i<320;i++){
   const payload=pick([{}, {natsUrl:'nats://localhost:4999',apiUrl:'http://127.0.0.1:5333',subjectPrefix:'relay.custom'},
    {natsUrl:5,apiUrl:null,subjectPrefix:''},{subjectPrefix:'neo.events.job'}, {subjectPrefix:'relay.events.job'},[] ,null,'string']);
   writeFileSync(saved,JSON.stringify(payload));
   const env={EVENTS_BUS_CONFIG:saved};
   if(rand(3)===0)env.EVENTS_BUS_SUBJECT_PREFIX=pick(['relay.events.job','test.custom']);
   if(rand(5)===0)env.EVENTS_BUS_API_URL='http://localhost:4444';
   fixtures.push(env);
  }
  let verified=0;
  for(const env of fixtures){
   // The config path helper is pure even if saved JSON has invalid content.
   for(const op of ['eventsBusConfigPath','resolveEventsBusRuntime']){
    const req={op,env};assert.deepEqual(rustSync(req),nodeConfig(req),`${op} fixture ${verified}`);verified++;
   }
  }
  for(const data of ['[1,2]','null','"not an object"','42','false']){
   writeFileSync(saved,data);
   const req={op:'resolveEventsBusRuntime',env:{EVENTS_BUS_CONFIG:saved}};
   assert.deepEqual(rustSync(req),nodeConfig(req));verified++;
  }
  for(const contents of ['{corrupt','{','[','"','NaN','undefined','1 trailing','{"a":','{"a":1,}']) {
   writeFileSync(saved,contents);
   const req={op:'resolveEventsBusRuntime',env:{EVENTS_BUS_CONFIG:saved}};
   assert.deepEqual(rustSync(req),nodeConfig(req),`malformed config ${JSON.stringify(contents)}`);verified++;
  }
  console.log(`Verified ${verified} Node/Rust Events Bus config and legacy namespace fixtures`);
 }finally{rmSync(directory,{recursive:true,force:true})}
});

test('true localhost Events Bus API paging and denial cases match Node for all caller-visible rows',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rust2-events-http-'));
 let payload=null,code=200,delayed=false,requests=[];
 const server=http.createServer((req,res)=>{
  requests.push(req.url);
  if(delayed)return; // deliberate stalled real HTTP connection exercises deadlines.
  res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(payload));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=server.address().port;
 const env={EVENTS_BUS_CONFIG:join(dir,'missing.json'),EVENTS_BUS_API_URL:`http://127.0.0.1:${port}`};
 const evt=(job='j',task='t',id='e')=>({job_id:job,task_id:task,event_id:id,type:'task.progress',timestamp:'2026-11-16T21:00:00Z'});
 const base={job_id:'j',order:'asc',events:[{cursor:1,event:evt()},{cursor:2,event:evt('j','t','e2')}],next_cursor:2};
 const suites=[
  {body:base,req:{op:'eventsBusHistoryPage',jobId:'j',taskId:'t',limit:20,options:{order:'asc',after:0},env}},
  {body:{...base,order:'desc',events:[{cursor:3,event:evt('j','t','e3')},{cursor:2,event:evt('j','t','e2')}],next_cursor:3},req:{op:'eventsBusHistory',jobId:'j',taskId:'t',limit:20,env}},
  {body:{...base,events:[],next_cursor:0},req:{op:'eventsBusHistoryPage',jobId:'j',taskId:'t',limit:20,options:{order:'asc'},env}},
  ...[null,[],{}, {...base,job_id:'other'}, {...base,order:'desc'}, {...base,events:[{cursor:2,event:evt('x')}]},
     {...base,events:[{cursor:1,event:evt('j','x')}]}, {...base,events:[{cursor:2,event:evt()},{cursor:1,event:evt()}]},
     {...base,events:[{cursor:1,event:evt()}],next_cursor:2}, {...base,events:[{event:evt()}]},
     {...base,events:[{cursor:1}]}, {...base,events:[{cursor:1,event:null}]},
     {...base,events:[{cursor:-1,event:evt()}]}, {...base,events:[{cursor:1.5,event:evt()}]},
     {...base,events:[{cursor:1,event:evt()},{cursor:2,event:evt()},{cursor:3,event:evt()}]}]
    .map(body=>({body,req:{op:'eventsBusHistoryPage',jobId:'j',taskId:'t',limit:2,options:{order:'asc',after:0},env}})),
 ];
 let checked=0;
 try{
  for(const suite of suites){payload=suite.body;code=200;delayed=false;
   const expected=await nodePage(suite.req);const actual=await rustAsync(suite.req);
   assert.deepEqual(actual,expected,`real HTTP paging ${checked}: ${JSON.stringify(suite.body).slice(0,370)}`);checked++;
  }
  // Valid randomized cursor flows and validation-failure payloads, still on a real HTTP listener.
  for(let i=0;i<170;i++){
   const order=pick(['asc','desc']);const after=order==='asc'?rand(15):0;
   const count=rand(5);const cursors=Array.from({length:count},(_,index)=>order==='asc'?after+index+1:100-index);
   const corrupt=rand(7)===0;
   const rows=cursors.map((cursor,index)=>({cursor:corrupt&&index===0?0:cursor,event:evt('j',pick(['t','t','x']),`ev-${i}-${index}`)}));
   payload={job_id:'j',order,events:rows,next_cursor:rows.length?(order==='asc'?rows.at(-1).cursor:rows[0].cursor):after};
   const req={op:'eventsBusHistoryPage',jobId:'j',taskId:pick(['t',null]),limit:60,options:{order,after},env};
   const expected=await nodePage(req);const actual=await rustAsync(req);
   assert.deepEqual(actual,expected,`randomized HTTP page ${i}`);checked++;
  }
  for(const override of [
   {limit:0},{limit:-1},{limit:1.5},{limit:Number.MAX_SAFE_INTEGER+1},
   {options:{order:'up'}},{options:{after:-1}},{options:{order:'desc',after:10}},
   {options:{order:'asc',after:1.5}},{options:{timeoutMs:0}},{options:{timeoutMs:60001}},
  ]){
   const req={op:'eventsBusHistoryPage',jobId:'j',taskId:'t',limit:10,options:{},env,...override};
   const expected=await nodePage(req),actual=await rustAsync(req);
   assert.deepEqual(actual,expected,`validation before HTTP ${JSON.stringify(override)}`);checked++;
  }
  code=503;payload={message:'failed'};
  const req={op:'eventsBusHistoryPage',jobId:'j',taskId:'t',limit:10,options:{order:'asc'},env};
  assert.deepEqual(await rustAsync(req),await nodePage(req));checked++;
  delayed=true;
  const timeoutReq={...req,options:{order:'asc',timeoutMs:100}};
  const n=await nodePage(timeoutReq),r=await rustAsync(timeoutReq);
  assert.equal(n.ok,false);assert.equal(r.ok,false);
  assert.deepEqual(normalizeNetworkError(r),normalizeNetworkError(n));checked++;
  assert(requests.some(item=>item.startsWith('/events?')&&item.includes('job=j')&&item.includes('order=asc')));
  console.log(`Verified ${checked} real localhost HTTP history requests/validation failures, including deadline timeout`);
 }finally{
  server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  rmSync(dir,{recursive:true,force:true});
 }
});
