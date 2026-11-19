// Genuine Node(dist)/native Rust differential tests for six owned src modules.
// Runs in a disposable fixture and never reaches the production Relay store/services.
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, symlink, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {workflowCliResult} from '../../dist/cli-workflow.js';
import {parseRevisionFindings,runTaskReviseCommand} from '../../dist/cli-revision.js';
import {runBlockerCommand} from '../../dist/cli-blocker.js';
import {runContextCommand} from '../../dist/cli-context.js';
import {discoverScriptAgent,missingScriptAgents} from '../../dist/agent-script-discovery.js';
import {validateArtifact} from '../../dist/cli-artifact.js';

const bin=resolve('rust/target/debug/relay-rust2-parity');
let total=0;
const failures=[];
function rust(op,fields={}){
  const cmd=spawnSync(bin,{input:JSON.stringify({op,...fields})+'\n',encoding:'utf8',env:process.env});
  if(cmd.error)throw cmd.error;
  if(cmd.status!==0)throw new Error('Rust child exited '+cmd.status+': '+cmd.stderr);
  const lines=cmd.stdout.trim().split('\n');
  const reply=JSON.parse(lines.at(-1));
  return reply.ok?{ok:true,value:reply.value}:{ok:false,error:reply.error};
}
async function node(fn){
  try{return {ok:true,value:await fn()};}
  catch(error){return {ok:false,error:error.message};}
}
function compare(label,n,r){
  total++;
  try{
    assert.deepStrictEqual(r,JSON.parse(JSON.stringify(n)));
    process.stdout.write('PASS '+label+'\n');
  }catch(error){
    failures.push({label,node:n,rust:r});
    process.stdout.write('FAIL '+label+': '+error.message.split('\n')[0]+'\n');
  }
}
function cases(label,op,records,fn){
  return Promise.all(records.map(async (value,index)=>{
    const n=await node(()=>fn(value));
    const r=rust(op,value);
    compare(label+' '+index,n,r);
  }));
}
const root=await mkdtemp(join(tmpdir(),'rust2-cli-diff-'));
const global=join(root,'global'), shared=join(root,'shared'), workspace=join(root,'workspace'),project=join(workspace,'toy');
try {
 await Promise.all([global,shared,project].map(d=>mkdir(d,{recursive:true})));
 await mkdir(join(project,'agents','.shortcut'),{recursive:true});
 await mkdir(join(project,'skills','onboard'),{recursive:true});
 await writeFile(join(project,'AGENTS.md'),'# Local rules\n');
 await writeFile(join(project,'README.md'),'# Local readme\n');
 await writeFile(join(global,'AGENTS.md'),'# Global rules\n');
 await writeFile(join(project,'agents','builder.agent.md'),'---\nname: builder\ncapabilities: [mesh, colors]\nmodel: gpt-6\n---\n# Builder\n');
 await writeFile(join(project,'agents','.shortcut','builder.agent.mjs'),'export default async function main(){}\n');
 await writeFile(join(project,'skills','onboard','SKILL.md'),'---\nname: onboard\ndescription: Intro skill\n---\n# Skill\n');
 await writeFile(join(project,'agents','plain.md'),'# Plain agent\n');
 process.env.AGENTS_HOME=global;
 await cases('findings','parseRevisionFindings',[
  {source:'[{"id":"a","summary":"Good","evidence":" OK "}]'},
  {source:'[{"id":" a ","summary":" X "}]'},
  {source:'[{"id":"a","summary":"x"},{"id":"a","summary":"y"}]'},
  {source:'[{"id":"a","summary":"x","extra":true}]'},
  {source:'[false]'},{source:'[{}]'},{source:'[]'},
  {source:'{}'},{source:'{bad json'},{source:'[{"id":4,"summary":"x"}]'},
  {source:JSON.stringify([{id:'🦀'.repeat(81),summary:'x'}])}
 ], x=>parseRevisionFindings(x.source));

 const baseArgs=['--repo','toy','--id','4','--target-repo','core','--request-id','request-1','--dependent-task','8','--reason','broken','--title','Repair','--objective','Finish','--authorized'];
 for(const [label,action,args] of [
  ['ensure','ensure',baseArgs],['no-auth','ensure',baseArgs.filter(a=>a!=='--authorized')],
  ['no-repo','ensure',['--id','4']],['project-removed','ensure',['--project-path','sub']],
  ['resolution','ensure',[...baseArgs,'--resolution','invalid']],['origin','ensure',[...baseArgs,'--origin','bad']],
  ['show','show',['--repo','toy','--id','9']],
  ['resolve','resolve',['--repo','toy','--id','9']],
  ['add','add',['--repo','toy','--id','9','--dependent-job','4','--dependent-task','8']],
  ['no-target','add',['--repo','toy','--id','9']],['unsupported','invalid',['--repo','toy']],
 ]) {
  let captured;
  const oldFetch=globalThis.fetch, oldLog=console.log;
  globalThis.fetch=async(url,opts)=>{captured=opts?.body?{type:'control',body:JSON.parse(opts.body)}:
       {type:'job',jobId:new URL(url).searchParams.get('id')};return {ok:true,json:async()=>({ok:true}),text:async()=>''};};
  console.log=()=>{};
  const n=await node(async()=>{await runBlockerCommand(action,args);return captured});
  globalThis.fetch=oldFetch;console.log=oldLog;
  const r=rust('blockerEffect',{action,args});
  const reinterpreted=r.ok&&r.value.type==='resolve'?{ok:true,value:{type:'control',body:{command:'blocker.resolve',jobId:r.value.jobId,resolution:'verified'}}}:r;
  compare('blocker '+label,n,reinterpreted);
 }

 for(const [label,source] of [
  ['missing','not-there'],['normal','builder'],['plain','plain'],
 ]) {
  const n=await node(()=>discoverScriptAgent(source,project,workspace,global));
  const r=rust('discoverScriptAgent',{agent:source,projectPath:project,workspaceRoot:workspace,globalRoot:global});
  compare('script '+label,n,r);
 }
 const graph='flowchart TD\nBuild[agent:builder]\nTest[agent:missing]';
 compare('missing scripts',await node(()=>missingScriptAgents(graph,project,workspace,global)),
   rust('missingScriptAgents',{graph,projectPath:project,workspaceRoot:workspace,globalRoot:global}));
 await symlink(join(project,'agents','builder.agent.md'),join(project,'agents','.shortcut','linked.agent.mjs'));
 // A real malicious symlink on the expected name, not a fabricated exception.
 await rm(join(project,'agents','.shortcut','builder.agent.mjs'));
 await symlink(join(project,'agents','builder.agent.md'),join(project,'agents','.shortcut','builder.agent.mjs'));
 compare('script symlink rejection',await node(()=>discoverScriptAgent('builder',project,workspace,global)),
   rust('discoverScriptAgent',{agent:'builder',projectPath:project,workspaceRoot:workspace,globalRoot:global}));
 await rm(join(project,'agents','.shortcut','builder.agent.mjs'));
 await writeFile(join(project,'agents','.shortcut','builder.agent.mjs'),'export default async()=>{}\n');
 const findingsFile=join(root,'findings.json');
 await writeFile(findingsFile,JSON.stringify([{id:'f1',summary:'correct issue',evidence:'at line 4'}]));
 const reviseArgs=['--repo','toy','--id','4','--task-id','8','--review-task-id','12',
   '--execution-id','exe','--head-sha','123abc','--request-id','rev1','--findings-file',findingsFile];
 for(const [label,args] of [
  ['valid',reviseArgs],['missing-task',reviseArgs.filter((_,index)=>![4,5].includes(index))],
  ['missing-file',[...reviseArgs.slice(0,-1),join(root,'no-file')]],
 ]) {
  let payload;
  const oldFetch=globalThis.fetch,oldLog=console.log;
  globalThis.fetch=async (url,opts)=>{payload=JSON.parse(opts.body);
    return {ok:true,json:async()=>({request:{requestId:'rev1',originalTaskId:'8',revisionTaskId:'99'},created:true}),text:async()=>''};};
  console.log=()=>{};
  const n=await node(async()=>{await runTaskReviseCommand(args);return payload});
  globalThis.fetch=oldFetch;console.log=oldLog;
  compare('revision request '+label,n,rust('revisionRequest',{args}));
 }
 const request=rust('revisionRequest',{args:reviseArgs}).value;
 for(const response of [
   {request:{requestId:'rev1',originalTaskId:'8',revisionTaskId:'99'},created:true},
   {request:{requestId:'bad',originalTaskId:'8',revisionTaskId:'99'},created:true},
   {request:{requestId:'rev1',originalTaskId:'8',revisionTaskId:''},created:false},
 ]){
   const oldFetch=globalThis.fetch,oldLog=console.log;
   let output; console.log=s=>{output=s};
   globalThis.fetch=async()=>({ok:true,json:async()=>response,text:async()=>''});
   const n=await node(async()=>{await runTaskReviseCommand(reviseArgs);return JSON.parse(output)});
   globalThis.fetch=oldFetch;console.log=oldLog;
   compare('revision receipt '+response.request.requestId+':'+response.request.revisionTaskId,
        n,rust('revisionReceipt',{request,response}));
 }
 const objectiveFile=join(root,'objective.md'); await writeFile(objectiveFile,'# Complete build');
 const baseEnsure=['--repo','toy','--id','4','--target-repo','core','--request-id','r','--dependent-task','8','--reason','defect','--title','Repair','--authorized'];
 for (const [label,args] of [
  ['file',[...baseEnsure,'--objective-file',objectiveFile]],
  ['exclusive',[...baseEnsure,'--objective-file',objectiveFile,'--objective','inline']],
  ['no-file',[...baseEnsure,'--objective-file',join(root,'not-found.md')]],
 ]) {
  let captured;
  const oldFetch=globalThis.fetch,oldLog=console.log;
  globalThis.fetch=async (url,opts)=>{captured={type:'control',body:JSON.parse(opts.body)};
    return {ok:true,json:async()=>({ok:true}),text:async()=>''};};
  console.log=()=>{};
  const n=await node(async()=>{await runBlockerCommand('ensure',args);return captured});
  globalThis.fetch=oldFetch;console.log=oldLog;
  compare('blocker objective '+label,n,rust('blockerEffect',{action:'ensure',args}));
 }
 for(const args of [
  ['--project-path',project,'--workspace-root',workspace,'--global-root',global,'--skills','onboard','--agents','builder'],
  ['--project-path',project,'--workspace-root',workspace,'--global-root',global],
  ['--project-path',project,'--workspace-root',workspace,'--global-root',global,'--role','nested-worker','--skills','missing'],
  ['--project-path',project,'--workspace-root',join(root,'bad-workspace')],
  ['--project-path',project,'--workspace-root',workspace],
  ['--project-path',project,'--workspace-root',workspace,'--global-root',global,'--agents','not-present'],
  ['--project-path',project,'--role','unknown'],
  ['--project-path',join(root,'missing')],
  [],
 ]) {
  let printed;
  const log=console.log;console.log=v=>{printed=v};
  const n=await node(async()=>{await runContextCommand('resolve',args);return JSON.parse(printed)});
  console.log=log;
  const r=rust('runContextCommand',{action:'resolve',args});
  compare('context '+args.join(' '),n,r);
 }
 for(const args of [['discover'],['actions'],['where','--id','task.retry'],['inspect','--graph','task-lifecycle.mmd'],
     ['inspect','--graph','bad'],['evaluate','--graph','bad'],['action'],['nonsense'],
     ['evaluate','--graph','task-lifecycle.mmd','--event','task.started','--state','QUEUED','--facts','{}'],
     ['evaluate','--graph','task-lifecycle.mmd','--event','task.started','--state','QUEUED','--facts','[]']]) {
  compare('workflow '+args.join(' '),await node(()=>workflowCliResult(args)),
      rust('workflowCliResult',{args}));
 }
 // Read-only, isolated SQLite fixtures. Node and Rust inspect the same bytes.
 const dbPath=join(root,'isolated.sqlite');
 const db=new DatabaseSync(dbPath);
 db.exec('CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL)');
 db.prepare('INSERT INTO job_snapshot(job_id,json) VALUES(?,?)').run('5',JSON.stringify({
   id:'5',state:'RUNNING',reviewEnabled:true,plans:[],tasks:[{id:'7',state:'QUEUED',leaseOwner:null,executionId:null}]
 }));
 db.exec('CREATE TABLE workflow_action_trace(attempt_key TEXT,execution_id TEXT,generation INTEGER,graph TEXT,action_id TEXT,condition_id TEXT,outcome TEXT,observed_at TEXT)');
 db.prepare('INSERT INTO workflow_action_trace VALUES(?,?,?,?,?,?,?,?)').run('k','ex',2,'g','a','c','Verified','2026-11-17T00:00:00Z');
 db.close();
 for(const args of [
  ['verify','--sqlite',dbPath,'--job','5','--task','7','--condition','task.queued'],
  ['verify','--sqlite',dbPath,'--job','5','--task','7','--condition','task.routing-cleared'],
  ['verify','--sqlite',dbPath,'--job','5','--task','99','--condition','task.failed'],
  ['verify','--sqlite',dbPath,'--job','missing','--task','7','--condition','task.failed'],
  ['verify','--sqlite',dbPath,'--job','5','--condition','job.completed'],
  ['verify','--sqlite',dbPath,'--job','5','--condition','task.execution-stopped','--task','7','--execution','ex'],
  ['trace','--sqlite',dbPath,'--attempt-key','k'],['trace','--sqlite',dbPath,'--attempt-key','missing'],
  ['verify','--sqlite',dbPath,'--job','5','--condition','wrong']
 ]) compare('sqlite '+args.join(' '),await node(()=>workflowCliResult(args)),rust('workflowCliResult',{args}));
 // More dry-run graph branches and FS-backed verifier errors.
 for(const args of [
   ['where','--id','effect.mergePullRequest'],
   ['where','--id','unregistered.action'],
   ['evaluate','--graph','job-lifecycle.mmd','--state','DRAFT','--event','queue','--facts','{}'],
   ['evaluate','--graph','task-lifecycle.mmd','--state','NONEXISTENT','--event','task.started','--facts','{}'],
   ['verify','--sqlite',dbPath,'--job','5','--condition','job.objective-verified'],
   ['verify','--sqlite',dbPath,'--job','5','--condition','task.failed','--task','7'],
 ]) compare('workflow extended '+args.join(' '),await node(()=>workflowCliResult(args)),
     rust('workflowCliResult',{args}));
 const artifact=join(root,'artifact.json'),schema=join(root,'schema.json');
 for(const [label,input,rule] of [
  ['valid',{name:'abc',count:5},{type:'object',required:['name'],properties:{name:{type:'string'},count:{type:'integer'}}}],
  ['required',{count:6},{type:'object',required:['name']}],
  ['nested',{person:{age:'x'}},{type:'object',properties:{person:{type:'object',properties:{age:{type:'integer'}}}}}],
  ['additional',{name:'a',extra:true},{type:'object',properties:{name:{type:'string'}},additionalProperties:false}],
  ['enum','foo',{enum:['bar','baz']}],
  ['multi','x',{type:'string',minLength:3,enum:['y']}],
  ['pattern','hello',{type:'string',pattern:'^a'}],
  ['numeric',5,{type:'number',minimum:10,maximum:3}],
  ['array',[1,2,3],{type:'array',maxItems:2,items:{type:'string'}}],
  ['const',3,{type:'integer',const:2}],
  ['multipleOf',5,{type:'number',multipleOf:2}],
  ['len','hello',{type:'string',maxLength:3}],
  ['chars','x',{type:'string',minLength:2}],
  ['required-many',{a:1,z:2},{type:'object',required:['missing','also'],properties:{a:{type:'string'}}}],
  ['array-min',[1],{type:'array',minItems:2}],
  ['unique',[1,2,1],{type:'array',uniqueItems:true}],
  ['max-props',{a:1,b:2},{type:'object',maxProperties:1}],
  ['min-props',{a:1},{type:'object',minProperties:2}],
  ['literal-type',true,{type:'string'}],
  ['type-array',null,{type:['string','number']}],
  ['definitions',{'a/b':'hello'},{type:'object',properties:{'a/b':{$ref:'#/$defs/text'}},$defs:{text:{type:'number'}}}],
  ['all-of',3,{allOf:[{type:'number',minimum:5},{type:'number',maximum:1}]}],
  ['any-of',false,{anyOf:[{type:'string'},{type:'number'}]}],
  ['not','hi',{not:{type:'string'}}],
  ['pattern-props',{abc:4},{type:'object',patternProperties:{'^a':{type:'string'}}}]
 ]) {
  await writeFile(artifact,JSON.stringify(input));await writeFile(schema,JSON.stringify(rule));
  compare('artifact '+label,await node(()=>validateArtifact(artifact,schema)),
    rust('validateArtifact',{artifactPath:artifact,schemaPath:schema}));
 }
 // CLI stdout precedes a validation failure and does not swallow its error.
 for(const [label,valid,action] of [
  ['pass',true,'validate'],['invalid',false,'validate'],['unknown',true,'what']
 ]){
  const a=join(root,'cli-artifact.json'),s=join(root,'cli-schema.json');
  await writeFile(a,JSON.stringify({ok:valid}));
  await writeFile(s,JSON.stringify({type:'object',properties:{ok:{const:true}}}));
  const args=['--artifact',a,'--schema',s];
  const {runArtifactCommand}=await import('../../dist/cli-artifact.js');
  const oldLog=console.log;const lines=[];
  console.log=x=>lines.push(x);
  const result=await node(()=>runArtifactCommand(action,args));
  console.log=oldLog;
  compare('artifact CLI '+label,{ok:true,value:{stdout:lines,error:result.ok?null:result.error}},
     rust('runArtifactCommand',{action,args}));
 }
} finally {
 await rm(root,{recursive:true,force:true});
}
process.stdout.write('DIFFERENTIAL '+(total-failures.length)+'/'+total+'\n');
if(failures.length){
 process.stderr.write('FAILED CASES:\n'+JSON.stringify(failures,null,2)+'\n');
 process.exitCode=1;
}
