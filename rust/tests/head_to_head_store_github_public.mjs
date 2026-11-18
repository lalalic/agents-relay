// Real Node/Rust GitHub Store read behavior with injected GraphQL fixtures.
// No network, GitHub credentials or actual remote PR is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {
 loadManagedGitHubPullRequestGraphql,loadManagedGitHubJobGraphql,
 listManagedGitHubJobs
} from '../../dist/store.js';
import {renderJobBody,renderJobComment,renderTaskComment} from '../../dist/markers.js';
import {aggregateManagedGitHubJobs} from '../../dist/pool.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const job=(id='41')=>({
 id,prNumber:7,repository:'test/repo',title:'Fixture '+id,
 state:'ACTIVE',objective:'fixture only',updatedAt:'2026-11-17T12:00:00.000Z',
 tasks:[],plans:[]
});
const task=(id='91',jobId='41')=>({
 id,jobId,agentName:'worker',state:'QUEUED',kind:'work',title:'Task '+id,
 input:'fixture only',attempt:0,maxAttempts:3,dependencies:[]
});
const row=(n,options={})=>({
 number:n,body:options.commentOnly?'No job marker':renderJobBody(job(options.jobId??'41')),
 state:options.state??'OPEN',isDraft:options.draft??false,
 merged:options.merged??false,mergedAt:options.mergedAt??null,
 closedAt:options.closedAt??null,
 headRefOid:'local-fixture',
 comments:{nodes:[
  {id:'comment-id',databaseId:41,url:'https://example.invalid/comment/41',
   updatedAt:'2026-11-17T12:00:00.000Z',
   author:{login:'trusted-dev'},
   body:renderTaskComment(task('91',options.jobId??'41'))},
  ...(options.commentOnly?[{
   id:'job-comment',databaseId:42,updatedAt:'2026-11-17T12:00:00.000Z',
   author:{login:'trusted-dev'},body:renderJobComment(job(options.jobId??'41'))}]:[])
 ]}
});
const snapshot=(pr)=>({repository:{pullRequest:pr}});
const list=(open,merged=[],closed=[],next=null)=>({
 repository:{
  open:{nodes:open,pageInfo:{
   hasNextPage:typeof next==='string',endCursor:next}},
  recentMerged:{nodes:merged},recentClosed:{nodes:closed}
 }
});
const scenarios=[];
for(const repository of ['test/repo','missing','/repo','test/'])
 for(const prNumber of [0,7]){
  scenarios.push({kind:'pull',repository,prNumber,
   trusted:['trusted-dev'],responses:[snapshot(row(7))]});
 }
for(const pr of [
 row(7),row(9,{commentOnly:true}),row(11,{state:'CLOSED',closedAt:'2026-11-16T10:00:00.000Z'}),
 {...row(7),body:'no markers',comments:{nodes:[]}},
 {...row(7),comments:{totalCount:300,nodes:[row(7).comments.nodes[0]]}},
]){
 scenarios.push({kind:'pull',repository:'test/repo',prNumber:7,
  trusted:['trusted-dev'],responses:[snapshot(pr)]});
 for(const jobId of ['41','missing'])
  scenarios.push({kind:'job',repository:'test/repo',prNumber:7,
   jobId,trusted:['trusted-dev'],responses:[snapshot(pr)]});
}
for(const trusted of [['trusted-dev'],['nobody']]){
 scenarios.push({kind:'list',repository:'test/repo',trusted,
  responses:[list(
   [row(20),row(14,{commentOnly:true}),row(0),row(20)],
   [row(19,{state:'MERGED',merged:true})],
   [row(13,{state:'CLOSED'})]
  )]});
 scenarios.push({kind:'list',repository:'test/repo',trusted,
  responses:[list([row(29)],[],[], 'next-page'),
   list([row(30),row(28)],[],[],null)]});
}
for(const repository of ['','invalid','/repo','test/']){
 scenarios.push({kind:'list',repository,trusted:['trusted-dev'],responses:[]});
}
for(const kind of ['pull','list']) {
 scenarios.push({kind,repository:'test/repo',prNumber:7,trusted:['trusted-dev'],
  responses:[{fixtureError:'Simulated GitHub GraphQL outage'}]});
}
// Aggregate all unique GitHub repositories, retaining Node's ordering and
// Promise.all error surface. No remote PR or local Job store is touched.
const aggregateCases=[
 {repositories:[],responses:[]},
 {repositories:['test/repo'],responses:[list([row(7),row(10),row(11)])]},
 {repositories:['test/repo','test/repo'],responses:[list([row(7)])]},
 {repositories:['test/repo','test/repo','alt/repo'],responses:[
   list([row(14),row(11)]),list([row(19),row(5)])
 ]},
 {repositories:['test/repo','alt/repo'],responses:[
   list([row(7,{jobId:'41'})]),list([row(13,{jobId:'51'})])
 ]},
 {repositories:['bad','test/repo'],responses:[list([row(7)])]},
 {repositories:['test/repo','bad','alt/repo'],responses:[
   list([row(7)]),list([row(17)])
 ]},
 {repositories:['bad','bad'],responses:[]},
 {repositories:['test/repo','alt/repo'],responses:[
   {fixtureError:'Simulated GraphQL outage'},list([row(17)])
 ]},
 {repositories:['test/repo','alt/repo'],responses:[
   list([row(7)]),{fixtureError:'Simulated GraphQL outage'}
 ]},
 {repositories:['test/repo','alt/repo','third/repo'],responses:[
   list([row(7)]),list([row(20)]),list([row(3)])
 ]},
];
for(const {repositories,responses} of aggregateCases){
 scenarios.push({kind:'aggregate',repositories,responses,trusted:['trusted-dev']});
 scenarios.push({kind:'aggregate',repositories,responses,trusted:['nobody']});
}
async function node(f){
 let calls=[];
 const responses=structuredClone(f.responses);
 const client={graphql:async(query,variables)=>{
  calls.push({query,variables});
  const value=responses.shift();
  if(!value)throw Error('Fixture GraphQL response exhausted');
  if(value.fixtureError)throw Error(value.fixtureError);
  return value;
 }};
 let outcome;
 try{
  const trusted=new Set(f.trusted);
  const value=f.kind==='pull'?
   await loadManagedGitHubPullRequestGraphql(client,f.repository,f.prNumber,trusted):
   f.kind==='job'?
   await loadManagedGitHubJobGraphql(client,f.repository,f.prNumber,f.jobId,trusted):
   f.kind==='aggregate'?
   await aggregateManagedGitHubJobs(client,f.repositories,trusted):
   await listManagedGitHubJobs(client,f.repository,trusted);
  outcome={ok:true,value};
 }catch(error){outcome={ok:false,error:error.message};}
 return JSON.parse(JSON.stringify({outcome,calls}));
}
test('Node/Rust GitHub Store readers and repository aggregate, marker trust and pagination',async()=>{
 const expected=[];for(const f of scenarios)expected.push(await node(f));
 const process=spawnSync(bin,[],{cwd:root,
  input:scenarios.map(f=>JSON.stringify({op:'apiStoreGithubPublic',...f})).join('\n')+'\n',
  encoding:'utf8',timeout:120000,maxBuffer:30*1024*1024});
 assert.equal(process.status,0,process.stderr||process.error?.message);
 const actual=process.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,scenarios.length);
 const failures=[];
 for(let i=0;i<scenarios.length;i++){
  if(!actual[i].ok){failures.push({i,adapterError:actual[i].error});continue;}
  try{assert.deepEqual(actual[i].value,expected[i]);}
  catch{failures.push({i,kind:scenarios[i].kind,repo:scenarios[i].repository,
    node:expected[i],rust:actual[i].value});}
 }
 assert.deepEqual(failures,[],JSON.stringify(failures,null,2));
 console.log('Verified',scenarios.length,'Node/Rust Store GitHub API cases');
});
