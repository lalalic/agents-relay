// Every original Node src/execution-context.ts public API is exercised with
// the production Rust resolver, real Git and layered Agent Markdown content.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {resolveExecutionContext,resolveAgentModelPreference,
  resolveAgentContract,agentContractPrompt,executionContextPrompt}
  from '../../dist/execution-context.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const fixture=mkdtempSync(join(tmpdir(),'r2-exe-ctx-'));
test.after(()=>rmSync(fixture,{recursive:true,force:true}));
const workspace=join(fixture,'workspace'),project=join(workspace,'project');
const shared=join(fixture,'shared'),global=join(fixture,'global');
for(const path of [workspace,project,shared,global,join(project,'agents'),
  join(project,'skills','fixture'),join(shared,'agents'),join(shared,'skills','shared-only')])
  mkdirSync(path,{recursive:true});
writeFileSync(join(global,'AGENTS.md'),'# Global AGENTS\n');
writeFileSync(join(workspace,'AGENTS.md'),'# Workspace AGENTS\n');
writeFileSync(join(shared,'AGENTS.md'),'# Shared AGENTS\n');
writeFileSync(join(project,'AGENTS.md'),'# Project AGENTS\n');
writeFileSync(join(project,'README.md'),'# Isolated Project README\n');
writeFileSync(join(project,'skills','fixture','SKILL.md'),'# Fixture skill\n');
writeFileSync(join(shared,'skills','shared-only','SKILL.md'),'# Shared-only skill\n');
writeFileSync(join(project,'agents','fixture.agent.md'),`---
name: fixture
model: fixture-model
reasoning: medium
capabilities: [test, code]
runtime: codex
---
# Fixture project Agent

Project-local override.\n`);
writeFileSync(join(shared,'agents','shared-agent.agent.md'),`---
name: shared-agent
reasoning: high
capabilities: [view, read]
---
# Shared fixture Agent\n`);
const init=spawnSync('git',['init','-q','-b','main'],{cwd:project});
assert.equal(init.status,0,init.stderr?.toString());
const base={workspaceRoot:workspace,globalRoot:global};
const registry={name:'registered-fixture',id:'r1',responsibility:'Registrar',
  capabilities:['tool'],runtime:{adapter:'chatgpt'},routing:{trustDomains:[]},boundaries:[]};
const fixtures=[];
let seed=0x73720;
function rnd(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
function choice(xs){return xs[rnd()%xs.length];}
const methods=['resolve','resolve','preference','contract','agentPrompt','contextPrompt'];
const roles=['planner','worker','nested-worker','troubleshooter','reviewer','orchestrator'];
const agents=['fixture','implementation','shared-agent','registered-fixture','missing-agent',''];
for(let i=0;i<110;i++){
 const method=choice(methods),role=choice(roles),agentName=choice(agents);
 const options={...base,
   ...(rnd()%3===0?{explicitAgents:[choice(['fixture','implementation','registered-fixture','missing-agent'])]}:{}),
   ...(rnd()%3===0?{explicitSkills:[choice(['fixture','shared-only','missing-skill'])]}:{}),
   ...(rnd()%3===0?{providerInstructions:{codex:['Use verified context']}}:{}),
   ...(rnd()%2===0?{registeredAgents:[registry]}:{}),
   ...(rnd()%2===0?{runtimes:[{adapter:'chatgpt',id:'browser',capabilities:['model']},
      {id:'missing-runtime-name',capabilities:[]}]}:{}),
 };
 fixtures.push({op:'certExecutionContext',project,role,method,agentName,options});
}
for(const method of methods)for(const agentName of agents){
 fixtures.push({op:'certExecutionContext',method,project,role:'worker',agentName,
   options:{...base,registeredAgents:[registry],runtimes:[
     {name:'chatgpt/browser-worker',id:'browser',capabilities:['model','browser']}]} });
}
for(const projectValue of ['','/tmp/does-not-exist-rust2-context','/etc/passwd']){
 for(const method of ['resolve','preference','agentPrompt'])
  fixtures.push({op:'certExecutionContext',method,project:projectValue,
    agentName:'fixture',role:'worker',options:base});
}
async function original(f){
 try{
   const {method,project,role,options,agentName}=f;
   const value=method==='resolve'?await resolveExecutionContext(project,role,options):
     method==='preference'?await resolveAgentModelPreference(project,agentName,options):
       await (async()=>{
         const ctx=await resolveExecutionContext(project,role,options);
         if(method==='contract')return resolveAgentContract(ctx,agentName);
         if(method==='agentPrompt')return agentContractPrompt(ctx,agentName);
         return executionContextPrompt(ctx);
       })();
   return {ok:true,value:JSON.parse(JSON.stringify(value??null))};
 }catch(error){return {ok:false,error:error.message};}
}
function firstDiff(a,b,path=''){
 if(Object.is(a,b))return null;
 if(a===null||b===null||typeof a!=='object'||typeof b!=='object')
  return [path,JSON.stringify(a)?.slice(0,200),JSON.stringify(b)?.slice(0,200)];
 for(const key of new Set([...Object.keys(a),...Object.keys(b)])){
   const diff=firstDiff(a[key],b[key],`${path}/${key}`);if(diff)return diff;
 }
 return null;
}
test('155 real Node/Rust execution context public API and registered Agent cases',async()=>{
 const expected=[];for(const fixture of fixtures)expected.push(await original(fixture));
 const proc=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:90000,
    input:fixtures.map(JSON.stringify).join('\n')+'\n',maxBuffer:18*1024*1024});
 assert.equal(proc.status,0,proc.stderr||proc.error?.message);
 const rows=proc.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,fixtures.length);
 const differences=[];
 for(let i=0;i<rows.length;i++){
   try{assert.deepEqual(rows[i],expected[i]);}
   catch{differences.push({i,method:fixtures[i].method,role:fixtures[i].role,
     agent:fixtures[i].agentName,
     diff:firstDiff(expected[i],rows[i]),
     n:expected[i]?.error,r:rows[i]?.error});}
 }
 for(const difference of differences.slice(0,8))console.log('MISMATCH',difference);
 assert.deepEqual(differences,[],`${differences.length} Node/Rust execution context mismatches`);
 console.log('Verified',fixtures.length,'original Node/Rust execution-context API cases');
});
