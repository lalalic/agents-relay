// All public original Node daemon utilities versus native Rust daemon ports.
// Daemon configuration inputs are test fixtures; no daemon is started.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {resolve} from 'node:path';
import * as src from '../../dist/relayd-utilities.js';
const root=resolve(import.meta.dirname,'../..');const bin=resolve(root,'rust/target/debug/relay-rust2-parity');
const fixtures=[{action:'help'}];
for(const args of [[],['--repo','project'],['--repo'],
 ['--repo','project','--workspace','./old'],['--workspace-root','./child'],
 ['--workspace-root','..','--workspace','../old'],
 ['--workspace','./old'],
 ['--interval','100'],['--repo','project','--workspace-root','../isolated']]){
 fixtures.push({action:'normalize',args});fixtures.push({action:'value',args,name:'--repo',fallback:'fallback'});
}
for(const decision of [null,{}, {stages:[]},{stages:[{contract:{choices:['a','b',5,false,null]}}]},
 {stages:[{contract:{choices:[]}}]},{stages:[{contract:{}},{contract:{choices:['x']}}]},
 {stages:'invalid'}])fixtures.push({action:'choices',decision});
const overview=(repo,id,state,prNumber=0)=>({job:{id,repository:repo,prNumber,state},history:['fixture']});
for(let i=0;i<38;i++){
 const current=[overview('a','1','ACTIVE'),overview('b','2','COMPLETED')];
 const discovered=[overview(i%3?'a':'b',i%2?'1':'2',i%4?'FAILED':'COMPLETED'),overview('z','3','ACTIVE')];
 fixtures.push({action:'merge',current,discovered});
 const cached=[...current,...discovered];
 fixtures.push({action:'recovery',repositories:['a','b','c','z','no-jobs'],cached,index:i%9-4});
 fixtures.push({action:'overlay',overviews:current,updates:{a:{'0':{...current[0].job,title:`new-title-${i}`}},b:{'0':{...current[1].job,title:'verified'}}}});
}
function rustAll(){
 const rows=fixtures.map(f=>({op:'certDaemonUtilities',...f}));
 const p=spawnSync(bin,[],{cwd:root,input:rows.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',timeout:35000,maxBuffer:6e6});
 assert.equal(p.status,0,p.stderr);return p.stdout.trim().split('\n').map(s=>JSON.parse(s));
}
async function node(f){
 try{
  let value;
  switch(f.action){
   case 'help':value=src.daemonHelp;break;
   case 'value':value=src.value(f.args,f.name,f.fallback);break;
   case 'normalize':{
    const old=process.env.AGENTS_RELAY_WORKSPACE_ROOT;
    try{
      delete process.env.AGENTS_RELAY_WORKSPACE_ROOT;
      const parsed=src.normalizeDaemonArguments(f.args);
      const {pullRequest:retiredPr,jobId:retiredId,...current}=parsed;
      value=current;
    }finally{if(old===undefined)delete process.env.AGENTS_RELAY_WORKSPACE_ROOT;else process.env.AGENTS_RELAY_WORKSPACE_ROOT=old;}
    break;
   }
   case 'choices':value=src.firstStageChoices(f.decision??undefined);break;
   case 'merge':value=src.mergeOperationalInventory(f.current,f.discovered);break;
   case 'recovery':value=src.recoveryScanRepositories(f.repositories,f.cached,f.index);break;
   case 'overlay':value=await src.overlayOperationalOverviews(f.overviews,(repo,pr)=>({
    async hydrate(){},async load(id){return f.updates[repo]?.[String(pr)] ?? f.overviews.find(x=>x.job.id===id).job;},
   }));break;
   default:throw Error('unknown');
  }
  return {ok:true,value};
 }catch(error){return {ok:false,error:error.message};}
}
test('original Node/Rust seven daemon utility contracts and 8th overview hydrate',async()=>{
 const actual=rustAll();assert.equal(actual.length,fixtures.length);
 for(let i=0;i<fixtures.length;i++){
  const expected=await node(fixtures[i]);
  assert.deepEqual(actual[i],expected,`daemon utility ${i}: ${JSON.stringify(fixtures[i])}`);
 }
 console.log(`Original Node/Rust daemon utility differential: ${fixtures.length} public API fixtures`);
});
