// Original Node AgentObjectivePlanner and Rust shared planner strategy.
// Actual Node owned process is disposable, with no Codex CLI/provider/network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {AgentObjectivePlanner} from '../../dist/planner.js';
import {mkdtempSync,rmSync,writeFileSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const root=resolve(import.meta.dirname,'../..');
const tmp=mkdtempSync(join(tmpdir(),'r2-planner-agent-original-'));
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const agentFile=join(tmp,'planner.agent.md');
const storeDir=join(tmp,'stores');
writeFileSync(agentFile,'# Planner\nReturn a matching PLAN_APPLIED receipt only after an authorized plan apply.');
const context={
 job:{id:'41',title:'Planner real subprocess test',tasks:[],plans:[],state:'ACTIVE'},
 tasks:[],objective:'Verify evidence',previousPlannerTaskId:null,
 planExecution:{planId:'plan-1',executionId:'generation-9'},
};
const message=(content,type='item.completed')=>type==='event_msg'
 ? JSON.stringify({type:'event_msg',payload:{type:'task_complete',last_agent_message:content}})
 : JSON.stringify({type:'item.completed',item:{type:'agent_message',text:content}});
const scenarios=[
 {output:message('PLAN_APPLIED:plan-1:generation-9'),exitCode:0},
 {output:message('PLAN_APPLIED:plan-1:generation-9','event_msg'),exitCode:0},
 {output:message('PLAN_APPLIED:plan-1:wrong'),exitCode:0},
 {output:message('not-applied'),exitCode:0},
 {output:'{"type":"turn.started"}',exitCode:0},
 {output:message('PLAN_APPLIED:plan-1:generation-9'),stderr:'bad exit',exitCode:3},
 {output:message('PLAN_APPLIED:plan-1:generation-9'),exitCode:0,
  context:{...context,planExecution:undefined}},
 {output:message('PLAN_APPLIED:plan-1:generation-9\n'),exitCode:0},
];
const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
async function nodeOutcome(f,command){
 try{
  const result=await new AgentObjectivePlanner(command,agentFile)
   .plan(f.context||context,new AbortController().signal);
  return {ok:true,value:result};
 }catch(error){return {ok:false,error:error.message};}
}
test('actual original owned Node Agent Planner vs native Rust receipt and failure parity',async()=>{
 try{
  const fixtures=[];
  for(let i=0;i<scenarios.length;i++){
   const f=scenarios[i];
   const command=join(tmp,'planner-command-'+i+'.sh');
   writeFileSync(command,
    '#!/bin/sh\nprintf %s\\\\n '+quote(f.output)+'\n'+
    (f.stderr?'printf %s '+quote(f.stderr)+' >&2\n':'')+
    'exit '+(f.exitCode||0)+'\n');
   chmodSync(command,0o700);
   fixtures.push({...f,op:'certPlannerAgentPublic',agentFile,
    command,storeDir,context:f.context||context});
  }
  const expected=[];
  for(const f of fixtures)expected.push(await nodeOutcome(f,f.command));
  const child=spawnSync(bin,[],{cwd:root,encoding:'utf8',timeout:120000,
   maxBuffer:8*1024*1024,input:fixtures.map(JSON.stringify).join('\n')+'\n'});
  assert.equal(child.status,0,child.stderr||child.error?.message);
  const actual=child.stdout.trim().split('\n').map(JSON.parse)
   .map(row=>row.value.outcome);
  const mismatches=[];
  for(let i=0;i<fixtures.length;i++)
   try{assert.deepEqual(actual[i],expected[i]);}
   catch{mismatches.push({case:i,rust:actual[i],node:expected[i]});}
  assert.deepEqual(mismatches,[],JSON.stringify(mismatches,null,2));
  console.log('Verified',fixtures.length,'real AgentObjectivePlanner Node/Rust cases');
 }finally{rmSync(tmp,{recursive:true,force:true});}
});
