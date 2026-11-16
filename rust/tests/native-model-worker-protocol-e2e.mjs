import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,chmodSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const target=process.env.CARGO_TARGET_DIR??resolve(import.meta.dirname,'../target');
const model=join(target,'debug/relay-native-model-worker');
function fixture({exit=0,writeSummary=true,route='openai',role='designer',response=null}={}) {
 const root=mkdtempSync('/tmp/relay-rust-model-');
 const project=join(root,'project'),agents=join(project,'agents'),out=join(root,'private');
 mkdirSync(agents,{recursive:true});mkdirSync(out);
 writeFileSync(join(agents,role+'.agent.md'),'Agent policy: validate physical texture before writing.\n');
 const request=join(out,'request.json'),receipt=join(out,'result.json');
 const payload={jobId:'632',taskId:'1878',executionId:'exec-1',leaseOwner:'rust-native-isolated',
  attempt:1,adapter:'codex',agentName:role,input:'Apply accurate texture to 3D model',
  reviewHeadSha:role==='reviewer'?'a'.repeat(40):null,
  routing:{provider:route,model:'gpt-6-luna',decidedBy:'test-router',decidedAt:'2026-11-16T14:00:00Z'},
  workerSelection:{adapter:'codex',workerId:'codex-cli',selectedBy:'test-router',selectedAt:'2026-11-16T14:00:00Z'},
  executionContext:{projectPath:project,role:'worker'}};
 writeFileSync(request,JSON.stringify(payload));
 const mock=join(root,'fake-codex');
 const responsePath=join(root,'response.txt');
 writeFileSync(responsePath,response??'Real mock provider output: verified test.\n');
 writeFileSync(mock,`#!/bin/sh
set -eu
[ "$1" = exec ] || exit 15
shift
summary=''
while [ "$#" -gt 0 ]; do
 if [ "$1" = '--output-last-message' ]; then shift; summary="$1"; fi
 shift
done
cat > '${out}/prompt.txt'
${writeSummary? `cat '${responsePath}' > "$summary"`:''}
exit ${exit}
`);
 chmodSync(mock,0o700);
 const env={...process.env,CODEX_EXECUTABLE:mock,RELAY_TASK_REQUEST_PATH:request,RELAY_RESULT_PATH:receipt};
 const run=()=>spawnSync(model,[],{cwd:project,env,encoding:'utf8',timeout:25000});
 return {root,project,request,receipt,payload,env,run,out};
}

test('native Rust model adapter invokes external process, includes agent policy and persists exact route-bound receipt',()=>{
 const f=fixture();try{
  const result=f.run();assert.equal(result.status,0,result.stderr);
  const evidence=JSON.parse(readFileSync(f.receipt,'utf8'));
  assert.equal(evidence.type,'task.completed');
  assert.equal(evidence.jobId,f.payload.jobId);
  assert.equal(evidence.taskId,f.payload.taskId);
  assert.equal(evidence.executionId,f.payload.executionId);
  assert.equal(evidence.leaseOwner,f.payload.leaseOwner);
  assert.deepEqual(evidence.routing,f.payload.routing);
  assert.deepEqual(evidence.workerSelection,f.payload.workerSelection);
  assert.equal(evidence.output.realProviderExecution,true);
  assert.match(readFileSync(join(f.out,'prompt.txt'),'utf8'),/Agent policy: validate physical texture/);
  assert.match(readFileSync(join(f.out,'prompt.txt'),'utf8'),/Apply accurate texture/);
  assert.notEqual(f.run().status,0,'old evidence must never be re-used for a later execution');
 }finally{rmSync(f.root,{recursive:true,force:true})}
});

test('native Model Worker: nonzero provider exit does not generate forged success',()=>{
 const f=fixture({exit:7});try{
  const result=f.run();assert.notEqual(result.status,0);
  assert.match(result.stderr,/Codex model execution failed/);
  assert.equal(existsSync(f.receipt),false);
 }finally{rmSync(f.root,{recursive:true,force:true})}
});

test('native Model Worker: missing response is not completion',()=>{
 const f=fixture({writeSummary:false});try{
  const result=f.run();assert.notEqual(result.status,0);
  assert.equal(existsSync(f.receipt),false);
 }finally{rmSync(f.root,{recursive:true,force:true})}
});

test('native Model Worker: untrusted route cannot masquerade as OpenAI Codex',()=>{
 const f=fixture({route:'untrusted'});try{
  const result=f.run();assert.notEqual(result.status,0);
  assert.match(result.stderr,/pre-authorized OpenAI\/Codex route/);
  assert.equal(existsSync(f.receipt),false);
 }finally{rmSync(f.root,{recursive:true,force:true})}
});

test('native Model Reviewer accepts only explicitly structured verdict bound to full immutable Git SHA',()=>{
 const head='a'.repeat(40);
 const f=fixture({role:'reviewer',response:JSON.stringify({verdict:'approved',head_sha:head,findings:[]})});
 try{
  const result=f.run();assert.equal(result.status,0,result.stderr);
  const receipt=JSON.parse(readFileSync(f.receipt,'utf8'));
  assert.equal(receipt.output.verdict,'approved');
  assert.equal(receipt.output.head_sha,head);
  assert.deepEqual(receipt.output.findings,[]);
  const prompt=readFileSync(join(f.out,'prompt.txt'),'utf8');
  assert.match(prompt,/Final Review structured output contract/);
  assert.match(prompt,/NEVER infer approval/);
 }finally{rmSync(f.root,{recursive:true,force:true})}
});

test('native Model Reviewer rejects missing/forged head and free-form praise instead of inventing approval',()=>{
 const head='a'.repeat(40);
 for(const response of [
  'Looks fine, approved',
  JSON.stringify({verdict:'approved',head_sha:'b'.repeat(40),findings:[]}),
  JSON.stringify({verdict:'approved',head_sha:head,findings:[{id:'block',summary:'Evidence missing'}]}),
  JSON.stringify({verdict:'changes_required',head_sha:head,findings:[]}),
 ]){
  const f=fixture({role:'reviewer',response});
  try{
   const result=f.run();assert.notEqual(result.status,0);
   assert.equal(existsSync(f.receipt),false);
  }finally{rmSync(f.root,{recursive:true,force:true})}
 }
});
