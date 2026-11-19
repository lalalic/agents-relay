// Original compiled Node CLI prompt --eval-file versus the installed Rust
// native CLI with real layered Agent/Skill contracts. Read-only, isolated;
// neither invocation starts a Worker, Codex CLI, or production Relay.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,mkdirSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const cli=join(root,'rust/target/debug/agents-relay-rust');
const nodeCli=join(root,'dist/cli.js');
const dir=mkdtempSync(join(tmpdir(),'r2-prompt-eval-'));
test.after(()=>rmSync(dir,{recursive:true,force:true}));
const project=join(dir,'workspace','project');
for(const path of [project,join(project,'agents'),join(project,'skills','local'),join(dir,'homeagents'),join(dir,'home')])
 mkdirSync(path,{recursive:true});
const git=spawnSync('git',['init','-q','-b','main'],{cwd:project});
assert.equal(git.status,0,git.stderr?.toString());
writeFileSync(join(project,'agents','implementation.agent.md'),
  '---\nname: implementation\n---\n# Isolated implementation Agent\nProof of fixture only.\n');
writeFileSync(join(project,'skills','local','SKILL.md'),'# Local skill\n');
const env={...process.env,HOME:join(dir,'home'),AGENTS_HOME:join(dir,'homeagents'),
 AGENTS_RELAY_WORKSPACE_ROOT:join(dir,'workspace'),AGENTS_RELAY_WORKSPACE_ROOT:''};
function processCall(binary,args){
 return spawnSync(binary===cli?cli:process.execPath,
   binary===cli?['prompt',...args]:[nodeCli,'prompt',...args],
   {cwd:root,env,encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024});
}
const cases=[];
for(let i=0;i<29;i++){
 const agent=i%6===0?'not-visible':'implementation';
 const scenario={projectPath:project,agentName:agent,
   taskInput:i%9===0?'   ':`Evaluate only fixture ${i}: 中文 JSON integrity`,
   caseId:i%8===0?'invalid case':'case-'+i};
 const input=join(dir,`case-${i}.json`);
 writeFileSync(input,JSON.stringify(scenario));
 const adapter=['codex','chatgpt','z','invalid'][i%4];
 cases.push({label:'case-'+i,args:['--eval-file',input,'--adapter',adapter]});
}
for(let i=0;i<12;i++){
 const scenario={projectPath:project,agentName:i%3===0?'implementation':'not-visible',
   taskInput:'Read-only isolated fixture',caseId:'edge-'+i};
 if(i%4===0)delete scenario.projectPath;
 if(i%5===0)scenario.agentName='bad/name';
 const input=join(dir,`edge-${i}.json`);writeFileSync(input,JSON.stringify(scenario));
 const args=['--eval-file',input];
 if(i%2===0)args.push('--task-id','1');
 if(i%3===0)args.push('--plan-id','2');
 cases.push({label:'edge-'+i,args});
}
const message=stderr=>{
 const match=stderr.match(/Error: ([^\n]+)/);
 return match?.[1]??stderr.trim();
};
test('41 exact original Node/Rust prompt evaluation CLI cases',()=>{
 const mismatches=[];
 for(const entry of cases){
  const node=processCall('node',entry.args);
  const rust=processCall(cli,entry.args);
  try{
   assert.equal(node.error,undefined);
   assert.equal(rust.error,undefined);
   assert.equal(node.status===0,rust.status===0,`${message(node.stderr)} != ${message(rust.stderr)}`);
   if(node.status===0){
    assert.equal(rust.stdout,node.stdout,'Public JSON + Agent contracts must match byte-for-byte');
    const contract=JSON.parse(node.stdout);
    assert.equal(contract.builder,'managedWorkerInput');
    assert.ok(contract.productionPrompt.includes('You are implementation with responsibility at '));
    const source=contract.productionPrompt.split('You are implementation with responsibility at ')[1]
      .split(/\s/)[0].replace(/\.$/,'');
    assert.ok(readFileSync(source,'utf8').includes('Isolated implementation Agent'));
    assert.notEqual(contract.productionPrompt,contract.evaluationPrompt);
   }else assert.ok(message(node.stderr).includes(message(rust.stderr))
     ||message(rust.stderr).includes(message(node.stderr)),
      'Node/Rust error messages diverged');
  }catch(error){mismatches.push({label:entry.label,args:entry.args,
    node:{status:node.status,stderr:node.stderr.slice(0,360),out:node.stdout.slice(0,350)},
    rust:{status:rust.status,stderr:rust.stderr.slice(0,360),out:rust.stdout.slice(0,350)},
    reason:error.message});}
 }
 assert.deepEqual(mismatches.slice(0,3),[],`${mismatches.length} original Node/Rust prompt CLI mismatches`);
 console.log('Verified',cases.length,'original Node/Rust prompt --eval-file CLI cases');
});
