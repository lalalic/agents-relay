// Native/Node executable escalation parity. Disposable scripts only; no live
// provider, Codex, Relay Job, or ~/.agents-relay store is accessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {runConfiguredEscalation} from '../../dist/cli-escalation.js';

const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const temp=mkdtempSync(join(tmpdir(),'rust2-escalation-fixture-'));
test.after(()=>rmSync(temp,{recursive:true,force:true}));
const executable=join(temp,'provider.sh');
writeFileSync(executable, `#!/bin/sh
mode="$1"
shift
test "$1" = "--handoff-file" || exit 80
test -f "$2" || exit 81
grep -q '# Intent' "$2" || exit 82
grep -q 'run original effect' "$2" || exit 83
shift 2
if [ "$mode" = "policy" ]; then
  test "$1" = "--on-needs-user-file" || exit 84
  grep -q 'notify carefully' "$2" || exit 85
fi
case "$mode" in
 resolved) printf '{"status":"resolved","summary":"verified","evidence":["local fixture"]}';;
 policy) printf '{"status":"needs_user","summary":"needs owner","user_action":"login"}';;
 failed) printf '{"status":"failed","summary":"provider declined","reason":"x"}';;
 invalid) printf 'no json';;
 empty) printf '{"status":"resolved","summary":"  "}';;
 unknown) printf '{"status":"other","summary":"bad"}';;
 nonzero) printf '{"status":"resolved","summary":"not valid"}'; exit 13;;
 quiet) exit 0;;
 large) i=0; while [ "$i" -lt 30000 ]; do printf '1234567890'; i=$((i+1)); done;;
 withstderr) printf 'DO NOT LEAK PROVIDER TOKEN' >&2; printf '{"status":"resolved","summary":"ok"}';;
esac
`);
chmodSync(executable,0o700);
const request={intent:'run original effect',blockedOn:'blocked fixture',
 context:'not a live user',cwd:temp};
const modes=['resolved','policy','failed','invalid','empty','unknown','nonzero','quiet','large','withstderr'];
const scenarios=[
 ...modes.map(mode=>({
  env:{AGENTS_RELAY_ESCALATION_COMMAND:JSON.stringify([executable,mode])},
  request:{...request,...(mode==='policy'?{onNeedsUser:'notify carefully'}:{})},
 })),
 {env:{},request},
 {env:{AGENTS_RELAY_ESCALATION_COMMAND:'relative-bin'},request},
 {env:{AGENTS_RELAY_ESCALATION_COMMAND:'[]'},request},
 {env:{AGENTS_RELAY_ESCALATION_COMMAND:'["/bin/echo",{}]'},request},
 {env:{AGENTS_RELAY_ESCALATION_COMMAND:'["/bin/echo"]'},request},
];
async function nodeResult(f){return await runConfiguredEscalation(f.request,f.env);}
function rustResults(fixtures){
 const input=fixtures.map(f=>JSON.stringify({op:'apiEscalationConfigured',...f,timeoutMs:5000})).join('\n')+'\n';
 const p=spawnSync(binary,[],{cwd:root,input,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
 assert.equal(p.status,0,p.stderr||p.error?.message);
 const lines=p.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(lines.length,fixtures.length);
 return lines.map(row=>{assert.equal(row.ok,true,JSON.stringify(row));return row.value;});
}
test('Node/Rust configured escalation executor, cleanup and negative contract',async()=>{
 const expected=[];for(const f of scenarios)expected.push(await nodeResult(f));
 const actual=rustResults(scenarios);
 const mismatches=[];
 for(let i=0;i<scenarios.length;i++){
  try{assert.deepEqual(actual[i],expected[i]);}
  catch{mismatches.push({i,mode:i<modes.length?modes[i]:'configuration',
    node:expected[i],rust:actual[i]});}
 }
 assert.deepEqual(mismatches,[],JSON.stringify(mismatches,null,2));
 console.log('Verified',scenarios.length,'direct Node/Rust escalation effects');
});

import {runEscalationCommand} from '../../dist/cli-escalation.js';
const intentFile=join(temp,'intent-request.md');
const blockedFile=join(temp,'blocked-request.md');
const contextFile=join(temp,'context-request.md');
writeFileSync(intentFile,' run original effect \n');
writeFileSync(blockedFile,'blocked fixture\n');
writeFileSync(contextFile,'fixture context\n');
const cliFixtures=[
 {mode:'resolved',args:['--intent','run original effect','--blocked-on','blocked fixture']},
 {mode:'policy',args:['--intent','run original effect','--blocked-on','blocked fixture','--on-needs-user','notify carefully']},
 {mode:'failed',args:['--intent','run original effect','--blocked-on','blocked fixture']},
 {mode:'invalid',args:['--intent','run original effect','--blocked-on','blocked fixture']},
 {mode:'none',args:['--intent','run original effect','--blocked-on','blocked fixture']},
 {mode:'resolved',args:['--intent','  ','--blocked-on','blocked fixture']},
 {mode:'resolved',args:['--intent','run original effect','--blocked-on','  ']},
 {mode:'resolved',args:['--intent','run original effect','--blocked-on','blocked fixture','--context','context']},
 {mode:'resolved',args:['--intent-file',intentFile,'--blocked-on-file',blockedFile]},
 {mode:'resolved',args:['--intent','run original effect','--intent-file',intentFile,'--blocked-on','blocked fixture']},
 {mode:'resolved',args:['--intent-file',join(temp,'does-not-exist.md'),'--blocked-on','blocked fixture']},
 {mode:'resolved',args:['--intent','run original effect','--blocked-on','blocked fixture','--context-file',contextFile]},
 {mode:'resolved',args:['--intent','run original effect','--blocked-on','blocked fixture','--cwd',temp]},
];
async function nodeCli(f){
 const saved=process.env.AGENTS_RELAY_ESCALATION_COMMAND;
 const oldLog=console.log;
 const oldCode=process.exitCode;
 const logs=[];
 try{
  if(f.mode==='none') delete process.env.AGENTS_RELAY_ESCALATION_COMMAND;
  else process.env.AGENTS_RELAY_ESCALATION_COMMAND=JSON.stringify([executable,f.mode]);
  console.log=message=>logs.push(message);
  await runEscalationCommand(f.args);
  assert.equal(logs.length,1);
  return {ok:true,value:JSON.parse(logs[0])};
 }catch(e){return {ok:false,error:e.message};}
 finally{
  console.log=oldLog;process.exitCode=oldCode;
  if(saved===undefined)delete process.env.AGENTS_RELAY_ESCALATION_COMMAND;
  else process.env.AGENTS_RELAY_ESCALATION_COMMAND=saved;
 }
}
test('Node/Rust escalation CLI dispatches exact Graph decision',async()=>{
 const fixtures=cliFixtures.map(({mode,args})=>({
  op:'apiEscalationCommand',args,graphDirectory:join(root,'workflow'),
  env:mode==='none'?{}:{AGENTS_RELAY_ESCALATION_COMMAND:JSON.stringify([executable,mode])}
 }));
 const expected=[];for(const f of cliFixtures)expected.push(await nodeCli(f));
 const p=spawnSync(binary,[],{cwd:root,input:fixtures.map(JSON.stringify).join('\n')+'\n',
  encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
 assert.equal(p.status,0,p.stderr||p.error?.message);
 const actual=p.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,fixtures.length);
 const bad=[];
 for(let i=0;i<actual.length;i++){
  try{assert.deepEqual(actual[i],expected[i]);}
  catch{bad.push({fixture:cliFixtures[i],node:expected[i],rust:actual[i]});}
 }
 assert.deepEqual(bad,[],JSON.stringify(bad,null,2));
 console.log('Verified',fixtures.length,'Node/Rust CLI and Graph cases');
});
