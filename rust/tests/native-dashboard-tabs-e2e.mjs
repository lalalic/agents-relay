import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
const executable=resolve(process.env.CARGO_TARGET_DIR??join(import.meta.dirname,'../target'),'debug/relay-native-dashboard');
function fixture(){
 const home=mkdtempSync('/tmp/rr-tabs-'),root=join(home,'.local/state/agents-relay/rust-live');
 mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);
 writeFileSync(join(root,'.relay-rust-live-namespace-v1'),'rust-relay-owned-standalone-namespace-v1\n',{mode:0o600});
 const sourceRoot=join(home,'source');
 mkdirSync(join(sourceRoot,'skills/agents-relay'),{recursive:true});
 const qaFile=join(sourceRoot,'skills/agents-relay/troubleshooter-qa.md');
 writeFileSync(qaFile,'# Diagnostic Q&A\nExisting checked item.\n');
 const db=join(root,'relay.sqlite'),sql=new DatabaseSync(db);
 sql.exec('PRAGMA journal_mode=WAL; CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE relay_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE agent_snapshot(agent_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);');
 const job={id:'101',title:'Actual Job',repository:'agents-relay',state:'COMPLETED',projectRoot:'/private/secret',
  updatedAt:'2026-11-15T12:05:00.000Z',createdAt:'2026-11-15T12:00:00.000Z',
  tasks:[
   {id:'501',title:'Coordinator',state:'SUCCEEDED',attempt:2,adapter:'codex',input:'private input',output:{secret:'private output'},executionHistory:[{id:'one'}],
    updatedAt:'2026-11-15T12:04:00.000Z',routing:{provider:'openai',model:'gpt-6',reason:'policy'}},
   {id:'502',title:'Builder',state:'SUCCEEDED',attempt:1,adapter:'chatgpt',
    updatedAt:'2026-11-15T12:05:00.000Z',routing:{provider:'zai',model:'glm-5',reason:'capability'}}
  ]};
 sql.prepare('INSERT INTO job_snapshot(job_id,json,updated_at) VALUES(?,?,?)').run(job.id,JSON.stringify(job),job.updatedAt);
 sql.close();chmodSync(db,0o600);
 return {home,root,db,qaFile,sourceRoot,rulesPath:join(home,'.agents-relay/execution-router-rules.md'),
   env:{...process.env,HOME:home,AGENTS_RELAY_SOURCE_ROOT:sourceRoot,RELAY_RUST_LIVE_MODE:'pilot-live'}};
}
async function start(f){
 const socket=createServer();await new Promise(ok=>socket.listen(0,'127.0.0.1',ok));
 const port=socket.address().port;await new Promise(ok=>socket.close(ok));
 const child=spawn(executable,['--db',f.db,'--port',String(port)],{env:f.env,stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',b=>stderr+=b.toString());
 const base='http://127.0.0.1:'+port;
 for(let i=0;i<85;i++){
  if(child.exitCode!==null)throw Error('Dashboard exited '+stderr);
  try{if((await fetch(base+'/api/health')).ok)return {child,base}}catch{}
  await delay(25);
 }
 throw Error('Dashboard not ready '+stderr);
}
async function stop(child){
 if(!child||child.exitCode!==null)return;
 child.kill('SIGTERM');await Promise.race([new Promise(ok=>child.once('exit',ok)),delay(2500)]);
 if(child.exitCode===null){child.kill('SIGKILL');await new Promise(ok=>child.once('exit',ok))}
}
async function json(url){const r=await fetch(url);assert.equal(r.status,200,url);return r.json()}
function put(base,path,text,hash,origin=base){
 return fetch(base+path,{method:'PUT',headers:{'content-type':'application/json',origin},
  body:JSON.stringify({text,hash})});
}
test('Rust Dashboard all five views and native Jobs, Usage, Graphs, Router audit/inspection are real',async()=>{
 const f=fixture();let child;
 try{
  const server=await start(f);child=server.child;const {base}=server;
  const html=await(await fetch(base)).text();
  for(const tab of ['jobs','usage','rules','qa','graphs']){
   assert.ok(html.includes('id="'+tab+'-tab"'),'missing '+tab);
   assert.ok(html.includes('id="'+tab+'-view"'),'missing '+tab+' view');
  }
  assert.deepEqual((await json(base+'/api/views')).views,['jobs','usage','rules','qa','graphs']);
  assert.equal((await json(base+'/api/jobs')).jobs[0].id,'101');
  const browserJobs=await json(base+'/api/dashboard/jobs');
  assert.equal(browserJobs.jobs[0].tasks[0].id,'501');
  assert.equal(browserJobs.jobs[0].projectRoot,undefined);
  assert.equal(browserJobs.jobs[0].tasks[0].input,undefined);
  assert.equal(browserJobs.jobs[0].tasks[0].output,undefined);
  const browserJob=await json(base+'/api/dashboard/job?id=101');
  assert.equal(browserJob.id,'101'); assert.equal(browserJob.tasks.length,2);
  assert.equal(browserJob.tasks[0].input,undefined);
  assert.equal((await fetch(base+'/api/dashboard/job?id=missing')).status,404);
  const usage=await json(base+'/api/usage');
  assert.equal(usage.jobs,1);assert.equal(usage.tasks,2);assert.equal(usage.attempts,3);
  assert.equal(usage.executionRecords,1);assert.equal(usage.routes['openai / gpt-6'],1);
  assert.equal(usage.accountQuota.available,false);
  const graphs=await json(base+'/api/graphs');
  assert.equal(graphs.length,20);
  assert.ok(graphs.every(g=>g.source.length>20));
  assert.ok(graphs.find(g=>g.id==='main').source.includes('flowchart'));
  const symbol=await json(base+'/api/graph-symbol?graph=task-lifecycle&kind=Event&name=retry');
  assert.equal(symbol.graph.path,'workflow/task-lifecycle.mmd');
  assert.ok(symbol.graph.line>0);
  assert.equal((await fetch(base+'/api/graph-symbol?graph=../secret&kind=Event&name=retry')).status,404);
  const audit=await json(base+'/api/decision-audit');
  assert.equal(audit.length,2);
  const route=await json(base+'/api/router-test?job=101&task=501');
  assert.equal(route.routing.model,'gpt-6');assert.match(route.source,/not a fresh/);
  assert.equal((await fetch(base+'/api/router-test?job=101')).status,400);
 }finally{await stop(child);rmSync(f.home,{recursive:true,force:true})}
});
test('Router Rules and Q&A saved to isolated canonical files with CAS, local Origin and size protections',async()=>{
 const f=fixture();let child;
 try{
  const server=await start(f);child=server.child;const {base}=server;
  const rules=await json(base+'/api/execution-router-rules');
  assert.equal(rules.text,'');assert.match(rules.hash,/^[a-f0-9]{64}$/);
  const qa=await json(base+'/api/troubleshooter-qa');
  assert.equal(qa.text,'# Diagnostic Q&A\nExisting checked item.\n');
  assert.equal((await put(base,'/api/execution-router-rules','unauthorized',rules.hash,'https://other.example')).status,403);
  assert.equal(existsSync(f.rulesPath),false);
  const newRules='[choices]\nopenai: gpt-6 high\n\n[routing-instruction]\nPrefer known models.\n';
  const saved=await put(base,'/api/execution-router-rules',newRules,rules.hash);
  assert.equal(saved.status,200,await saved.text().catch(()=>''));
  assert.equal(readFileSync(f.rulesPath,'utf8'),newRules);
  const updated=await json(base+'/api/execution-router-rules');
  assert.notEqual(updated.hash,rules.hash);
  assert.equal((await put(base,'/api/execution-router-rules','stale',rules.hash)).status,409);
  assert.equal(readFileSync(f.rulesPath,'utf8'),newRules);
  assert.equal((await(await put(base,'/api/execution-router-rules',newRules,updated.hash)).json()).unchanged,true);
  const newQa='# Diagnostic Q&A\nUpdated answer.\n';
  assert.equal((await put(base,'/api/troubleshooter-qa',newQa,qa.hash)).status,200);
  assert.equal(readFileSync(f.qaFile,'utf8'),newQa);
  assert.equal((await put(base,'/api/troubleshooter-qa','stale',qa.hash)).status,409);
  assert.equal((await fetch(base+'/api/troubleshooter-qa',{method:'POST'})).status,405);
  const tooBig=await put(base,'/api/troubleshooter-qa','z'.repeat(133_000),(await json(base+'/api/troubleshooter-qa')).hash);
  assert.ok([400,413].includes(tooBig.status));
  // Form navigation works even if managed Chrome suspends background fetch.
  const formRules=new URLSearchParams({kind:'rules',hash:updated.hash,
    text:newRules+'# Edited in local form.\\n'});
  const form=await fetch(base+'/api/settings/save',{
    method:'POST',redirect:'manual',
    headers:{origin:base,'content-type':'application/x-www-form-urlencoded'},
    body:formRules
  });
  assert.equal(form.status,303);
  assert.equal(form.headers.get('location'),'/?save=saved-rules#/execution-router-rules');
  assert.match(readFileSync(f.rulesPath,'utf8'),/Edited in local form/);
  const staleForm=await fetch(base+'/api/settings/save',{
    method:'POST',redirect:'manual',
    headers:{origin:base,'content-type':'application/x-www-form-urlencoded'},
    body:formRules
  });
  assert.equal(staleForm.status,303);
  assert.equal(staleForm.headers.get('location'),'/?save=conflict-rules#/execution-router-rules');
  const forged=await fetch(base+'/api/settings/save',{
    method:'POST',redirect:'manual',
    headers:{origin:'https://attacker.example','content-type':'application/x-www-form-urlencoded'},
    body:formRules
  });
  assert.equal(forged.status,403);
  const qaCurrent=await json(base+'/api/troubleshooter-qa');
  const formQa=new URLSearchParams({kind:'qa',hash:qaCurrent.hash,
    text:'# Diagnostic Q&A\\nForm updated answer.\\n'});
  const qaResponse=await fetch(base+'/api/settings/save',{
    method:'POST',redirect:'manual',
    headers:{origin:base,'content-type':'application/x-www-form-urlencoded'},
    body:formQa
  });
  assert.equal(qaResponse.status,303);
  assert.equal(qaResponse.headers.get('location'),'/?save=saved-qa#/troubleshooter-qa');
  assert.match(readFileSync(f.qaFile,'utf8'),/Form updated answer/);
  // Dynamic HTML must escape potentially hostile Markdown embedded as JSON.
  const qaBeforeInjection=await json(base+'/api/troubleshooter-qa');
  const malicious='</script><script>window.__injected=1</script>\\n';
  assert.equal((await put(base,'/api/troubleshooter-qa',malicious,qaBeforeInjection.hash)).status,200);
  const html=await(await fetch(base)).text();
  assert.ok(html.includes('\\u003c/script>'));
  assert.ok(!html.includes(malicious));
  assert.equal(readFileSync(f.qaFile,'utf8'),malicious);
 }finally{await stop(child);rmSync(f.home,{recursive:true,force:true})}
});
