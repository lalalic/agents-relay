// Public src/cli-job-create.ts ensureManagedGitHubJob vs compiled Rust native
// implementation. Separate real Git/SQLite fixtures; never live Relay/GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {realpathSync} from 'node:fs';
import {ensureManagedGitHubJob} from '../../dist/cli-job-create.js';
import {discoverLocalRelayStoreSnapshots} from '../../dist/relay-store.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const fixtures=['node','rust'].map(name=>{
 const fixtureRoot=realpathSync(mkdtempSync(join(tmpdir(),`rust2-cli-job-${name}-`)));
 const repository='isolatedrepo';const project=join(fixtureRoot,repository);
 mkdirSync(project);
 const init=spawnSync('git',['init','-q','--initial-branch=main',project],{encoding:'utf8'});
 assert.equal(init.status,0,init.stderr);
 mkdirSync(join(fixtureRoot,'stores'));
 return {fixtureRoot,repository,project};
});
test.after(()=>fixtures.forEach(f=>rmSync(f.fixtureRoot,{recursive:true,force:true})));
function options(f,change={}){
 return {id:'41',title:'First job',objective:'First objective',projectRoot:f.project,
  storeDirectory:join(f.fixtureRoot,'stores'),noGitHub:true,reviewEnabled:false,
  ...change};
}
const graph='flowchart TD\nA[agent:developer]';
const scenarios=[
 {name:'create',make:f=>options(f,{idempotencyKey:'primary',id:undefined})},
 {name:'idempotent',make:f=>options(f,{idempotencyKey:'primary',id:undefined})},
 {name:'same key different definition',make:f=>options(f,{idempotencyKey:'primary',id:undefined,title:'Conflict'})},
 {name:'different local job',make:f=>options(f,{idempotencyKey:'second',id:undefined,title:'Second job',objective:'new'})},
 {name:'mismatched pr identity',make:f=>options(f,{id:'2',title:'Second job',objective:'new',prNumber:90})},
 {name:'coordinator create',make:f=>options(f,{idempotencyKey:'coordinator',id:undefined,coordinator:{
  graph,input:'Execute fixture graph',outputPath:join(f.project,'deliverable.txt'),
  projectRoot:f.project,workspaceRoot:f.fixtureRoot}})},
 {name:'coordinator idempotent',make:f=>options(f,{idempotencyKey:'coordinator',id:undefined,coordinator:{
  graph,input:'Execute fixture graph',outputPath:join(f.project,'deliverable.txt'),
  projectRoot:f.project,workspaceRoot:f.fixtureRoot}})},
 {name:'coordinator divergent input',make:f=>options(f,{idempotencyKey:'coordinator',id:undefined,coordinator:{
  graph,input:'Different graph input',outputPath:join(f.project,'deliverable.txt'),
  projectRoot:f.project,workspaceRoot:f.fixtureRoot}})},
 {name:'wrong main merge target',make:f=>options(f,{idempotencyKey:'invalid-main',id:undefined,localMergeTarget:'refs/heads/not-main'})},
 {name:'dry-run create only',make:f=>options(f,{idempotencyKey:'no-persist',id:undefined,persist:false})},
 {name:'reject manually specified numeric Job ID',make:f=>options(f,{id:'7000'})},
 {name:'reject invalid zero Job ID',make:f=>options(f,{id:'0'})},
 {name:'reject leading zero Job ID',make:f=>options(f,{id:'0007'})},
 {name:'reject negative PR',make:f=>options(f,{id:undefined,idempotencyKey:'bad-pr',prNumber:-1})},
 {name:'reject noninteger PR',make:f=>options(f,{id:undefined,idempotencyKey:'bad-pr-float',prNumber:1.25})},
 {name:'reject empty idempotency key',make:f=>options(f,{id:undefined,idempotencyKey:''})},
 {name:'accept metadata, HEAD refs and normalized thread IDs',make:f=>options(f,{
  id:undefined,idempotencyKey:'metadata',title:'Review-aware',objective:'Review objective',
  body:'Full body text',priority:'P0',autoMerge:false,reviewEnabled:true,
  tag:'testing',prNumber:12,head:'feature/test',base:'main',
  localMergeSource:'refs/heads/feature/test',localMergeTarget:'refs/heads/main',
  reviewerThreadId:'  reviewer-thread  ',creatorThreadId:' creator ',
  implementationThreadId:' impl ',continuation:{kind:'webhook',url:'https://example.invalid/'}})},
 {name:'replay same metadata key',make:f=>options(f,{
  id:undefined,idempotencyKey:'metadata',title:'Review-aware',objective:'Review objective',
  body:'Full body text',priority:'P0',autoMerge:false,reviewEnabled:true,
  tag:'testing',prNumber:12,head:'feature/test',base:'main',
  localMergeSource:'refs/heads/feature/test',localMergeTarget:'refs/heads/main',
  reviewerThreadId:'  reviewer-thread  ',creatorThreadId:' creator ',
  implementationThreadId:' impl ',continuation:{kind:'webhook',url:'https://example.invalid/'}})},
 {name:'reject metadata key changed title',make:f=>options(f,{
  id:undefined,idempotencyKey:'metadata',title:'Changed',objective:'Review objective'})},
 {name:'reject invalid base branch',make:f=>options(f,{
  id:undefined,idempotencyKey:'invalid-base',base:'not-main'})},
 {name:'reject reviewer thread type',make:f=>options(f,{
  id:undefined,idempotencyKey:'invalid-reviewer',reviewerThreadId:99})},
 {name:'coordinator invalid relative output',make:f=>options(f,{
  id:undefined,idempotencyKey:'invalid-coordinator-path',
  coordinator:{graph,input:'an instruction',outputPath:'relative.txt',
   projectRoot:f.project,workspaceRoot:f.fixtureRoot}})},
 {name:'coordinator invalid parser graph',make:f=>options(f,{
  id:undefined,idempotencyKey:'invalid-coordinator-graph',
  coordinator:{graph:'graph TD\nA[bad]',input:'an instruction',
   outputPath:join(f.project,'out.txt'),
   projectRoot:f.project,workspaceRoot:f.fixtureRoot}})},
 {name:'coordinator with explicit global root',make:f=>options(f,{
  id:undefined,idempotencyKey:'global-root',
  coordinator:{graph,input:'different input',outputPath:join(f.project,'out2.txt'),
   projectRoot:f.project,workspaceRoot:f.fixtureRoot,
   globalRoot:join(f.fixtureRoot,'global')}})},
];
function normalized(value,f){
 if(typeof value==='string'){
  if(value.includes(f.fixtureRoot))return value.split(f.fixtureRoot).join('<fixture>');
  if(/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value))return '<timestamp>';
  return value;
 }
 if(Array.isArray(value))return value.map(v=>normalized(v,f));
 if(value&&typeof value==='object')
  return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined)
   .map(([k,v])=>[k,normalized(v,f)]));
 return value;
}
async function node(f,opts){
 try{
  const result=await ensureManagedGitHubJob({},f.repository,new Set(),opts);
  return normalized({ok:true,value:result},f);
 }catch(error){return normalized({ok:false,error:error.message},f);}
}
function rust(f,opts){
 const result=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:30000,
  input:JSON.stringify({op:'cliJobCreatePersist',fixtureRoot:f.fixtureRoot,
   repository:f.repository,options:opts})+'\n',maxBuffer:8*1024*1024});
 assert.equal(result.status,0,result.stderr);
 return normalized(JSON.parse(result.stdout.trim()).value,f);
}
async function persistent(f){
 const snapshots=await discoverLocalRelayStoreSnapshots(join(f.fixtureRoot,'stores'));
 return normalized(snapshots.flatMap(snapshot=>snapshot.jobs),f);
}
test('original public Node ensureManagedGitHubJob and Rust real Git/SQLite create, conflict, idempotency',async()=>{
 for(const scenario of scenarios){
  const a=fixtures[0],b=fixtures[1];
  const expected=await node(a,scenario.make(a));
  const actual=rust(b,scenario.make(b));
  assert.deepEqual(actual,expected,scenario.name);
  // Read through the original SQLite authority on both sides, not just
  // compare returned objects from potentially fake adapters.
  const nodeStored=await persistent(a);
  const rustStored=await persistent(b);
  assert.deepEqual(rustStored,nodeStored,scenario.name+' persisted SQLite snapshot');
 }
});
