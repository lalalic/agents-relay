// Exact src/reconciler-context.ts exports versus production Rust public
// resolver with real layered Agent Markdown, Git roots and registered agents.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {agentModelPreferenceForJob,resolveTaskContext,resolvePlannerContext}
  from '../../dist/reconciler-context.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const fixture=mkdtempSync(join(tmpdir(),'rust2-reconciler-context-'));
test.after(()=>rmSync(fixture,{recursive:true,force:true}));
const workspace=join(fixture,'workspace'),project=join(workspace,'project');
const shared=join(fixture,'shared'),global=join(fixture,'global');
for(const path of [workspace,project,shared,global,join(project,'agents'),join(project,'skills','fixture')])
  mkdirSync(path,{recursive:true});
writeFileSync(join(global,'AGENTS.md'),'# Isolated global agents\n');
writeFileSync(join(workspace,'AGENTS.md'),'# Isolated workspace agents\n');
writeFileSync(join(project,'AGENTS.md'),'# Isolated project agents\n');
writeFileSync(join(project,'README.md'),'# Test project\n');
writeFileSync(join(project,'agents','fixture.agent.md'),`---
name: fixture
model: fixture-model
reasoning: high
capabilities: [code, test]
runtime: chatgpt
---
# Fixture Agent

Isolated Agent with model preference.\n`);
writeFileSync(join(project,'skills','fixture','SKILL.md'),'# Fixture Skill\n');
const initialized=spawnSync('git',['init','-q','-b','main'],{cwd:project});
assert.equal(initialized.status,0,initialized.stderr?.toString());
const roots={workspaceRoot:shared,globalRoot:global};
const regist={id:'reg-id',name:'registered-fixture',responsibility:'Registered fixture only',
  capabilities:['tools'],runtime:{adapter:'chatgpt'},routing:{trustDomains:[]},boundaries:[]};
const adapters=[{name:'chatgpt/browser-worker',id:'chatgpt/browser-worker',
  capabilities:['model','browser']},{name:'codex',id:'codex',capabilities:['model','code']}];
const fixtures=[];
let seed=0x41418;function rnd(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
const pick=list=>list[rnd()%list.length];
for(let i=0;i<64;i++){
 const method=pick(['task','task','planner','preference']);
 const options={...roots,
   ...(rnd()%3===0?{explicitAgents:[pick(['fixture','implementation','registered-fixture','not-visible'])]}:{}),
   ...(rnd()%4===0?{explicitSkills:[pick(['fixture','missing-skill'])]}:{}),
   ...(rnd()%3===0?{providerInstructions:{chatgpt:['Use Task contract']}}:{}),
 };
 if(method==='preference')fixtures.push({op:'certReconcilerContext',method,project,
   options,agentName:pick(['fixture','implementation','not-visible','']),
   ...(rnd()%4===0?{}:{preferenceRoot:project}),
   task:{routing:{cwd:project}}});
 else fixtures.push({op:'certReconcilerContext',method,project,options,
   role:pick(['worker','nested-worker','planner','troubleshooter','reviewer']),
   agents:rnd()%2===0?[regist]:[],adapters:rnd()%2===0?adapters:[]});
}
for(const name of ['fixture','implementation','not-visible',null]){
 for(const preferenceRoot of [project,null])fixtures.push({op:'certReconcilerContext',
   method:'preference',project,options:roots,agentName:name,
   preferenceRoot,task:{routing:{cwd:project}}});
}
for(const method of ['task','planner'])for(const role of
 ['worker','nested-worker','troubleshooter','planner','reviewer']){
 fixtures.push({op:'certReconcilerContext',method,role,project,options:roots,
   agents:[regist],adapters});
}
// Real negative adapter declarations and unresolved registered-agent filters.
// Runtime adapter metadata must not silently invent a selected Worker name.
for(const method of ['task','planner'])for(const adapter of [
 {adapter:'chatgpt',id:'fixture',capabilities:['model']},
 {name:null,adapter:'script',id:'fixture2',capabilities:[]},
 {id:'fixture3',capabilities:[]},
 {name:'',id:'fixture4',capabilities:[]},
])for(const registered of [true,false]){
 fixtures.push({op:'certReconcilerContext',method,role:'worker',project,
   options:{...roots,explicitAgents:[registered?'registered-fixture':'fixture']},
   agents:registered?[regist]:[],adapters:[adapter]});
}
async function nodeCase(f){
 const job={id:'10',repository:'fixture',projectRoot:project,tasks:[],plans:[]};
 const task=f.task||{id:'1',jobId:'10',routing:{cwd:project}};
 const options={executionContextRoots:f.options,adapters:f.adapters??[],
   cwdForJob:async()=>project,
   agentPreferenceRootForJob:f.preferenceRoot?async()=>f.preferenceRoot:undefined};
 const store={listAgents:async()=>f.agents??[]};
 try {
  const value=f.method==='planner'?
    await resolvePlannerContext(store,options,job,task):
    f.method==='task'?
      await resolveTaskContext(store,options,job,task,f.role,project):
      await agentModelPreferenceForJob(options,job,f.agentName??undefined,task);
  // JS optional `undefined` metadata is not a JSON wire value. Compare the
  // exact persisted public JSON shape, never in-memory JS undefined keys.
  return {ok:true,value:JSON.parse(JSON.stringify(value??null))};
 } catch(error){return {ok:false,error:error.message};}
}
test('original Node/Rust 98 Reconciler Context public API cases',async()=>{
 const expected=[];
 for(const fixture of fixtures)expected.push(await nodeCase(fixture));
 const child=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:90000,
   input:fixtures.map(JSON.stringify).join('\n')+'\n',maxBuffer:18*1024*1024});
 assert.equal(child.status,0,child.stderr||child.error?.message);
 const observed=child.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(observed.length,expected.length);
 const mistakes=[];
 for(let i=0;i<fixtures.length;i++){
   try{assert.deepEqual(observed[i],expected[i]);}
   catch{mistakes.push({i,method:fixtures[i].method,role:fixtures[i].role,
     fixture:fixtures[i],node:expected[i],rust:observed[i]});}
 }
 const diff=(left,right,prefix='')=>{
   if(left===right)return null;
   if(typeof left!==typeof right||left===null||right===null)return [prefix,left,right];
   if(typeof left!=='object')return [prefix,left,right];
   for(const key of new Set([...Object.keys(left),...Object.keys(right)])){
     const found=diff(left[key],right[key],prefix+'.'+key);
     if(found)return found;
   }
   return null;
 };
 for(const m of mistakes.slice(0,4)){
  console.log('MISMATCH',m.i,m.method,m.role,
    JSON.stringify(diff(m.node,m.rust)?.map(x=>JSON.stringify(x).slice(0,180))),
    'N=',JSON.stringify(m.node).slice(0,300),
    'R=',JSON.stringify(m.rust).slice(0,300));
 }
 assert.deepEqual(mistakes.map(m=>m.i),[],`${mistakes.length} Node/Rust Reconciler context mismatches`);
 console.log('Verified',fixtures.length,'original Node/Rust Reconciler context cases');
});
