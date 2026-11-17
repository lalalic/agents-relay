// Direct Node/Rust differential for src/agent-prompt-builder.ts, with immutable snapshots and real files in isolated temp directories.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync} from 'node:fs';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  buildAgentPrompt,renderAgentPrompt,promptFileReference,snapshotAgentInstructions,
  buildReferenceFirstPrompt,buildRelayWorkPrompt,isPromptReferenceAccessible,
} from '../../dist/agent-prompt-builder.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const bin=resolve(root,'rust/target/debug/relay-rust2-parity');
function rust(req){const out=spawnSync(bin,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:10000,maxBuffer:6*1024*1024});assert.equal(out.status,0,`${out.error}: ${out.stderr}`);return JSON.parse(out.stdout.trim())}
function expected(ref){try{return {ok:true,value:ref()}}catch(e){return {ok:false,error:e.message}}}
function normalize(value){return JSON.parse(JSON.stringify(value))}
let seed=0x733a9229;
function rand(n){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n}
const choose=a=>a[rand(a.length)];
const words=[' Original instructions ',' \n中文 指令 \t','\uFEFFWhitespace','One\nTwo','Some\n**markdown**', '  ','','\n','🎥 編輯 ',' \u00A0\u3000'];
const cases=[];
for(let i=0;i<600;i++){
 const input={role:choose(['worker','planner','reviewer','troubleshooter']),system:choose(words),user:choose(words),references:choose([[],[{path:'/tmp/ctx.md',sha256:'123',role:'context'}],undefined])};
 cases.push({op:'buildAgentPrompt',input});
}
for(let i=0;i<500;i++){
 const bundle={role:choose(['worker','planner','reviewer']),system:choose(words),user:choose(words),references:choose([[],[{path:'/a/b c.md',role:'context',sha256:'abc'}],[{path:'/p/a.md',role:'instructions',sha256:'a'},{path:'/p/b.md',role:'context',sha256:'b'}]])};
 cases.push({op:'renderAgentPrompt',bundle,adapter:choose(['chatgpt','z','codex'])});
}
test('pure build and render exports exactly match Node output and errors',()=>{
 const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(build.status,0,build.stderr);
 for(const [index,req] of cases.entries()){
  const node=expected(()=>req.op==='buildAgentPrompt'?buildAgentPrompt(req.input):renderAgentPrompt(req.bundle,req.adapter));
  assert.deepEqual(rust(req),node,`Fixture ${index}: ${JSON.stringify(req)}`);
 }
 console.log(`Verified ${cases.length} pure Agent prompt bundle/render differential fixtures`);
});

test('real immutable snapshot and canonical file hashing have exact byte parity',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rust2-agent-prompt-'));
 try{
  const root=join(dir,'snapshots');const file=join(dir,'source.md');
  writeFileSync(file,'# Instructions\n中文🙂\r\n');
  const linked=join(dir,'linked.md');symlinkSync(file,linked);
  for(const path of [file,linked]){
   for(const role of ['context','instructions']){
    const node=await promptFileReference(path,role);
    assert.deepEqual(rust({op:'promptFileReference',path,role}),{ok:true,value:node});
    assert.deepEqual(rust({op:'isPromptReferenceAccessible',path}),{ok:true,value:await isPromptReferenceAccessible(path)});
   }
  }
  const missing=join(dir,'missing.md');
  assert.deepEqual(rust({op:'isPromptReferenceAccessible',path:missing}),{ok:true,value:await isPromptReferenceAccessible(missing)});
  for(const content of ['# Hello\nworld','中文🙂\nB', 'A'.repeat(500), '# Hello\nworld']){
    const node=await snapshotAgentInstructions(content,root);
    assert.deepEqual(rust({op:'snapshotAgentInstructions',content,directory:root}),{ok:true,value:node});
    assert.equal(readFileSync(node.path,'utf8'),content);
    assert.equal(statSync(node.path).mode & 0o777,0o600);
  }
  assert.equal(statSync(root).mode & 0o777,0o700);
  assert.deepEqual(rust({op:'snapshotAgentInstructions',content:' ',directory:root}),{ok:false,error:'Cannot snapshot empty instructions'});
  assert.deepEqual(rust({op:'promptFileReference',path:'relative',role:'context'}),{ok:false,error:'Prompt reference must be absolute: relative'});
  const brokenPath=join(root,'this-file-is-not-there.md');
  const missingNode=await promptFileReference(brokenPath,'context').then(value=>({ok:true,value}),error=>({ok:false,error:error.message}));
  assert.deepEqual(rust({op:'promptFileReference',path:brokenPath,role:'context'}),missingNode);
  const unreadable=join(dir,'permissions.md');writeFileSync(unreadable,'protected');chmodSync(unreadable,0o000);
  try {
   assert.deepEqual(rust({op:'isPromptReferenceAccessible',path:unreadable}),{ok:true,value:await isPromptReferenceAccessible(unreadable)});
   const nodeUnread=await promptFileReference(unreadable,'context').then(value=>({ok:true,value}),error=>({ok:false,error:error.message}));
   assert.deepEqual(rust({op:'promptFileReference',path:unreadable,role:'context'}),nodeUnread);
  }finally{chmodSync(unreadable,0o600);}
  const unreadableDir=join(dir,'directory.md');mkdirSync(unreadableDir);
  const nodeDir=await promptFileReference(unreadableDir,'context').then(value=>({ok:true,value}),error=>({ok:false,error:error.message}));
  assert.deepEqual(rust({op:'promptFileReference',path:unreadableDir,role:'context'}),nodeDir);
  console.log('Verified strict Node-compatible missing-path, EACCES and EISDIR errors plus fs.access F_OK');
  console.log('Verified reference file symlink canonicalization, hash, permission modes and immutable snapshots');
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('reference-first prompt adapters and strict/fallback behavior match Node',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rust2-agent-prompt-reference-'));
 try{
  for(let i=0;i<220;i++){
   const input={role:choose(['planner','reviewer','worker']),system:choose(['System\nwith lines','中文约束🙂',' Try ']),
    user:choose([' User task ','中文任务','User\n\nparagraph']),adapter:choose(['codex','chatgpt','z']),
    bootstrap:choose(['BOOT','  quick start  ',undefined]),referenceDirectory:join(dir,'snapshots'),
    strictReference:choose([true,false,undefined]),
    contextRefs:choose([[],[{path:'/some/ctx.md',role:'context',sha256:'abcdef'}],undefined])};
   const node=await buildReferenceFirstPrompt(input);
   assert.deepEqual(rust({op:'buildReferenceFirstPrompt',input}),{ok:true,value:node},`Reference-first ${i}`);
  }
  const invalidRoot=join(dir,'not_a_directory');writeFileSync(invalidRoot,'file');
  const soft={role:'worker',system:'original instructions',user:'task',referenceDirectory:invalidRoot,strictReference:false};
  assert.deepEqual(rust({op:'buildReferenceFirstPrompt',input:soft}),{ok:true,value:await buildReferenceFirstPrompt(soft)});
  const original='Agent contract content';
  const digest=createHash('sha256').update(original).digest('hex');
  const mismatchRoot=join(dir,'hash-mismatch');mkdirSync(mismatchRoot,{recursive:true});
  writeFileSync(join(mismatchRoot,`${digest}.md`),'someone changed the contents');
  for(const strictReference of [false,true]){
   const invalid={role:'worker',system:original,user:'do work',referenceDirectory:mismatchRoot,strictReference};
   const expected=await buildReferenceFirstPrompt(invalid).then(value=>({ok:true,value}),error=>({ok:false,error:error.message}));
   assert.deepEqual(rust({op:'buildReferenceFirstPrompt',input:invalid}),expected);
   assert.equal(expected.ok,false);
   assert.equal(expected.error,'Prompt snapshot digest mismatch');
  }
  const missingUser={role:'worker',system:'some instructions',user:'',referenceDirectory:join(dir,'new-snapshot-dir')};
  const referenceNode=await buildReferenceFirstPrompt(missingUser).then(value=>({ok:true,value}),error=>({ok:false,error:error.message}));
  assert.deepEqual(rust({op:'buildReferenceFirstPrompt',input:missingUser}),referenceNode);
  console.log('Verified 220 reference-first prompt flows plus digest-mismatch and invalid-user failures');
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('execution-bound prompt text and ordered context references match Node byte-for-byte',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rust2-agent-prompt-execution-'));
 const old=process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR;
 try{
  const refdir=join(dir,'refs');process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR=refdir;
  const base=join(dir,'project');mkdirSync(base,{recursive:true});
  const names=['plan.md','events.md','review.md','skill.md','unrelated.txt'];
  for(const name of names)writeFileSync(join(dir,name),`# ${name}\nFixture\n`);
  const contexts=[];
  for(const source of ['global','parent','project','shared','invalid','parent']){
   const path=join(dir,source,String(contexts.length),'AGENTS.md');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,`# ${source}\nrules`);contexts.push({path,source});
  }
  for(let i=0;i<150;i++){
   const input={agentName:choose(['planner','worker','reviewer','troubleshooter','editor']),
    agentContent:choose(['# Agent\nApply rules','中文指令🙂\nExecute','  agent content  ']),
    suggestedSkills:choose([[],['markcut','tools'],undefined]),
    contracts:choose([[join(dir,'plan.md')],[join(dir,'events.md'),join(dir,'plan.md')],[]]),
    contexts:choose([contexts,contexts.slice(0,3),[]]),
    skillPath:join(dir,'skill.md'),taskTitle:choose(['Edit these scenes','中文任务标题','',undefined]),
    workerSelfReview:choose([true,false,undefined]),jobId:'42',taskId:'128',executionId:'run-fixture',
    adapter:choose(['chatgpt','codex','z']),projectPath:base,
    providerInstructions:choose([[],['Prefer one model','Do not lose state'],undefined])};
   const node=await buildRelayWorkPrompt(input);
   const actual=rust({op:'buildRelayWorkPrompt',input,envDirectory:refdir});
   assert.deepEqual(actual,{ok:true,value:node},`Execution prompt ${i}`);
  }
  const incomplete={jobId:'',taskId:'1',executionId:'x'};
  assert.deepEqual(rust({op:'buildRelayWorkPrompt',input:incomplete,envDirectory:refdir}),
    {ok:false,error:'Relay prompt requires a full execution binding'});
  console.log('Verified 150 byte-identical execution-bound Agent work prompts with ordered contracts and task events');
 }finally{
  if(old===undefined)delete process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR;else process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR=old;
  rmSync(dir,{recursive:true,force:true});
 }
});
