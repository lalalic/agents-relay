import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,existsSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const binary=resolve(import.meta.dirname,'../target/debug/agents-relay-rust');
const nodeCli=resolve(import.meta.dirname,'../../dist/cli.js');
const baseArgs=['escalation','run','--intent','Review requires an owner decision','--blocked-on','missing authenticated approval'];

test('Native escalation CLI maps trusted executor outcomes through the canonical Graph',()=>{
 const root=mkdtempSync(join(tmpdir(),'relay-native-escalation-'));
 try{
  const executor=join(root,'executor.sh');
  writeFileSync(executor,'#!/bin/sh\nprintf \'{"status":"needs_user","summary":"Owner action required"}\'\n');
  chmodSync(executor,0o700);
  const env={...process.env,AGENTS_RELAY_ESCALATION_COMMAND:JSON.stringify([executor,'fixed-argument'])};
  const result=spawnSync(binary,[...baseArgs,'--cwd',root],{encoding:'utf8',env,timeout:5000});
  assert.equal(result.status,0,result.stderr);
  const native=JSON.parse(result.stdout);
  assert.deepEqual(native,{state:'needs_user',result:{status:'needs_user',summary:'Owner action required'}});
  const node=spawnSync(process.execPath,[nodeCli,'escalation','--intent','Review requires an owner decision','--blocked-on','missing authenticated approval','--cwd',root],{encoding:'utf8',env,timeout:5000});
  assert.equal(node.status,0,node.stderr);
  const nodeResult=JSON.parse(node.stdout);
  assert.deepEqual({state:native.state,status:native.result.status,summary:native.result.summary},nodeResult);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('missing executor stays a technical failure and request content is never command input',()=>{
 const root=mkdtempSync(join(tmpdir(),'relay-native-escalation-'));
 try{
  const marker=join(root,'injected');
  const request='$(touch '+marker+')';
  const executor=join(root,'executor.sh');
  writeFileSync(executor,`#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--handoff-file" ]; then file="$2"; shift 2; else shift; fi\ndone\ngrep -F '${request}' "$file" >/dev/null || exit 11\nprintf '{"status":"resolved","summary":"Checked literal handoff"}'\n`);
  chmodSync(executor,0o700);
  const command=spawnSync(binary,['escalation','run','--intent',request,'--blocked-on','wait'],{encoding:'utf8',env:{...process.env,AGENTS_RELAY_ESCALATION_COMMAND:JSON.stringify([executor])},timeout:5000});
  assert.equal(command.status,0,command.stderr);
  assert.equal(JSON.parse(command.stdout).state,'resolved');
  assert.equal(existsSync(marker),false);
  const missing=spawnSync(binary,baseArgs,{encoding:'utf8',env:{...process.env,AGENTS_RELAY_ESCALATION_COMMAND:''},timeout:5000});
  assert.equal(missing.status,2);
  assert.equal(JSON.parse(missing.stdout).state,'technical_failure');
  assert.match(missing.stderr,/no recovery or human blocker was established/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
