// Direct original Node src/cli-task-complete.ts vs native Rust request+HTTP
// transport against an isolated in-process localhost control server.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {runTaskCompleteCommand} from '../../dist/cli-task-complete.js';
const binary='rust/target/debug/relay-rust2-git-delivery-parity';
async function native(args){
 const child=spawn(binary,[],{stdio:['pipe','pipe','pipe']});
 let output='',error='';
 child.stdout.on('data',b=>output+=b);
 child.stderr.on('data',b=>error+=b);
 child.stdin.end(JSON.stringify({op:'runTaskCompleteCommand',args})+'\n');
 const [status]=await once(child,'close');
 assert.equal(status,0,error);
 return JSON.parse(output.trim());
}
async function original(args){
 const prior=console.log;let logged;
 console.log=(text)=>{logged=text;};
 try{
  await runTaskCompleteCommand(args);
  return {ok:true,value:JSON.parse(logged)};
 }catch(error){return {ok:false,error:error.message};}
 finally{console.log=prior;}
}
async function compare(args){
 const node=await original(args);
 const rust=await native(args);
 assert.deepEqual(rust,node,`Node/Rust CLI control ${JSON.stringify(args)}`);
 return rust;
}
test('Node/Rust task.complete uses identical real HTTP request, success, rejection, and no-bypass CLI errors',async()=>{
 const seen=[];let response={code:200,body:JSON.stringify({accepted:true,task:{state:'SUCCEEDED'},stamp:123})};
 const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  seen.push({path:req.url,method:req.method,headers:req.headers,body:JSON.parse(body)});
  res.writeHead(response.code,{'content-type':'application/json'});
  res.end(response.body);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=String(server.address().port);
 const sha='d'.repeat(40);
 const args=['--repo','root','--id','1','--task-id','task-2','--execution-id','ex-1','--commit-sha',sha,'--port',port];
 try{
  for(const extra of [[],['--summary','Task completed and verified'],['--summary','简介 - verified']]){
   const request=[...args,...extra];
   const before=seen.length;
   const result=await compare(request);
   assert.equal(result.ok,true);
   assert.equal(seen.length,before+2);
   const pair=seen.slice(-2);
   assert.equal(pair[0].path,'/api/control');
   assert.equal(pair[0].method,'POST');
   assert.deepEqual(pair[0].body,pair[1].body);
   assert.deepEqual(pair[0].body,{command:'task.complete',jobId:'1',taskId:'task-2',executionId:'ex-1',commitSha:sha,
    repository:'root',summary:extra.length?extra[1]:`Source Task task-2 committed ${sha}`});
  }
  for(const code of [400,409,503]){
   response={code,body:'source task rejected: stale execution'};
   const result=await compare(args);
   assert.equal(result.ok,false);
   assert.match(result.error,/Agents Relay control command failed: source task rejected/);
  }
  const before=seen.length;
  assert.deepEqual(await compare(['--repo','root','--id','1','--port',port]),{
   ok:false,error:'task complete requires --repo, --id, --task-id, --execution-id and --commit-sha'});
  assert.equal(seen.length,before,'invalid CLI must never contact the daemon');
  assert.deepEqual(await compare([...args.slice(0,-2),'--port','invalid']),{
    ok:false,error:'--port must be an integer between 1 and 65535'});
  assert.equal(seen.length,before);
  console.log(`Verified ${seen.length} actual localhost original Node vs native Rust control requests`);
 }finally{server.close();await once(server,'close');}
});
