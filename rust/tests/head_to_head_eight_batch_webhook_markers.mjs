// Direct Node/Rust differential: src/github-webhook.ts and src/markers.ts, including HMAC authenticity, canonical event parsing, comment safety, and historical body round-trips.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {createHmac} from 'node:crypto';
import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import * as webhook from '../../dist/github-webhook.js';import * as markers from '../../dist/markers.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let built=false;
function rust(req){if(!built){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);built=true;}
 const r=spawnSync(bin,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:12000,maxBuffer:6*1024*1024});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim());}
function node(req){try{let value;
 switch(req.op){
 case 'parseGitHubWebhook':value=webhook.parseGitHubWebhook(req.headers,Buffer.from(req.body));break;
 case 'parsePackagePublicationMarker':value=webhook.parsePackagePublicationMarker(req.body);break;
 case 'parsePackagePublishFailureMarker':value=webhook.parsePackagePublishFailureMarker(req.body);break;
 case 'verifyGitHubWebhook':value=webhook.verifyGitHubWebhook(req.secret,Buffer.from(req.body),req.signature);break;
 case 'deliveryDeduperScenario':{
  const deduper=new webhook.DeliveryDeduper(req.ttlMs,req.maxEntries);value=req.operations.map(op=>op.action==='has'?deduper.has(op.id,op.now):deduper.accept(op.id,op.now));break;
 }
 case 'marker':value=markers.marker(req.label,req.value);break;
 case 'parseMarker':value=markers.parseMarker(req.body,req.label);break;
 case 'renderJobBody':value=markers.renderJobBody(req.job);break;
 case 'renderJobComment':value=markers.renderJobComment(req.job);break;
 case 'renderTaskComment':value=markers.renderTaskComment(req.task);break;
 case 'parseJob':value=markers.parseJob(req.body);break;
 case 'parseTask':value=markers.parseTask(req.body);break;
 case 'renderPlanComment':value=markers.renderPlanComment(req.plan);break;
 case 'parsePlan':value=markers.parsePlan(req.body);break;
 case 'renderAgentComment':value=markers.renderAgentComment(req.agent);break;
 case 'parseAgent':value=markers.parseAgent(req.body);break;
 default:throw Error('unknown op');
 }
 return {ok:true,value:JSON.parse(JSON.stringify(value))};}catch(e){return {ok:false,error:e.message}}}
let seed=0x49dda310;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;},pick=a=>a[rand(a.length)];
const markerPublication=body=>`<!-- ${webhook.PACKAGE_PUBLISHED_MARKER} ${JSON.stringify(body)} -->`;
const markerFailure=body=>`<!-- ${webhook.PACKAGE_FAILED_MARKER} ${JSON.stringify(body)} -->`;
const publishCases=[];
for(let i=0;i<500;i++){
 const published={package:pick(['agents-relay','panda','']),version:pick(['0.1.0','2.3.4','']),registry:pick([null,'https://registry.npmjs.org','other']),sha:pick([null,'abc123']),jobId:pick(['5','7',undefined,''])};
 const failure={runId:pick(['9','123','not-number','-1','0','٣']),attempt:pick([1,2,0,-1,1.5]),sha:pick(['abcdef7','f'.repeat(40),'BAD1234','broken']),stage:pick(['test','build','']),jobId:pick(['5',undefined,''])};
 publishCases.push({op:'parsePackagePublicationMarker',body:pick([null,'garbage',markerPublication(published),markerPublication(published)+' extra'])});
 publishCases.push({op:'parsePackagePublishFailureMarker',body:pick([null,'garbage',markerFailure(failure),markerFailure(failure)+'-->' ])});
}
test('safe package markers parse exactly as Node across missing/invalid/trusted payloads',()=>{
 for(const [i,req] of publishCases.entries())assert.deepEqual(rust(req),node(req),`package marker ${i}: ${JSON.stringify(req).slice(0,300)}`);
 console.log(`Verified ${publishCases.length} package marker parsing cases`);
});
const events=[];
for(let i=0;i<580;i++){
 const event=pick(['pull_request','issue_comment','commit_comment','ping']);
 const action=pick(['closed','synchronize','created','edited',undefined]);
 const publication=markerPublication({package:'agents-relay',version:'1.2.3',registry:'npm',sha:'abc123',jobId:pick(['56',undefined])});
 const fail=markerFailure({runId:'123',attempt:1,sha:'abcdef7',stage:'build',jobId:pick(['56',undefined])});
 const payload={action,repository:{full_name:pick(['owner/repo','project',''])},pull_request:{number:pick([10,0,undefined,15]),merged:pick([true,false]),
   head:{ref:pick(['feat/test',undefined]),sha:pick(['abcdef7',undefined])},updated_at:pick(['2026-11-17T04:00:00Z',undefined,'invalid'])},
   issue:{number:pick([10,0,20]),pull_request:pick([undefined,{}, {url:'https://example.com'}])},
   comment:{user:{login:pick(['github-actions[bot]','random-user'])},body:pick([publication,fail,'Unrelated comment']),created_at:pick(['2026-11-17T03:00:00Z',undefined])}};
 events.push({op:'parseGitHubWebhook',headers:{'x-github-delivery':`d-${i}`,'x-github-event':event},body:JSON.stringify(payload)});
}
test('webhook event identity and publication trust boundaries match original Node',()=>{
 for(const [i,req] of events.entries())assert.deepEqual(rust(req),node(req),`webhook ${i}: ${JSON.stringify(req).slice(0,300)}`);
 console.log(`Verified ${events.length} GitHub webhook event/trusted-comment histories`);
});
const hmac=[];
for(let i=0;i<280;i++){
 const secret=pick(['secret','long-secret-value','', '🚀 UTF-8 test', 'f'.repeat(65)]),body=pick(['hello world',JSON.stringify({hello:'world'}),'中文任务','']);
 const correct='sha256='+createHmac('sha256',secret).update(Buffer.from(body)).digest('hex');
 hmac.push({op:'verifyGitHubWebhook',secret,body,signature:pick([correct,correct,'sha256=bad',correct.toUpperCase(),undefined])});
}
test('HMAC SHA256 webhook verification agrees with Node for UTF-8, long keys and invalid signatures',()=>{
 for(const [i,req] of hmac.entries())assert.deepEqual(rust(req),node(req),`hmac ${i}`);
 console.log(`Verified ${hmac.length} HMAC-SHA256 webhook signatures`);
});
const dedupe=[];
for(let i=0;i<240;i++){
 const req={op:'deliveryDeduperScenario',ttlMs:pick([0,1,1000,10000]),maxEntries:pick([1,2,3,20]),operations:[]};
 for(let j=0;j<12+rand(16);j++)req.operations.push({action:pick(['accept','accept','has']),id:pick(['a','b','c','d']),now:pick([0,100,800,1200,2500,5000])});
 dedupe.push(req);
}
test('timestamp-bounded webhook delivery deduplication matches Node',()=>{
 for(const [i,req] of dedupe.entries())assert.deepEqual(rust(req),node(req),`dedupe ${i}`);
 console.log(`Verified ${dedupe.length} webhook receipt history windows`);
});
const mCases=[];
for(let i=0;i<430;i++){
 const job={id:`job-${i}`,repository:'repo',title:'Job '+i,objective:pick(['Objective text','',undefined,'\n # Title','Chinese 中文']),
   state:'ACTIVE',prNumber:i%5,tasks:[],plans:[],metadata:{note:pick(['hello','dangerous --> comment','<div>'])},schedule:'obsolete'};
 const task={id:`task-${i}`,state:'RUNNING',priority:pick(['P0','P2',undefined]),kind:pick(['work','planner',undefined]),
   input:pick(['Do work','', 'Describe\nwith newlines','hello --> unsafe']),agentGraph:pick([undefined,'flowchart LR\nA --> B']),
   result:pick([undefined,{summary:'done'}, {summary:' '}] )};
 const plan={id:`plan-${i}`,jobId:job.id,round:i%10,trigger:{source:'event',taskIds:pick([[],['task-a','task-b']]),reason:pick([undefined,'revised'])},
   status:'COMPLETED',assessment:'Plan done',generatedTaskIds:pick([[],['t1','t2']]),planUrl:pick(['https://github.com',undefined])};
 const agent={id:`agent-${i}`,name:'designer',role:'builder',availability:'available'};
 const label=pick([markers.JOB_MARKER,markers.TASK_MARKER,markers.PLAN_MARKER,markers.AGENT_MARKER,'labels.$*']);
 mCases.push({op:'marker',label,value:pick([job,task,plan,agent,{description:'danger > inline <!-- and -->',arr:[1,2]}])});
 mCases.push({op:'renderJobBody',job},{op:'renderJobComment',job},{op:'renderTaskComment',task},{op:'renderPlanComment',plan},{op:'renderAgentComment',agent});
 const jobbody=markers.renderJobComment(job),taskbody=markers.renderTaskComment(task),planbody=markers.renderPlanComment(plan),agentbody=markers.renderAgentComment(agent);
 mCases.push({op:'parseJob',body:jobbody},{op:'parseTask',body:taskbody},{op:'parsePlan',body:planbody},{op:'parseAgent',body:agentbody});
 mCases.push({op:'parseMarker',label:markers.JOB_MARKER,body:jobbody},{op:'parseMarker',label:'other-tag',body:jobbody});
}
test('Job Task Plan and Agent HTML markers roundtrip current and legacy payloads byte-for-byte',()=>{
 for(const [i,req] of mCases.entries())assert.deepEqual(rust(req),node(req),`marker ${i}: ${JSON.stringify(req).slice(0,300)}`);
 console.log(`Verified ${mCases.length} Node/Rust Job/Task/Plan/Agent metadata markers`);
});

test('historical marker nullish-vs-empty fields agree with Node (empty string never falls through)',()=>{
 const reqs=[
  {op:'parseJob',body:markers.marker(markers.JOB_MARKER,{id:'j',objective:'',description:'must not replace explicit empty'})+'\nBody fallback'},
  {op:'parseTask',body:markers.marker(markers.TASK_MARKER,{id:'t',input:'',kind:'planner'})+'\n### Work\n\nshould not replace explicit empty'},
  {op:'parseJob',body:markers.marker(markers.JOB_MARKER,{id:'j',objective:null,description:'legacy description'})+'\nNo value'},
  {op:'parseTask',body:markers.marker(markers.TASK_MARKER,{id:'t',input:null})+'\n### Work\n\nlegacy task description'},
 ];
 for(const [i,req] of reqs.entries())assert.deepEqual(rust(req),node(req),`historical nullish marker ${i}`);
 console.log('Verified four explicit empty/null historical Job/Task markers');
});
