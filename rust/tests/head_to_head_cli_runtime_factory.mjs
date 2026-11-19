import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {runtime} from '../../dist/cli.js';
import {InMemoryStore} from '../../dist/store.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const args=[
 [],['--owner','direct-owner'],['--owner','fixture','--concurrency','3'],
 ['--owner','fixture','--concurrency','0','--lease-ms','123456'],
 ['--owner','fixture','--codex','fake-model'],
 ['--owner','fixture','--planner-command','node --test foo'],
 ['--owner','fixture','--planner-command','/bin/true'],
 ['--owner','fixture','--thread-id','thread-123'],
 ['--owner','fixture','--workspace-root','/tmp/foo'],
 ['--owner','fixture','--workspace-root','/tmp/shared','--global-root','/tmp/global'],
 ['--owner','fixture','--chatgpt-tab-close-policy','never'],
 ['--owner','fixture','--chatgpt-tab-close-policy','after-start'],
 ['--owner','fixture','--chatgpt-tab-close-policy','after-terminal'],
 ['--owner','fixture','--chatgpt-tab-close-policy','invalid'],
 ['--owner','fixture','--concurrency','bad','--lease-ms','NaN'],
 ['--owner','fixture','--concurrency','-2','--lease-ms','-1'],
 ['--owner','fixture','--concurrency','1.5','--lease-ms','1.5'],
 ['--owner','fixture','--thread-id',''],
];
const fixture={id:'1',repository:'fixture',state:'DRAFT',tasks:[],plans:[]};
function project(o){
 const adapters=o.adapters.map(({id,name,capabilities,command,tabClosePolicy})=>({id,name,capabilities,...(command!==undefined?{command}:{}),...(tabClosePolicy!==undefined?{tabClosePolicy}:{})}));
 const continuations=o.continuations.map(({kind,command})=>({kind,...(command!==undefined?{command}:{})}));
 return JSON.parse(JSON.stringify({noGitHub:o.noGitHub,owner:o.owner,maxConcurrent:o.maxConcurrent,
 leaseMs:o.leaseMs,adapters,continuations,planner:{kind:o.planner.constructor.name,command:o.planner.command},
 plannerName:o.planner.constructor.name,reviewer:o.reviewer,
 chatgptTabClosePolicy:o.chatgptTabClosePolicy,executionContextRoots:o.executionContextRoots,
 decisionMode:o.decisionMode,decisionEngine:{name:o.decisionEngine.name},
 usageSnapshotProvider:typeof o.usageSnapshotProvider==='function'?'fn':null,
 cwdForJob:typeof o.cwdForJob==='function'?'fn':null,emit:typeof o.emit==='function'?'fn':null}));
}
function rust(){
 const child=spawnSync(bin,[],{cwd:root,encoding:'utf8',timeout:120000,
 input:args.map(a=>JSON.stringify({op:'apiCliRuntimeFactory',root,args:a})).join('\n')+'\n',maxBuffer:8*1024*1024});
 assert.equal(child.status,0,child.stderr||child.error?.message);
 return child.stdout.trim().split('\n').map(JSON.parse).map(x=>x.value);
}
async function node(a){
 let rec;
 try{
  rec=runtime(new InMemoryStore(fixture),a,undefined);
  return {ok:true,value:project(rec.options)};
 }catch(error){return {ok:false,error:error.message};}
 finally{await rec?.close();}
}
function firstDiff(a,b,p='root'){
 if(p.endsWith('.owner')&&typeof a==='string'&&typeof b==='string'&&/^cli-\d+$/.test(a)&&/^cli-\d+$/.test(b))return null;
 if(typeof a!==typeof b||a===null||b===null)return JSON.stringify(a)===JSON.stringify(b)?null:{path:p,a,b};
 if(typeof a!=='object')return Object.is(a,b)?null:{path:p,a,b};
 for(const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()){
  if(!(key in a)||!(key in b))return{path:p+'.'+key,a:a[key],b:b[key]};
  const d=firstDiff(a[key],b[key],p+'.'+key);if(d)return d;
 }return null;
}
test('CLI runtime concrete Planner, adapters, flags and option-port Node/Rust parity',async()=>{
 const expected=[];for(const a of args)expected.push(await node(a));
 const actual=rust(),diffs=[];
 for(let i=0;i<args.length;i++){
  const diff=firstDiff(expected[i],actual[i]);if(diff)diffs.push({case:i,args:args[i],...diff});
 }
 assert.deepEqual(diffs,[],JSON.stringify(diffs,null,2));
 console.log('Verified',args.length,'CLI runtime constructor cases');
});
