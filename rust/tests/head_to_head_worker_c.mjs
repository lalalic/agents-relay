// Direct randomized Node/Rust differential test of owned dashboard, feedback and events exports.
// Builds offline, and never touches ~/.agents-relay or live SQLite.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import * as dashboard from '../../dist/dashboard-data.js';
import * as feedback from '../../dist/feedback.js';
import * as events from '../../dist/events.js';
const repo=resolve(fileURLToPath(new URL('../..',import.meta.url)));
let seed=0x17ace;function next(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;}function choose(a){return a[next()%a.length]}
const cases=[];
const add=(op,payload,node)=>cases.push({op,payload,node});
const evalNode=async c=>{try{return JSON.parse(JSON.stringify({ok:true,value:await c.node()??null}))}catch(error){return {ok:false,error:error.message}}};
const randJob=(i)=>({id:`job-${i}`,repository:choose(['some-org/agents-relay','Alpha/Beta','other','école','']),state:choose(['ACTIVE','COMPLETED','DRAFT','CANCELLED','PAUSED','']),title:choose(['Hello','PR #22','hello Ü','Something else','']),draft:next()%5===0,updatedAt:choose(['2026-11-17T06:00:00Z','2026-11-17T03:00:00Z','2026-11-18T02:00:00Z','invalid',undefined]),createdAt:choose(['2026-11-17T00:00:00Z','2026-11-15T09:00:00Z',undefined]),prNumber:choose([0,1,22,300,undefined])});
for(let k=0;k<68;k++){
 const jobs=Array.from({length:next()%85},(_,i)=>randJob(i));
 const query=new URLSearchParams();const key=choose(['status','statuses','repo','repositories','repos','q','empty']);const value=key==='status'||key==='statuses'?choose(['ACTIVE','completed','CANCELLED','paused',' DRAFT ','']):key==='q'?choose(['PR #','22','hello','job',' #2','']):choose(['some-org/agents-relay','Alpha/Beta','other','']);if(key!=='empty')query.set(key,value);
 add('dashboard.search',{jobs,query:query.toString()},()=>dashboard.searchDashboardJobs(jobs,query));
 const repository=choose(['','other','Alpha/Beta','x']);add('dashboard.inventory',{jobs,repository},()=>dashboard.listDashboardJobInventory(jobs,repository));
}
for(let i=0;i<85;i++){
 const repository=choose(['owner/repo','a/b','a/..','a/.','one-two/repo.name','a.b/slug','owner/repo/path','é/x','a/abc','']) ;
 const prNumber=choose([1,2,0,-1,4.2,NaN,null,'3',4294967296]);
 add('dashboard.githubPrUrl',{repository,prNumber},()=>dashboard.githubPrUrl(repository,prNumber));
 const bucket=()=>({limit:choose([0,1,10,100,-1,NaN]),remaining:choose([1,0,10,-1,40,NaN]),reset:choose([100,200,NaN])});
 const snapshot=choose([null,{resources:{core:bucket(),graphql:bucket(),search:bucket()}}]);const runtime=choose([null,{resources:{core:bucket(),graphql:bucket(),search:bucket()}}]);
 add('dashboard.githubUsage',{snapshot,runtime},()=>dashboard.effectiveGitHubUsage(snapshot,runtime));
}
add('dashboard.graphs',{directory:resolve(repo,'workflow')},()=>dashboard.dashboardWorkflowGraphs());
const provenance=()=>({source:choose(['app','extension','other']),product:choose(['ToyAlive',' x ','测试','', 'hello >']),actorClass:'internal-test',submittedAt:choose(['2026-11-17T06:00:00Z','2026-11-16T09:00:00.100Z','bad','2026-11-17T06:00:00+05:00']),surface:choose(['capture','color','',undefined]),contact:choose([undefined,{channel:'email',value:' test@x.org '}])});
for(let i=0;i<85;i++){
 const text=choose(['simple report','Bearer abcdefgh test','token: abcd\nsk_abcdefghijklmno','Test abc > xyz','api_key: 12345','pk_abcdefghijklmno','  xy  ']);
 add('feedback.redact',{text},()=>feedback.redactSensitiveText(text));
 const value=choose([{one:1,more:'> value'},{text:'שלום >\nFoo',nested:{x:[1,2]}},null,3]);
 add('feedback.marker',{label:'agents-relay:feedback:v1',value},()=>feedback.marker('agents-relay:feedback:v1',value));
 const record={schema:feedback.FEEDBACK_MARKER,schemaVersion:1,id:'123',userContent:{text},attachments:[],systemProvenance:provenance(),triage:{status:'new',updatedAt:'2026-11-17T06:00:00Z'},downstream:[],createdAt:'2026-11-17T06:00:00Z'};
 add('feedback.renderMarker',{record},()=>feedback.renderFeedbackMarker(record));
 const textMarker=feedback.renderFeedbackMarker(record);add('feedback.parseMarker',{text:textMarker},()=>feedback.parseFeedbackMarker(textMarker));
 const submission={text:choose(['feedback','Bearer abcdefgh','abc > def','']),provenance:provenance(),sanitized:next()%2===0,visibility:choose(['public','private','internal']),attachments:choose([undefined,[],[{reference:'attachment://ok',mimeType:'image/png',sizeBytes:123}], [{reference:'https://x/y?auth=1',mimeType:'image/gif',sizeBytes:100}]])};
 const options={id:'feedback-fixture-1',receivedAt:'2026-11-17T06:00:00.000Z',sanitize:next()%2===0};
 add('feedback.createLegacy',{submission,options},()=>feedback.createFeedbackRecord(submission,options));
 const legacy={schema:feedback.FEEDBACK_SCHEMA,schemaVersion:1,id:'feedback-abc',userContent:{text},attachments:[{reference:'a.png',mimeType:'image/png',sizeBytes:5,id:'attachment-1'}],provenance:{source:'app',product:'ToyAlive',actorClass:'internal-test',submittedAt:'2026-11-17T06:00:00Z'},triage:{status:'new'},downstream:{work:[]}};
 add('feedback.fingerprint',{record:legacy},()=>feedback.feedbackFingerprint(legacy));
 add('feedback.markdown',{record:legacy},()=>feedback.renderFeedbackMarkdown(legacy));
 add('feedback.workProvenance',{record:legacy},()=>feedback.feedbackWorkProvenance(legacy));
}
for(let i=0;i<45;i++){
 const value=choose(['job1','a_b-c','a.b','no spaces','xyz/3','', '\n','x😀','été','AA11']);
 add('events.subjectToken',{value},()=>events.subjectToken(value));
 add('events.subjectPrefix',{value},()=>new events.NatsEventBus(undefined,value).constructor.name?value:value);
}
const run=spawnSync('cargo',['build','--offline','--example','worker_c_parity','--manifest-path','rust/Cargo.toml'],{cwd:repo,encoding:'utf8',maxBuffer:5e6});assert.equal(run.status,0,run.stderr);
const exe=resolve(repo,'rust/target/debug/examples/worker_c_parity');
test('Worker C Node/Rust randomized differential fixtures, exact values and error text',async()=>{
 const expected=await Promise.all(cases.map(evalNode));
 const input=cases.map(({op,payload})=>JSON.stringify({op,payload})).join('\n')+'\n';
 const proc=spawnSync(exe,[],{input,encoding:'utf8',maxBuffer:18*1024*1024});assert.equal(proc.status,0,proc.stderr);
 const actual=proc.stdout.trimEnd().split('\n').map(line=>JSON.parse(line));assert.equal(actual.length,expected.length);
 let count=0;const mismatches=[];for(let i=0;i<cases.length;i++) {try{assert.deepStrictEqual(actual[i],expected[i]);count++;}catch(error){mismatches.push({fixture:i,op:cases[i].op,payload:JSON.stringify(cases[i].payload).slice(0,180),actual:JSON.stringify(actual[i]).slice(0,350),expected:JSON.stringify(expected[i]).slice(0,350),diff:error.message.slice(0,500)})}}
 console.log(`Compared ${count+ mismatches.length} fixtures, PASS ${count}, FAIL ${mismatches.length}`);
 if(mismatches.length){for(const m of mismatches.slice(0,18))console.log(JSON.stringify(m));const fs=await import("node:fs");fs.writeFileSync("/tmp/rust2-worker-c-differential-mismatches-20261117.json",JSON.stringify(mismatches,null,2));}
 assert.equal(mismatches.length,0,`Node/Rust mismatches: ${mismatches.length}; see /tmp/rust2-worker-c-differential-mismatches-20261117.json`);
});
