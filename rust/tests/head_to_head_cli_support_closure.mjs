// Direct Node src/cli-support.ts vs Rust rust/src/cli_support.rs option parity.
// Pure CLI parsing only: no Codex CLI, network services, production SQLite or Jobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {
  SERVICE_DEFAULTS,arg,hasArg,priority,storySize,chatGptTabClosePolicy,
  jobTagFromArgs,continuation,rejectRemovedJobOptions,
  rejectRemoteLifecycleOptions,integerArg,newLocalRepository,
  repository,optionalLegacyPr,eventBusResolutionMessage,
} from '../../dist/cli-support.js';

const root=resolve(import.meta.dirname,'../..');
const executable=join(root,'rust/target/debug/relay-rust2-parity');
const scratch=mkdtempSync(join(tmpdir(),'rust2-cli-support-parity-'));
test.after(()=>rmSync(scratch,{force:true,recursive:true}));
let state=0x8112acba;
function rnd(){state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;}
function pick(items){return items[rnd()%items.length];}
const fixtures=[];
function add(method,args,options={}){
  const {flag='',fallback,env,resolution}=options;
  const request={op:'cliSupportPure',method,args,flag,...(fallback!==undefined?{fallback}:{}),
    ...(env!==undefined?{env}:{}),...(resolution!==undefined?{resolution}:{})};
  let outcome;
  const oldEnv=process.env.AGENTS_RELAY_CHATGPT_TAB_CLOSE_POLICY;
  try {
    if(method==='chatGptTabClosePolicy') {
      if(env===undefined || env==='')delete process.env.AGENTS_RELAY_CHATGPT_TAB_CLOSE_POLICY;
      else process.env.AGENTS_RELAY_CHATGPT_TAB_CLOSE_POLICY=env;
    }
    const fn={
      defaults:()=>SERVICE_DEFAULTS,
      arg:()=>arg(args,flag,fallback??''),
      hasArg:()=>hasArg(args,flag),
      priority:()=>priority(args,fallback??'P2'),
      storySize:()=>storySize(args,fallback??'M'),
      chatGptTabClosePolicy:()=>chatGptTabClosePolicy(args),
      jobTagFromArgs:()=>jobTagFromArgs(args),
      continuation:()=>continuation(args),
      rejectRemovedJobOptions:()=>rejectRemovedJobOptions(args),
      rejectRemoteLifecycleOptions:()=>rejectRemoteLifecycleOptions(args),
      integerArg:()=>integerArg(args,flag,fallback??0),
      newLocalRepository:()=>newLocalRepository(args),
      repository:()=>repository(args),
      eventBusResolutionMessage:()=>eventBusResolutionMessage(resolution),
    }[method];
    const value=fn();
    outcome={ok:true,value:value===undefined?null:JSON.parse(JSON.stringify(value))};
  } catch(error){outcome={ok:false,error:error.message};}
  finally {
    if(oldEnv===undefined)delete process.env.AGENTS_RELAY_CHATGPT_TAB_CLOSE_POLICY;
    else process.env.AGENTS_RELAY_CHATGPT_TAB_CLOSE_POLICY=oldEnv;
  }
  fixtures.push({request,expected:outcome});
}
add('defaults',[]);
const flags=['--input','--repo','--mode','--priority','--story-size','--tag','--host','--port'];
const values=['','P0','P1','P2','P3','p2','L','m','s','bad','🍀','../escape','owner/repo',
  'some-repo','2','3','-1','0','1.5',' 4 ','Infinity','0x10','--flag','0'];
const unknownFlags=['--mode','--execution-mode','--schedule','--schedule-next-run',
  '--schedule-timezone','--missed-run-policy','--schedule-concurrency','--cron','--schedule-cron',
  '--github-repo','--pr','--no-github','--dependent-pr','--head','--base','--body','--github-app-id',
  '--github-app-installation-id','--github-app-private-key-file','--github-webhook-secret',
  '--github-webhook-secret-file','--github-token','--github-token-file','--projection-ms'];
for(let i=0;i<560;i++){
  const args=i%4===0?[]:i%4===1?[pick(flags),pick(values)]:
    i%4===2?[pick(flags),pick(values),pick(flags),pick(values)]:
      [pick(flags),pick(values),pick(flags)];
  const method=pick(['arg','hasArg','priority','storySize','chatGptTabClosePolicy',
    'jobTagFromArgs','continuation','rejectRemovedJobOptions','rejectRemoteLifecycleOptions',
    'integerArg','newLocalRepository','repository']);
  const fallback=method==='integerArg'?pick([0,1,7,42]):pick(['','P2','P1','M','L','S','bad']);
  const env=pick([undefined,'','after-start','after-terminal','never','bad']);
  add(method,args,{flag:pick(flags),fallback,env});
}
for(const flag of unknownFlags) {
  add('rejectRemovedJobOptions',[flag,'x']);
  add('rejectRemoteLifecycleOptions',[flag+'=x']);
  add('rejectRemoteLifecycleOptions',[flag,'x']);
}
for(const raw of ['', '{}','null','false','{"description":"ok","values":{"a":"A"}}',
  '{"description":"ok","values":{}}','{"description":"bad","values":{"xyz":"100"}}',
  '{"description":"   ","values":{"a":"A"}}', 'bad json','{"values":{"a":"A"}}']){
  add('jobTagFromArgs',['--tag',raw]);
}
for(const kind of ['command','webhook','codex-thread','bad','']){
 for(const target of ['https://example.org','abc','']){
  add('continuation',['--continue-kind',kind,'--continue-target',target,'--continue-input','hello']);
 }
}
for(const source of ['auto','explicit','local','unavailable','invalid']){
 for(const transport of ['nats','none']){
  add('eventBusResolutionMessage',[],{resolution:{source,transport,natsUrl:'nats://127.0.0.1'}});
 }
}
// Edge values accepted by JavaScript Number.isInteger even when they cannot
// fit u64; they must not be truncated or rejected by the native CLI.
for(const raw of ['1e25','1e100','9007199254740992','9007199254740991','1e308']){
 add('integerArg',['--limit',raw],{flag:'--limit',fallback:7});
}
test('Node and Rust CLI support parsing, rejection and shape are directly equivalent',()=>{
 const input=fixtures.map(f=>JSON.stringify(f.request)).join('\n')+'\n';
 const run=spawnSync(executable,[],{
   cwd:root,input,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024,
   env:{...process.env,AGENTS_RELAY_STORE_DIR:join(scratch,'stores')},
 });
 assert.equal(run.status,0,run.stderr||run.error?.message);
 const output=run.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(output.length,fixtures.length,'One result per real Rust invocation');
 const mismatches=[];
 for(let i=0;i<fixtures.length;i++){
   try {assert.deepEqual(output[i],fixtures[i].expected);}
   catch {mismatches.push({index:i,request:fixtures[i].request,node:fixtures[i].expected,rust:output[i]});}
 }
 assert.deepEqual(mismatches.slice(0,15),[],
   `${mismatches.length} Node/Rust mismatches out of ${fixtures.length} independent cases`);
 console.log(`Verified ${fixtures.length} direct Node/Rust CLI support fixtures`);
});
