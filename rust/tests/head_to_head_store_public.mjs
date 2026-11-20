// Direct original Node src/store.ts public surface vs Rust parity adapter:
// loadManagedGitHubPullRequestSnapshotGraphql parsing, dashboardManagedJobs
// ordering, listManagedGitHubJobs pagination over an offline fixture client
// and the full InMemoryStore mutation surface. No network, no live GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {
  InMemoryStore,
  dashboardManagedJobs,
  loadManagedGitHubPullRequestSnapshotGraphql,
  listManagedGitHubJobs,
} from '../../dist/store.js';

const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const scratch=mkdtempSync(join(tmpdir(),'rust2-store-public-'));
test.after(()=>rmSync(scratch,{force:true,recursive:true}));
let seed=0x51f0a3;function rand(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
const pick=arr=>arr[rand()%arr.length];
const at='2026-11-18T09:00:00.000Z';
const trustedAuthors=new Set(['alice','bob']);

// ---------- snapshotParse: loadManagedGitHubPullRequestSnapshotGraphql ----------
function commentRow(databaseId,login,body,extra={}){
 return {id:'NODE_'+databaseId,databaseId,url:`https://github.com/t/r/pull/9#issuecomment-${databaseId}`,
  updatedAt:extra.updatedAt??'2026-11-18T08:00:00.000Z',author:{login},body,...extra};
}
function prNode(overrides={}){
 const comments=overrides.comments??[
  commentRow(1,'alice','<!-- agents-relay:job:v1 {"id":"j1","title":"A"} -->\njob body'),
  commentRow(2,'mallory','<!-- agents-relay:job:v1 {"id":"jX","title":"evil"} -->'),
  commentRow(3,'alice','<!-- agents-relay:plan:v1 {"id":"p1","jobId":"j1","round":2} -->'),
  commentRow(4,'alice','<!-- agents-relay:plan:v1 {"id":"p0","jobId":"j1","round":1} -->'),
  commentRow(5,'bob','<!-- agents-relay:task:v1 {"id":"t1","jobId":"j1","input":"work"} -->'),
  commentRow(6,'bob','<!-- agents-relay:task:v1 {"id":"t2","input":"orphan"} -->'),
  commentRow(7,'github-actions[bot]','<!-- agents-relay:package-publication:v1 {"version":"1.2.3","tag":"v1.2.3"} -->'),
 ];
 return {id:'PR_1',state:'OPEN',isDraft:true,merged:false,mergedAt:null,closedAt:null,
  body:overrides.body??'<!-- agents-relay:job:v1 {"id":"j1","title":"A"} -->',
  headRefName:'feature',headRefOid:'a'.repeat(40),
  comments:{totalCount:comments.length,nodes:comments},...overrides.extra};
}
function snapshotResponse(pr){return {repository:{pullRequest:pr}};}

const snapshotCases=[
 // 1: canonical multi-marker PR
 {repository:'owner/name',prNumber:9,response:snapshotResponse(prNode())},
 // 2: no PR (null)
 {repository:'owner/name',prNumber:9,response:{repository:{pullRequest:null}}},
 // 3: bad repository split
 {repository:'invalid',prNumber:9,response:snapshotResponse(prNode())},
 {repository:'/name',prNumber:9,response:snapshotResponse(prNode())},
 {repository:'owner/',prNumber:9,response:snapshotResponse(prNode())},
 // 4: invalid prNumber
 {repository:'owner/name',prNumber:0,response:snapshotResponse(prNode())},
 {repository:'owner/name',prNumber:-4,response:snapshotResponse(prNode())},
 // 5: body has no job -> fall back to trusted comment jobs
 {repository:'owner/name',prNumber:9,response:snapshotResponse(prNode({
  body:'plain description without markers',
  comments:[commentRow(11,'alice','<!-- agents-relay:job:v1 {"id":"jc1"} -->'),
   commentRow(12,'alice','<!-- agents-relay:job:v1 {"id":"jc2"} -->'),
   commentRow(13,'bob','<!-- agents-relay:task:v1 {"id":"t9","jobId":"jc2"} -->')]}))},
 // 6: merged PR state
 {repository:'owner/name',prNumber:9,response:snapshotResponse(prNode({
  extra:{state:'MERGED',merged:true,mergedAt:'2026-11-17T10:00:00.000Z',isDraft:false}}))},
 // 7: comments truncated (totalCount > rows) -> seed comments null
 {repository:'owner/name',prNumber:9,response:snapshotResponse(prNode({
  comments:{totalCount:200,nodes:[commentRow(1,'alice','<!-- agents-relay:job:v1 {"id":"j1"} -->')]}}))},
 // 8: comment lacks url but has integer databaseId -> planUrl fallback
 {repository:'owner/name',prNumber:9,response:snapshotResponse(prNode({
  comments:[{databaseId:77,updatedAt:'2026-11-18T08:00:00.000Z',author:{login:'alice'},
   body:'<!-- agents-relay:job:v1 {"id":"j1"} -->'},
   {databaseId:78,updatedAt:'2026-11-18T08:00:00.000Z',author:{login:'alice'},
    body:'<!-- agents-relay:plan:v1 {"id":"p1","jobId":"j1","round":1} -->'},
   {databaseId:79,updatedAt:'2026-11-18T08:00:00.000Z',author:{login:'alice'},
    body:'<!-- agents-relay:task:v1 {"id":"t1","jobId":"j1","input":"w"} -->'}]}))},
 // 9: publication only from untrusted bot or trusted authors
 {repository:'owner/name',prNumber:9,response:snapshotResponse(prNode({
  comments:[commentRow(1,'alice','<!-- agents-relay:job:v1 {"id":"j1"} -->'),
   commentRow(2,'rando','<!-- agents-relay:package-publication:v1 {"version":"9.9.9"} -->'),
   commentRow(3,'github-actions','<!-- agents-relay:package-publication:v1 {"version":"2.0.0"} -->')]}))},
 // 10: task with null jobId adopted by single job
 {repository:'owner/name',prNumber:9,response:snapshotResponse(prNode({
  comments:[commentRow(1,'alice','<!-- agents-relay:job:v1 {"id":"j1"} -->'),
   commentRow(2,'alice','<!-- agents-relay:task:v1 {"id":"tn","jobId":null,"input":"w"} -->')]}))},
 // 11: task with empty-string jobId adopted by single job
 {repository:'owner/name',prNumber:9,response:snapshotResponse(prNode({
  comments:[commentRow(1,'alice','<!-- agents-relay:job:v1 {"id":"j1"} -->'),
   commentRow(2,'alice','<!-- agents-relay:task:v1 {"id":"te","jobId":"","input":"w"} -->')]}))},
 // 12: multiple jobs -> taskId-less tasks not adopted
 {repository:'owner/name',prNumber:9,response:snapshotResponse(prNode({
  body:'plain',comments:[commentRow(1,'alice','<!-- agents-relay:job:v1 {"id":"ja"} -->'),
   commentRow(2,'alice','<!-- agents-relay:job:v1 {"id":"jb"} -->'),
   commentRow(3,'alice','<!-- agents-relay:task:v1 {"id":"t1","input":"w"} -->')]}))},
 // 13: job description fallback from PR body
 {repository:'owner/name',prNumber:9,response:snapshotResponse(prNode({
  body:'<!-- agents-relay:job:v1 {"id":"j1"} -->\n\nA rich description'}))},
 // 14: no headRefOid -> job.headSha untouched
 {repository:'owner/name',prNumber:9,response:snapshotResponse(prNode({extra:{headRefOid:undefined}}))},
 // 15: plan round ordering (round 2 before round 1)
 {repository:'owner/name',prNumber:9,response:snapshotResponse(prNode({
  comments:[commentRow(1,'alice','<!-- agents-relay:job:v1 {"id":"j1"} -->'),
   commentRow(2,'alice','<!-- agents-relay:plan:v1 {"id":"p2","jobId":"j1","round":5} -->'),
   commentRow(3,'alice','<!-- agents-relay:plan:v1 {"id":"p1","jobId":"j1","round":2} -->'),
   commentRow(4,'alice','<!-- agents-relay:plan:v1 {"id":"px","jobId":"other","round":1} -->')]}))},
];

// Node parseJob always assigns `objective` (possibly undefined); JSON wire in
// the Rust stack cannot express an undefined-valued key, so normalize it away.
function stripUndefined(object){
 for(const key of Object.keys(object)){
  if(object[key]===undefined)delete object[key];
  else if(object[key]&&typeof object[key]==='object')stripUndefined(object[key]);
 }
}
async function nodeSnapshot(f){
 const client={graphql:async()=>structuredClone(f.response)};
 const value=await loadManagedGitHubPullRequestSnapshotGraphql(client,f.repository,f.prNumber,trustedAuthors);
 stripUndefined(value);
 return value;
}

// ---------- dashboardManagedJobs ----------
function overview(prNumber,state,updatedAt,mergedAt=null,closedAt=null){
 return {job:{prNumber,state,updatedAt,id:'job-'+prNumber},githubState:'OPEN',draft:false,
  mergedAt,closedAt,publication:null};
}
const dashboardCases=[
 [],
 [overview(1,'ACTIVE','2026-11-01T00:00:00.000Z')],
 [overview(1,'COMPLETED','2026-11-01T00:00:00.000Z'),overview(2,'ACTIVE','2026-11-02T00:00:00.000Z')],
 Array.from({length:15},(_,i)=>overview(i+1,'CANCELLED',`2026-11-${String(10+i).padStart(2,'0')}T00:00:00.000Z`)),
 Array.from({length:15},(_,i)=>overview(i+1,'CANCELLED',`2026-11-${String(10+i).padStart(2,'0')}T00:00:00.000Z`)).concat(
  [overview(99,'COMPLETED','2026-11-18T00:00:00.000Z'),overview(98,'ACTIVE','2026-11-01T00:00:00.000Z')]),
 [overview(5,'COMPLETED','2026-11-01T00:00:00.000Z',null,'2026-11-03T00:00:00.000Z'),
  overview(6,'COMPLETED','2026-11-02T00:00:00.000Z','2026-11-05T00:00:00.000Z'),
  overview(7,'COMPLETED','2026-11-09T00:00:00.000Z')],
 [overview(3,'COMPLETED','2026-11-01T00:00:00.000Z'),overview(3,'CANCELLED','2026-11-01T00:00:00.000Z'),
  overview(2,'CANCELLED','2026-11-01T00:00:00.000Z')],
 [overview(1,'failed','2026-11-01T00:00:00.000Z'),overview(1,'RUNNING','2026-11-01T00:00:00.000Z')],
 [{job:{prNumber:1,state:'COMPLETED',updatedAt:''},githubState:'OPEN',draft:false,
  mergedAt:'2026-11-02T00:00:00.000Z',closedAt:null,publication:null}],
];

// ---------- listManagedGitHubJobs: paginated fixture client ----------
function listPr(number,state,merged,comments,jobsFromBody){
 const body=jobsFromBody?'<!-- agents-relay:job:v1 {"id":"j'+number+'"} -->':'plain body';
 return {number,body,state,isDraft:false,merged,mergedAt:merged?'2026-11-10T00:00:00.000Z':null,
  closedAt:null,comments:{nodes:comments}};
}
function managedResponse(prs,page={}){
 return {repository:{open:{nodes:prs,pageInfo:{hasNextPage:page.more===true,
  endCursor:page.cursor??null}}}};
}
const listCases=[
 // single open PR with trusted job+task
 {repository:'o/n',responses:[managedResponse([listPr(7,'OPEN',false,[
   {author:{login:'alice'},body:'<!-- agents-relay:task:v1 {"id":"t1","jobId":"j7","input":"w"} -->'}],true)])]},
 // pagination: clean two pages
 {repository:'o/n',responses:[managedResponse([listPr(1,'OPEN',false,[],true)],{more:true,cursor:'c1'}),
   managedResponse([listPr(2,'OPEN',false,[],true)])]},
 // invalid repository
 {repository:'bad',responses:[]},
 {repository:'a/',responses:[]},
 // graphql error mid-pagination
 {repository:'o/n',responses:[managedResponse([listPr(1,'OPEN',false,[],true)],{more:true,cursor:'c1'}),
   {fixtureError:'503 during pagination'}]},
 // merged detection via state string only
 {repository:'o/n',responses:[{repository:{open:{nodes:[listPr(9,'OPEN',false,[],true)],pageInfo:{hasNextPage:false,endCursor:null}},
   recentMerged:{nodes:[listPr(4,'MERGED',false,[],true)]}}}]},
 // job from comment when body has none; multiple jobs share tasks by id
 {repository:'o/n',responses:[managedResponse([listPr(5,'OPEN',false,[
   {author:{login:'bob'},body:'<!-- agents-relay:job:v1 {"id":"jb1"} -->'},
   {author:{login:'bob'},body:'<!-- agents-relay:job:v1 {"id":"jb2"} -->'},
   {author:{login:'bob'},body:'<!-- agents-relay:task:v1 {"id":"t5","jobId":"jb2","input":"w"} -->'}],false)])]},
 // pr number zero -> skipped
 {repository:'o/n',responses:[managedResponse([{number:0,body:'<!-- agents-relay:job:v1 {"id":"j0"} -->',
   state:'OPEN',isDraft:false,merged:false,mergedAt:null,closedAt:null,comments:{nodes:[]}}])]},
 // string pr number coerced by Number()
 {repository:'o/n',responses:[managedResponse([{number:'12',body:'<!-- agents-relay:job:v1 {"id":"j12"} -->',
   state:'OPEN',isDraft:false,merged:false,mergedAt:null,closedAt:null,comments:{nodes:[]}}])]},
];
async function nodeList(f){
 const responses=structuredClone(f.responses);
 const calls=[];
 const client={graphql:async(query,variables)=>{
  calls.push({kind:'graphql',query,variables});
  const value=responses.shift();
  if(value===undefined)throw Error('Fixture GitHub effect exhausted');
  if(value.fixtureError)throw Error(value.fixtureError);
  return value;
 }};
 try{
  const value=await listManagedGitHubJobs(client,f.repository,trustedAuthors);
  stripUndefined(value);
  return {outcome:{ok:true,value},calls};
 }catch(error){return {outcome:{ok:false,error:error.message},calls};}
}

// ---------- InMemoryStore end-to-end scripts ----------
function baseJob(index){
 return {id:'job-'+index,title:'Job '+index,repository:'fixture/repo',prNumber:index,
  state:'ACTIVE',createdAt:at,updatedAt:at,tasks:[],plans:[],review:null,
  description:'desc-'+index};
}
function planOf(jobId,id,round){return {id,jobId,round,status:'PENDING',
 trigger:{source:'planner',taskIds:[],reason:'fixture'},
 generatedTaskIds:[],assessment:'fixture assessment'};}
function taskOf(jobId,id,extra={}){return {id,jobId,kind:'work',status:'PENDING',input:'do work',...extra};}
const storeScripts=[];
for(let i=0;i<16;i++){
 const j=baseJob(i+1);
 const other=baseJob(i+100);
 const scripts=[
  // constructor seeds job+plans+tasks; load roundtrip
  {job:{...j,plans:[planOf(j.id,'p1',2),planOf(j.id,'p0',1)],
    tasks:[taskOf(j.id,'t1'),taskOf(null,'t-orphan')]},
   actions:[
    {m:'load',id:j.id},
    {m:'saveAgent',agent:{id:'ag-'+i,name:'Agent',capabilities:['review'],skills:[]}},
    {m:'listAgents'},
    {m:'headSha'},
    {m:'comments'},
   ]},
  // append idempotence + conflict
  {job:j,actions:[
    {m:'appendPlan',plan:planOf(j.id,'p1',1)},
    {m:'appendPlan',plan:planOf(j.id,'p1',1)},
    {m:'appendPlan',plan:planOf(j.id,'p1',2)},
    {m:'appendTask',task:taskOf(j.id,'t1')},
    {m:'appendTask',task:taskOf(j.id,'t1')},
    {m:'appendTask',task:taskOf(j.id,'t1',{status:'RUNNING'})},
    {m:'load',id:j.id},
   ]},
  // mutateJob patch + unparseable current marker fallback
  {job:j,actions:[
    {m:'mutateJob',id:j.id,patch:{state:'COMPLETED',updatedAt:'2026-11-18T10:00:00.000Z'}},
    {m:'mutateJob',id:j.id,patch:{tasks:[taskOf(j.id,'t9')]}},
    {m:'load',id:j.id},
    {m:'load',id:'missing'},
   ]},
  // second job present -> orphan task no longer adopted by sole-job rule
  {job:j,actions:[
    {m:'saveJob',job:other},
    {m:'saveTask',task:taskOf(null,'t-orphan')},
    {m:'load',id:j.id},
    {m:'load',id:other.id},
   ]},
 ];
 storeScripts.push(scripts[i%scripts.length]);
}
async function nodeStore(script){
 const store=new InMemoryStore(script.job?structuredClone(script.job):undefined);
 const outcomes=[];
 for(const action of script.actions){
  try{
   let value;
   switch(action.m){
    case 'saveJob':await store.saveJob(structuredClone(action.job));value=null;break;
    case 'load':value=await store.load(action.id);break;
    case 'mutateJob':value=await store.mutateJob(action.id,job=>{
      // Declarative patch mirroring the Rust adapter's fixture mutation.
      return {...structuredClone(job),...structuredClone(action.patch)};
     });break;
    case 'appendPlan':await store.appendPlan(structuredClone(action.plan));value=null;break;
    case 'savePlan':await store.savePlan(structuredClone(action.plan));value=null;break;
    case 'appendTask':await store.appendTask(structuredClone(action.task));value=null;break;
    case 'saveTask':await store.saveTask(structuredClone(action.task));value=null;break;
    case 'listAgents':value=await store.listAgents();break;
    case 'saveAgent':await store.saveAgent(structuredClone(action.agent));value=null;break;
    case 'comments':value=await store.comments();
     value=value.map(c=>({...c,updatedAt:'NORMALIZED'}));break;
    case 'headSha':value=await store.headSha();break;
    case 'closePullRequest':await store.closePullRequest();value=null;break;
    case 'updatePullRequestBody':await store.updatePullRequestBody(action.body);value=null;break;
    default:throw Error('unknown action '+action.m);
   }
   outcomes.push({ok:true,value:value===undefined?null:value});
  }catch(error){outcomes.push({ok:false,error:error.message});}
 }
 return outcomes;
}

test('snapshot parsing, dashboard ordering, managed listing and InMemoryStore match Node and Rust',async()=>{
 // ---- snapshotParse
 const snapshotExpected=[];
 for(const f of snapshotCases)snapshotExpected.push(await nodeSnapshot(f));
 let run=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:120000,
  input:snapshotCases.map(f=>JSON.stringify({op:'storePublicParity',method:'snapshotParse',
   repository:f.repository,prNumber:f.prNumber,response:f.response,
   trustedAuthors:[...trustedAuthors]})).join('\n')+'\n',maxBuffer:16*1024*1024});
 assert.equal(run.status,0,run.stderr||run.error?.message);
 let actual=run.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,snapshotCases.length);
 let mismatches=[];
 for(let i=0;i<snapshotCases.length;i++){
  try{assert.deepEqual(actual[i].value,snapshotExpected[i]);}
  catch{mismatches.push({kind:'snapshot',i,node:snapshotExpected[i],rust:actual[i].value});}
 }
 // ---- dashboardManagedJobs
 const dashboardExpected=dashboardCases.map(items=>dashboardManagedJobs(items));
 run=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:60000,
  input:dashboardCases.map(items=>JSON.stringify({op:'storePublicParity',method:'dashboardManagedJobs',
   items})).join('\n')+'\n',maxBuffer:8*1024*1024});
 assert.equal(run.status,0,run.stderr||run.error?.message);
 actual=run.stdout.trim().split('\n').map(JSON.parse);
 for(let i=0;i<dashboardCases.length;i++){
  try{assert.deepEqual(actual[i].value,dashboardExpected[i]);}
  catch{mismatches.push({kind:'dashboard',i,node:dashboardExpected[i],rust:actual[i].value});}
 }
 // ---- listManagedGitHubJobs
 const listExpected=[];
 for(const f of listCases)listExpected.push(await nodeList(f));
 run=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:120000,
  input:listCases.map(f=>JSON.stringify({op:'storePublicParity',method:'listManagedGitHubJobs',
   repository:f.repository,responses:f.responses,trustedAuthors:[...trustedAuthors]})).join('\n')+'\n',
  maxBuffer:16*1024*1024});
 assert.equal(run.status,0,run.stderr||run.error?.message);
 actual=run.stdout.trim().split('\n').map(JSON.parse);
 for(let i=0;i<listCases.length;i++){
  const wire=actual[i].value??actual[i];
  try{assert.deepEqual(wire,listExpected[i]);}
  catch{mismatches.push({kind:'list',i,node:listExpected[i],rust:wire});}
 }
 // ---- InMemoryStore
 const storeExpected=[];
 for(const script of storeScripts)storeExpected.push(await nodeStore(script));
 run=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:120000,
  input:storeScripts.map(s=>JSON.stringify({op:'storePublicParity',method:'inMemoryStore',
   job:s.job??null,actions:s.actions})).join('\n')+'\n',maxBuffer:16*1024*1024});
 assert.equal(run.status,0,run.stderr||run.error?.message);
 actual=run.stdout.trim().split('\n').map(JSON.parse);
 for(let i=0;i<storeScripts.length;i++){
  if(!actual[i].ok){mismatches.push({kind:'store',i,rustError:actual[i].error});continue;}
  try{assert.deepEqual(actual[i].value,storeExpected[i]);}
  catch{mismatches.push({kind:'store',i,node:storeExpected[i],rust:actual[i].value});}
 }
 assert.deepEqual(mismatches.slice(0,6),[],JSON.stringify(mismatches,null,2).slice(0,4000));
 console.log(`Verified ${snapshotCases.length} snapshot + ${dashboardCases.length} dashboard + ${listCases.length} managed-list + ${storeScripts.length} InMemoryStore Node/Rust scenarios`);
});
