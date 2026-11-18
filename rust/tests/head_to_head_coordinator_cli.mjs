// Original Coordinator CLI versus Rust Graph+SQLite. All Git repos, relay
// stores and workspace roots are newly created /tmp fixtures, never live Jobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {runCoordinatorJobCommand} from '../../dist/cli-coordinator.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const tmp=mkdtempSync(join(tmpdir(),'rust2-coordinator-direct-diff-'));
test.after(()=>rmSync(tmp,{recursive:true,force:true}));
const workspace=realpathSync(tmp);
const project=join(workspace,'fixture-repository');
mkdirSync(project,{recursive:true});
const git=spawnSync('git',['init','-q','--initial-branch=main',project],{encoding:'utf8'});
assert.equal(git.status,0,git.stderr);
const base=()=>({
 id:'41',prNumber:0,title:'coordinator fixture',repository:'fixture-repository',
 projectRoot:project,state:'DRAFT',updatedAt:'2026-11-17T12:00:00.000Z',
 plans:[],tasks:[{id:'71',jobId:'41',title:'Coordinator',kind:'work',
  agentName:'coordinator',state:'DRAFT',attempt:0,maxAttempts:3,
  dependencies:[],agentGraph:'flowchart TD\nA[agent:developer]',
  updatedAt:'2026-11-17T12:00:00.000Z'}]
});
const scenarios=[
 {kind:'valid'}, {kind:'missingTask'},
 {kind:'legacy'}, {kind:'foregroundMissing'}, {kind:'foreground'},
 {kind:'badGraph'}, {kind:'noGraph'}, {kind:'unmetDependency'},
 {kind:'projectPath'}, {kind:'wrongWorkspaceBinding'},
 {kind:'terminalForeground'}
];
const rows=scenarios.map((s,i)=>{
 const job=base();
 const args=['--id','41','--task-id','71','--workspace-root',workspace,
  '--store-dir',join(tmp,String(i),'stores'),'--events','none'];
 switch(s.kind){
  case 'missingTask':args[3]='99';break;
  case 'legacy':args.push('--shortcut-local');break;
  case 'foregroundMissing':args.push('--foreground');break;
  case 'foreground':args.push('--foreground');break;
  case 'badGraph':job.tasks[0].agentGraph='graph TD\nA[Worker]';break;
  case 'noGraph':delete job.tasks[0].agentGraph;break;
  case 'unmetDependency':job.tasks[0].dependencies=['98'];break;
  case 'projectPath':args.push('--project-path','/tmp/untrusted');break;
  case 'wrongWorkspaceBinding':job.graphStartContext={
   projectRoot:project,workspaceRoot:'/tmp/old',
   noGitHub:true
  };break;
  case 'terminalForeground':job.state='COMPLETED';args.push('--foreground');break;
 }
 return {...s,job,args,hasForeground:['foreground','terminalForeground'].includes(s.kind)};
});
function simplifiedTask(t){return {
 id:t.id,state:t.state,agentGraph:t.agentGraph??null,attempt:t.attempt,
 dependencies:t.dependencies,
}};
function output(r){return {
 outcome:r.outcome,foregroundCalled:r.foregroundCalled,
 after:{state:r.after.state,graphStartContext:r.after.graphStartContext??null,
  tasks:r.after.tasks.map(simplifiedTask)}
};}
async function node(f){
 const dbfile=join(tmp,String(rows.indexOf(f)),'relay.sqlite');
 mkdirSync(join(tmp,String(rows.indexOf(f))),{recursive:true});
 const db=new SQLiteRelayStore(dbfile,'41');
 try{
  await db.saveJob(structuredClone(f.job));
  const logs=[];
  const original=console.log;console.log=text=>logs.push(text);
  let called=false, outcome;
  try{
   await runCoordinatorJobCommand(f.args,'41',f.hasForeground?
    async()=>{called=true;}:undefined);
   const last=logs.filter(x=>typeof x==='string'&&x.startsWith('{')).at(-1);
   outcome={ok:true,value:last?JSON.parse(last):null};
  }catch(error){outcome={ok:false,error:error.message};}
  finally{console.log=original;}
  return output({outcome,foregroundCalled:called,after:await db.loadJob('41')});
 }finally{db.close();}
}
test('Node/Rust Coordinator immutable root binding and SQLite Graph lifecycle',async()=>{
 const expected=[];for(const f of rows)expected.push(await node(f));
 const requests=rows.map(f=>({op:'apiCliCoordinator',...f,
  graphDirectory:join(root,'workflow')}));
 const process=spawnSync(bin,[],{cwd:root,
  input:requests.map(JSON.stringify).join('\n')+'\n',
  encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
 assert.equal(process.status,0,process.stderr||process.error?.message);
 const actual=process.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,rows.length);
 const bad=[];
 for(let i=0;i<rows.length;i++){
  if(!actual[i].ok){bad.push({i,adapterError:actual[i].error});continue;}
  try{assert.deepEqual(output(actual[i].value),expected[i]);}
  catch{bad.push({i,kind:rows[i].kind,node:expected[i],rust:output(actual[i].value)});}
 }
 assert.deepEqual(bad,[],JSON.stringify(bad,null,2));
 console.log('Verified',rows.length,'Node/Rust Coordinator Graph and SQLite cases');
});
