// Direct original Node CLI support exports versus the native Rust HTTP client.
// Both call the SAME disposable localhost mock service; compare real HTTP
// method, query, POST payload, result, and Graph/transport failure handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {
  relayControlJob,relayControlCommand,relayJobList,
  relayJobStateCommand,relayTaskCommand
} from '../../dist/cli-support.js';

const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const tmp=mkdtempSync(join(tmpdir(),'rust2-cli-support-http-'));
const log=join(tmp,'requests.jsonl');
test.after(()=>rmSync(tmp,{recursive:true,force:true}));
function records(){
 try{return readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}
 catch{return [];}
}
async function node(f,port){
 const args=['--port',String(port),...(f.args??[])];
 try{
  const value=await ({
   relayControlJob:()=>relayControlJob(args,f.id??'3'),
   relayControlCommand:()=>relayControlCommand(args,f.body??{action:'inspect'}),
   relayJobList:()=>relayJobList(args),
   relayJobStateCommand:()=>relayJobStateCommand(args,f.id??'3',f.state??'CANCELLED'),
   relayTaskCommand:()=>relayTaskCommand(args,f.body??{jobId:'3',taskId:'2',action:'retry'})
  })[f.method]();
  return {ok:true,value:JSON.parse(JSON.stringify(value))};
 }catch(error){return {ok:false,error:error.message};}
}
function rust(f,port){
 const args=['--port',String(port),...(f.args??[])];
 const request={
  op:'cliSupportMore',method:f.method,args,jobId:f.id??'3',
  body:f.body??(f.method==='relayTaskCommand'
   ?{jobId:'3',taskId:'2',action:'retry'}:{action:'inspect'}),
  state:f.state??'CANCELLED'
 };
 const command=spawnSync(bin,[],{
  cwd:root,encoding:'utf8',timeout:15000,
  input:JSON.stringify(request)+'\n'
 });
 assert.equal(command.status,0,command.stderr);
 const response=JSON.parse(command.stdout.trim());
 assert.equal(response.ok,true,JSON.stringify(response));
 return response.value;
}
test('original Node/Rust CLI real HTTP methods, query bindings and failure parity',async()=>{
 const fixture=join(root,'rust/tests/fixtures/cli_support_http_fixture.py');
 const child=spawn('python3',['-u',fixture,log],{stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
 try{
  const port=await new Promise((resolvePort,reject)=>{
   let buffer='';
   child.stdout.on('data',chunk=>{
    buffer+=chunk.toString();
    if(buffer.includes('\n'))resolvePort(Number(buffer.split('\n')[0]));
   });
   child.once('exit',code=>reject(Error('fixture server exited '+code+': '+stderr)));
  });
  assert.ok(port>0);
  const cases=[
   ...['3','fail','empty'].map(id=>({method:'relayControlJob',id})),
   {method:'relayControlJob',id:'3',args:['--repo','alpha']},
   {method:'relayControlJob',id:'中文 雪 🍀',args:['--repo','alpha/beta']},
   ...['inspect','fail','empty'].map(action=>({
    method:'relayControlCommand',body:{action,jobId:'3',nested:{emoji:'🍀',number:12}}})),
   ...['','alpha','beta','array','invalid','error'].map(repo=>({
    method:'relayJobList',args:repo?['--repo',repo]:[]})),
   ...['3','fail','empty'].map(id=>({
    method:'relayJobStateCommand',id,state:'CANCELLED'})),
   {method:'relayJobStateCommand',id:'3',state:'ACTIVE',
    args:['--repo','two words']},
   ...['retry','fail','empty'].map(action=>({
    method:'relayTaskCommand',body:{jobId:'3',taskId:'2',action}}))
  ];
  for(let i=0;i<cases.length;i++){
   const f=cases[i],before=records();
   const expected=await node(f,port),middle=records();
   const actual=rust(f,port),after=records();
   assert.deepEqual(actual,expected,'case '+i+': '+JSON.stringify(f));
   assert.deepEqual(after.slice(middle.length),middle.slice(before.length),
    'outbound HTTP mismatch '+i+': '+JSON.stringify(f));
  }
 }finally{
  child.kill('SIGTERM');
  await new Promise(done=>child.once('exit',done));
 }
});
