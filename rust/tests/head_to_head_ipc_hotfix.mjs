// Direct Node/Rust E2E differential for src/troubleshooter-qa-api.ts and src/webhelm-daemon-client.ts, using isolated temporary files/sockets.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer as createHttpServer,request as httpRequest} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {webHelmDaemonRequest} from '../../dist/webhelm-daemon-client.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const bin=resolve(root,'rust/target/debug/relay-rust2-parity');
function rustSync(request){
 const out=spawnSync(bin,[],{input:JSON.stringify(request)+'\n',encoding:'utf8',maxBuffer:12*1024*1024,timeout:18000});
 assert.equal(out.status,0,out.stderr);
 return JSON.parse(out.stdout.trim());
}
async function rustAsync(request){
 return await new Promise((resolve,reject)=>{
  const child=spawn(bin,[],{stdio:['pipe','pipe','pipe']});let out='',err='';
  child.stdout.setEncoding('utf8');child.stdout.on('data',s=>out+=s);
  child.stderr.setEncoding('utf8');child.stderr.on('data',s=>err+=s);
  child.on('error',reject);child.on('close',code=>{
   if(code!==0)return reject(Error('Rust exited '+code+' '+err));
   try{resolve(JSON.parse(out.trim()))}catch(e){reject(Error('Rust invalid JSON '+e.message+' '+out.slice(0,200)))}
  });
  child.stdin.end(JSON.stringify(request)+'\n');
 });
}
function normalizedResponse(status,headers,body){
 const keep={};for(const key of ['content-type','cache-control','allow'])if(headers[key]!==undefined)keep[key]=headers[key];
 return {status,headers:keep,body};
}
async function nodeHttp(server,method,body,contentType){
 const addr=server.address();
 return await new Promise((resolve,reject)=>{
  const req=httpRequest({hostname:'127.0.0.1',port:addr.port,method,path:'/',headers:contentType===undefined?{}:{'content-type':contentType}},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(normalizedResponse(res.statusCode,res.headers,Buffer.concat(chunks).toString('utf8'))));
  });req.on('error',reject);req.end(body);
 });
}

test('QA GET/PUT over a real ephemeral Node HTTP listener matches Rust with independent files',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rust2-qa-node-http-'));
 const nodeDist=join(dir,'dist');const nodeSkills=join(dir,'skills','agents-relay');mkdirSync(nodeDist,{recursive:true});mkdirSync(nodeSkills,{recursive:true});
 const nodeFile=join(nodeSkills,'troubleshooter-qa.md'),rustFile=join(dir,'rust-qa.md');
 writeFileSync(join(nodeDist,'qa.mjs'),readFileSync(resolve(root,'dist/troubleshooter-qa-api.js')));
 const {handleTroubleshooterQa}=await import(pathToFileURL(join(nodeDist,'qa.mjs')).href);
 const server=createHttpServer((req,res)=>handleTroubleshooterQa(req,res));
 await new Promise((yes,no)=>server.once('error',no).listen(0,'127.0.0.1',yes));
 let verified=0;
 try{
  const fixtures=[
   {method:'GET',initial:'Current content'},
   {method:'POST',initial:'Current content'},
   {method:'PUT',initial:'Current content',contentType:'text/plain',body:'{}'},
   {method:'PUT',initial:'Current content',contentType:'application/json',body:'{}'},
   {method:'PUT',initial:'Current content',contentType:'application/json',body:JSON.stringify({text:'next',hash:'stale'})},
   {method:'PUT',initial:'Current content',contentType:'application/json',body:JSON.stringify({text:'中文🙂\nnew content',hash:'CURRENT_HASH'})},
   {method:'PUT',initial:'Current content',contentType:'application/json;charset=utf-8',body:JSON.stringify({text:'x'.repeat(135000),hash:'CURRENT_HASH'})},
   {method:'PUT',initial:'Current content',contentType:'application/json',body:'{invalid'},
   {method:'GET',initial:'🙂\n中文\tcontent'},
   {method:'GET',initial:Buffer.from([0xff,0xfe,0x63,0x64])},
   {method:'PUT',initial:'Current content',contentType:'application/json',body:JSON.stringify({text:'🙂'.repeat(32770),hash:'CURRENT_HASH'})},
   {method:'DELETE',initial:'Current content'},
  ];
  for(const fixture of fixtures){
   writeFileSync(nodeFile,fixture.initial);writeFileSync(rustFile,fixture.initial);
   let body=fixture.body;
   if(typeof body==='string' && body.includes('CURRENT_HASH')){
    const current=JSON.parse((await nodeHttp(server,'GET')).body);
    body=body.replace('CURRENT_HASH',current.hash);
   }
   const expected=await nodeHttp(server,fixture.method,body,fixture.contentType);
   const actual=rustSync({op:'troubleshooterQaHandle',path:rustFile,method:fixture.method,contentType:fixture.contentType,body:body??''});
   assert.equal(actual.ok,true,actual.error);
   assert.equal(actual.value.status,expected.status);
   assert.deepEqual(actual.value.headers,expected.headers,`Headers mismatch in ${fixture.method}`);
   if(expected.status!==500) assert.equal(actual.value.body,expected.body,`Body mismatch in ${fixture.method}`);
   else assert(actual.value.body.length>0);
   assert.deepEqual(readFileSync(rustFile),readFileSync(nodeFile),`File write mismatch in ${fixture.method}`);
   verified++;
  }
  // GET of an absent file must fail closed with 500, never fabricate Q&A text.
  rmSync(nodeFile);rmSync(rustFile);
  const expected=await nodeHttp(server,'GET');
  const actual=rustSync({op:'troubleshooterQaHandle',path:rustFile,method:'GET'});
  assert.equal(expected.status,500);assert.equal(actual.value.status,500);verified++;
  console.log(`Verified ${verified} QA real HTTP vs Rust isolated file requests`);
 }finally{
  await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});
 }
});

async function localSocketScenario(response, payload, options={}){
 const dir=mkdtempSync(join(tmpdir(),'rust2-webhelm-socket-'));
 const sock=join(dir,'socket.sock');
 const timeoutMs=options.timeoutMs??200;
 let captured;
 async function runServer(run){
  const server=createNetServer(socket=>{
   socket.setEncoding('utf8');let buffer='';
   socket.on('data',chunk=>{buffer+=chunk;const index=buffer.indexOf('\n');if(index<0)return;
    try{captured=JSON.parse(buffer.slice(0,index));}catch{}
    if(response==='close'){socket.end();return;}
    if(response==='hang'){return;}
    const text=typeof response==='string'?response:JSON.stringify(response)+'\n';
    socket.end(text);
   });
  });
  await new Promise((yes,no)=>server.once('error',no).listen(sock,yes));
  try{return await run()}finally{
   await new Promise(resolve=>server.close(resolve));
   if(existsSync(sock))rmSync(sock,{force:true});
  }
 }
 try{
  const node=await runServer(async()=>{
   const old=process.env.WEBHELM_SOCKET;process.env.WEBHELM_SOCKET=sock;
   const controller=new AbortController();
   if(options.aborted)controller.abort();
   const timer=options.abortAfterMs!==undefined?setTimeout(()=>controller.abort(),options.abortAfterMs):undefined;
   try{return {ok:true,value:await webHelmDaemonRequest(payload,{timeoutMs,signal:controller.signal})};}
   catch(error){return {ok:false,error:error.message};}
   finally{
    if(timer)clearTimeout(timer);
    if(old===undefined)delete process.env.WEBHELM_SOCKET;else process.env.WEBHELM_SOCKET=old;
   }
  });
  const nodeRequest=captured;
  captured=undefined;
  const rust=await runServer(()=>rustAsync({op:'webHelmRequest',socket:sock,timeoutMs,payload,
    ...(options.aborted?{aborted:true}:{}),
    ...(options.abortAfterMs!==undefined?{abortAfterMs:options.abortAfterMs}:{}),
  }));
  assert.deepEqual(captured,nodeRequest,'Node and Rust must send the exact same socket request');
  return {node,rust};
 }finally{rmSync(dir,{recursive:true,force:true});}
}

test('WebHelm real Unix socket transport, errors and timeouts match Node',async()=>{
 const payload={op:'capacity',name:'test',pool_size:2,config:{model:'中文🙂'}};
 const responses=[
  {ok:true,result:{count:2}},
  {ok:false},
  {error:'denied'},
  {error:42},
  {error:false,ok:true},
  {error:[],ok:true},
  {error:{problem:'bad'},ok:true},
  {ok:true,text:'中文🙂'},
  'null\n',
  'close',
  'hang',
  '{invalid\n',
 ];
 let exact=0,semantic=0;
 for(const response of responses){
  const {node,rust}=await localSocketScenario(response,payload);
  if(typeof response==='string' && response.startsWith('{invalid')){
   assert.equal(node.ok,false);assert.equal(rust.ok,false);semantic++;
  }else{
   assert.deepEqual(rust,node,`Socket response mismatch: ${JSON.stringify(response)}`);exact++;
  }
 }
 for(const [response,options] of [
  [{ok:true},{aborted:true}],
  ['hang',{abortAfterMs:60,timeoutMs:1000}],
  [{ok:true,message:'🙂'.repeat(510000)},{timeoutMs:10000}],
  ['{\"ok\":true,\"message\":\"'+ 'x'.repeat(2000100) +'\"}\n',{timeoutMs:10000}],
 ]){
  const {node,rust}=await localSocketScenario(response,payload,options);
  const brief=({ok,value,error})=>ok?{ok,digest:(awaitDigest(value))}:{ok,error};
  function awaitDigest(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex')}
  assert.deepEqual(brief(rust),brief(node),`WebHelm advanced frame mismatch: ${JSON.stringify(options)}`);
  exact++;
 }
 console.log(`Verified ${exact} exact WebHelm Unix socket requests and ${semantic} invalid-frame rejection`);
});
