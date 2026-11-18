import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {connect} from 'node:net';
import {createService,startService} from '../../dist/cli.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const at='2026-11-18T09:00:00.000Z';
const cases=[
 {state:'COMPLETED',kind:'create'},
 {state:'COMPLETED',kind:'start'},
 {state:'CANCELLED',kind:'create'},
 {state:'CANCELLED',kind:'start'},
 {state:'ACTIVE',pause:{reason:'manual'},kind:'create'},
 {state:'ACTIVE',pause:{reason:'manual'},kind:'start'},
];
function disconnected(port){
 return new Promise(resolve=>{
  const client=connect({host:'127.0.0.1',port});
  let finished=false;const done=value=>{if(finished)return;finished=true;client.destroy();resolve(value);};
  client.once('connect',()=>done(false));client.once('error',()=>done(true));
  client.setTimeout(1000,()=>done(false));
 });
}
function rust(fixtures){
 const child=spawnSync(bin,[],{cwd:root,encoding:'utf8',timeout:120000,
  input:fixtures.map(f=>JSON.stringify({op:'apiCliService',root,...f})).join('\n')+'\n',
  maxBuffer:8*1024*1024});
 assert.equal(child.status,0,child.stderr||child.error?.message);
 return child.stdout.trim().split('\n').map(JSON.parse).map(x=>x.value);
}
async function node(f){
 const service=await (f.kind==='start'?startService:createService)(f.args);
 const port=service.dashboardServer.address().port;
 const response=await fetch(`http://127.0.0.1:${port}/`,{headers:{Connection:'close'}});
 const html=await response.text();
 const before=service.watchdogCleared;
 await service.stop();const after=service.watchdogCleared;
 await service.stop();
 return {code:response.status,contentType:response.headers.get('content-type'),
  htmlLength:html.length,id:service.job.id,clearedBefore:before,clearedAfter:after,
  closed:await disconnected(port),effects:0};
}
test('CLI createService/startService real loopback and stop direct Node/Rust parity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rust2-node-service-h2h-'));
 try{
  const fixtures=[];
  for(let i=0;i<cases.length;i++){
   const c=cases[i],job={id:`fixture-${i}`,title:'Local service',repository:'fixture',
    projectRoot:dir,prNumber:0,objective:'No external effect',state:c.state,
    createdAt:at,updatedAt:at,tasks:[],plans:[],reviewEnabled:false,
    headSha:'unchanged-sha',pause:c.pause??null};
   const file=join(dir,`job-${i}.json`);await writeFile(file,JSON.stringify(job));
   const args=['--file',file,'--port','0','--interval','120000','--events','none','--owner','fixture'];
   fixtures.push({...c,job,args});
  }
  const actual=rust(fixtures),expected=[];
  for(const f of fixtures)expected.push(await node(f));
  const differences=[];
  for(let i=0;i<cases.length;i++){
   for(const field of ['code','contentType','id','clearedBefore','clearedAfter','closed','effects']){
    if(expected[i][field]!==actual[i][field])differences.push({case:i,field,node:expected[i][field],rust:actual[i][field]});
   }
   assert.ok(actual[i].htmlLength>1000,'Native Dashboard must serve the real PWA HTML');
  }
  assert.deepEqual(differences,[],JSON.stringify(differences,null,2));
  console.log('Verified',cases.length,'Node/Rust real HTTP service lifecycles');
 }finally{await rm(dir,{recursive:true,force:true});}
});
