// Daemon process-wide public effects: independently compare Node and native Rust.
// Does not launch a daemon, touch a real router file, or configure live services.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {configureDaemonObservability,configureExecutionRouterRulesPath} from '../../dist/relayd-utilities.js';
import {observability} from '../../dist/observability.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const levels=['debug','info','warn','error','unknown'];
const all=[undefined,'','debug','info','warn','error','silent','NONE','off','0','false','trUe','silent ','WARN','bad'];
const fixtures=[];
for(const mode of all)for(const asFallback of [false,true]){
 const env={};
 if(asFallback)env.RELAY_OBSERVABILITY_LEVEL=mode;
 else env.AGENTS_RELAY_OBSERVABILITY=mode;
 fixtures.push({op:'apiDaemonObservability',env,levels});
}
for(const explicit of [null,'','custom-rules.md','/tmp/readonly-rule.md']) {
 for(const current of [undefined,'','previous-rules.md','/tmp/env-rules.md']){
  const args=explicit===null?[]:['--execution-router-rules',explicit];
  const env=current===undefined?{}:{AGENTS_RELAY_EXECUTION_ROUTER_RULES:current};
  fixtures.push({op:'apiRouterRulesDaemonConfig',args,env,home:homedir()});
 }
}
function rust(fixtures){
 const p=spawnSync(binary,[],{cwd:root,
  input:fixtures.map(JSON.stringify).join('\n')+'\n',
  encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
 assert.equal(p.status,0,p.stderr||p.error?.message);
 return p.stdout.trim().split('\n').map(JSON.parse);
}
async function node(f){
 if(f.op==='apiDaemonObservability'){
  const observer=configureDaemonObservability(f.env);
  return {level:observer.minimumLevel,installedLevel:observability().minimumLevel,
    enabled:f.levels.map(level=>observer.isEnabled(level))};
 }
 const saved=process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES;
 try{
  if(f.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES===undefined)delete process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES;
  else process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES=f.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES;
  const path=configureExecutionRouterRulesPath(f.args);
  return {path,env:{...f.env,...(process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES!==undefined?
    {AGENTS_RELAY_EXECUTION_ROUTER_RULES:process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES}:{})}};
 }finally{
  if(saved===undefined)delete process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES;
  else process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES=saved;
 }
}
test('46 actual Node/Rust daemon public API cases',async()=>{
 const expected=[];for(const f of fixtures)expected.push(await node(f));
 const actual=rust(fixtures);
 assert.equal(actual.length,fixtures.length);
 const failures=[];
 for(let i=0;i<fixtures.length;i++){
  try{assert.deepEqual(actual[i],{ok:true,value:expected[i]});}
  catch{failures.push({case:i,fixture:fixtures[i],node:expected[i],rust:actual[i]});}
 }
 assert.deepEqual(failures,[],JSON.stringify(failures,null,2));
 console.log('Verified',fixtures.length,'Node/Rust daemon and routing-path API cases');
});
