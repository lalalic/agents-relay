// Real original Node and Rust adapters differential: Codex argument
// construction, browser-driver receipt parsing, ChatGPT tab close policy,
// WebHelm readiness (Node through a fixture executable on the real
// browserWorkspaceCli override path, Rust through the injected runner), and
// adapter identity contracts. Every value and error text is compared exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,mkdirSync,rmSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {
  buildCodexArgs,chatGptTabClosePolicy,parseDriverJson,
  ensureChatGptWebHelmReady,CodexAdapter,ChatGptAdapter,
} from '../../dist/adapters.js';

const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');

const tryJson=(value)=>{
  try{return {ok:true,receipt:JSON.parse(JSON.stringify(value))};}
  catch{return {ok:false,error:'unserializable'};}
};

const buildCase=(route,input)=>{
  try{return {ok:true,args:buildCodexArgs(route,input)};}
  catch(error){return {ok:false,error:error?.message??String(error)};}
};
const driverCase=(output)=>{
  try{return {ok:true,receipt:parseDriverJson(output)};}
  catch(error){return {ok:false,error:error?.message??String(error)};}
};
const policyCase=(value,fallback)=>{
  try{return {ok:true,policy:chatGptTabClosePolicy(value,fallback)};}
  catch(error){return {ok:false,error:error?.message??String(error)};}
};

const receipt=(over={})=>({operation:'submit',status:'submitted',
  threadId:'th-1',...over});

test('original Node/Rust adapters public differential',async()=>{
  const cases=[];
  const expected=[];
  const push=(payload,nodeOutcome)=>{cases.push(payload);expected.push(nodeOutcome);};

  // ---- buildCodexArgs ----
  const INPUTS=['Do the task','  spaced  ','ünïcode input','-leading-dash','multi\nline'];
  const ROUTES=[
    {},{profile:'proj'},{provider:'o4-mini'},{profile:'proj',provider:'ignored'},
    {model:'gpt-5.2'},{reasoning:'high'},{cwd:'/tmp/work'},
    {profile:'proj',model:'gpt-5.2',reasoning:'medium',cwd:'/w'},
    {provider:'o4',model:'gpt-5.2'},{profile:''},{provider:''},{model:''},
  ];
  for(const route of ROUTES)for(const input of INPUTS.slice(0,2))
    push({method:'buildCodexArgs',route,input},buildCase(route,input));
  for(const input of INPUTS.slice(2))
    push({method:'buildCodexArgs',route:{profile:'p'},input},buildCase({profile:'p'},input));

  // ---- parseDriverJson ----
  const DRIVERS=[
    JSON.stringify(receipt()),
    `diagnostic line\n${JSON.stringify(receipt({operation:'new-turn'}))}`,
    JSON.stringify({result:receipt()}),
    JSON.stringify({output:{data:receipt()}}),
    JSON.stringify({stdout:JSON.stringify(receipt({mode:'new-thread'}))}),
    `noise\n${JSON.stringify({ok:false})}\n${JSON.stringify(receipt())}`,
    `\r\n${JSON.stringify(receipt())}\r\n`,
    '   \n  \n',
    'not json at all',
    JSON.stringify({operation:'submit',status:'pending'}),
    JSON.stringify({mode:'new-turn',status:'submitted',depth:{result:receipt()}}),
    `${JSON.stringify(receipt({threadId:'first'}))}\n${JSON.stringify(receipt({threadId:'last'}))}`,
  ];
  for(const output of DRIVERS)
    push({method:'parseDriverJson',output},driverCase(output));

  // ---- chatGptTabClosePolicy ----
  const POLICIES=[
    ['after-start',undefined],['never',undefined],['after-terminal',undefined],
    [undefined,'never'],[undefined,undefined],['','after-terminal'],
    ['bogus',undefined],['','never'],['AFTER-START',undefined],
    ['after-start','never'],
  ];
  for(const [value,fallback] of POLICIES)
    push({method:'tabClosePolicy',value,fallback},policyCase(value,fallback));

  // ---- ensureChatGptWebHelmReady ----
  const dir=mkdirSync(join(tmpdir(),'r2-adapters-h2h-'+process.pid),{recursive:true});
  try{
    const SCENARIOS={
      'ok':{profile:'{"platform":"chatgpt"}',status:'{"daemon":{"running":true}}'},
      'wrong-platform':{profile:'{"platform":"codex"}',status:'{"daemon":{"running":true}}'},
      'daemon-false':{profile:'{"platform":"chatgpt"}',status:'{"daemon":{"running":false}}'},
      'daemon-missing':{profile:'{"platform":"chatgpt"}',status:'{}'},
      'daemon-string':{profile:'{"platform":"chatgpt"}',status:'{"daemon":{"running":"yes"}}'},
      'profile-no-json':{profile:'loading skill...',status:'{"daemon":{"running":true}}'},
      'status-no-json':{profile:'{"platform":"chatgpt"}',status:'daemon: ok'},
    };
    for(const [scenario,{profile,status}] of Object.entries(SCENARIOS)){
      const fixture=join(dir,scenario+'.sh');
      writeFileSync(fixture,
        `#!/bin/sh\ncase "$1" in\nplatform) printf '%s\\n' '${profile}';;\n`
        +`status) printf '%s\\n' '${status}';;\nesac\nexit 0\n`);
      chmodSync(fixture,0o755);
      let nodeOutcome;
      try{
        await ensureChatGptWebHelmReady(fixture);
        nodeOutcome={ok:true};
      }catch(error){
        nodeOutcome={ok:false,error:error?.message??String(error)};
      }
      push({method:'webhelmReady',scenario},nodeOutcome);
    }
  }finally{
    rmSync(dir,{recursive:true,force:true});
  }

  // ---- adapter identity ----
  delete process.env.AGENTS_RELAY_CHATGPT_TAB_CLOSE_POLICY;
  const codex=new CodexAdapter();
  const chatgpt=new ChatGptAdapter();
  push({method:'adapterIdentity'},{codex:{name:codex.name,id:codex.id,
    capabilities:codex.capabilities},
    chatgpt:{name:chatgpt.name,id:chatgpt.id,capabilities:chatgpt.capabilities},
    chatgptDefaultPolicy:chatgpt.tabClosePolicy});

  // ---- run the Rust side ----
  const result=spawnSync(binary,[],{cwd:root,
    input:cases.map(f=>JSON.stringify({op:'certAdaptersPublic',...f})).join('\n')+'\n',
    maxBuffer:256*1024*1024});
  assert.equal(result.status,0,`parity binary failed: ${result.stderr}`);
  const outputs=result.stdout.toString().trim().split('\n').map(line=>{
    const parsed=JSON.parse(line);
    // The parity binary embeds the module result as raw JSON, so `value`
    // is already the parsed object.
    return parsed.ok?parsed.value:{error:parsed.error};
  });
  assert.equal(outputs.length,cases.length);

  // Canonical stringify: serde_json alphabetizes object keys while V8 keeps
  // insertion order, so compare key-sorted forms on both sides.
  const canonical=(value)=>{
    if(Array.isArray(value))return value.map(canonical);
    if(value&&typeof value==='object'){
      const sorted={};
      for(const key of Object.keys(value).sort())sorted[key]=canonical(value[key]);
      return sorted;
    }
    return value;
  };

  const failures=[];
  for(let i=0;i<cases.length;i++){
    const want=expected[i];
    const got=outputs[i];
    let diff=null;
    if(want.ok!==got.ok)diff=['ok',want.ok,got.ok];
    else if(!want.ok&&want.error!==got.error)diff=['error',want.error,got.error];
    else if(want.ok){
      for(const key of Object.keys(want)){
        if(JSON.stringify(canonical(want[key]))!==JSON.stringify(canonical(got[key]))){
          diff=[key,want[key],got[key]];break;
        }
      }
    }
    if(diff)failures.push({case:i,method:cases[i].method,
      scenario:cases[i].scenario,diff});
  }
  if(failures.length>0){
    console.error('first divergence:',
      JSON.stringify(failures[0],null,1).slice(0,1200));
  }
  assert.equal(failures.length,0,
    `${failures.length}/${cases.length} adapter divergences`);
  console.log(`Verified ${cases.length} original Node/Rust adapters public cases`);
});
