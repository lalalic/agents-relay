// Direct Node/Rust differential for src/cli-projection.ts: full validation, local-only HTTP control, printed results and help text.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync,spawn} from 'node:child_process';import http from 'node:http';import {once} from 'node:events';
import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {runProjectionCommand,projectionHelp} from '../../dist/cli-projection.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');
const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(build.status,0,build.stderr);
function rustSync(req){const r=spawnSync(bin,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:10000});assert.equal(r.status,0,`${r.error}: ${r.stderr}`);return JSON.parse(r.stdout.trim());}
function rustAsync(req){return new Promise((resolve,reject)=>{
 const p=spawn(bin,[],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
 p.stdout.setEncoding('utf8');p.stderr.setEncoding('utf8');p.stdout.on('data',data=>stdout+=data);p.stderr.on('data',data=>stderr+=data);
 p.on('error',reject);p.on('close',code=>{if(code!==0)return reject(new Error(`Rust ${code}: ${stderr}`));try{resolve(JSON.parse(stdout.trim()))}catch(error){reject(new Error(`JSON: ${stdout}: ${error}`))}});
 p.stdin.end(JSON.stringify(req)+'\n');
})}
async function node(req){if(req.op==='projectionHelp')return {ok:true,value:projectionHelp(req.action)};
 const logs=[];const oldLog=console.log;console.log=(...parts)=>logs.push(parts.join(' '));
 try{await runProjectionCommand(req.action,req.args);return {ok:true,value:logs.at(-1)}}
 catch(error){return {ok:false,error:error.message}}
 finally{console.log=oldLog}
}
let seed=0x79911955;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};const pick=xs=>xs[rand(xs.length)];
test('pure help and invalid request validation agree byte-for-byte with original Node CLI',async()=>{
 let count=0;
 for(const action of [undefined,'','resolve','list','conflicts','unsupported','RESOLVE',null]){
  const req={op:'projectionHelp',action};assert.deepEqual(rustSync(req),await node(req));count++;
 }
 const samples=[
  {action:'resolve',args:[]},
  {action:'resolve',args:['--id','42']},
  {action:'resolve',args:['--id','42','--projection-id','0']},
  {action:'resolve',args:['--id','42','--projection-id','-1']},
  {action:'resolve',args:['--id','42','--projection-id','1.5']},
  {action:'resolve',args:['--id','42','--projection-id','abc']},
  {action:'resolve',args:['--id','42','--projection-id','2','--action','delete']},
  {action:'unknown',args:['--id','42']},
  {action:'',args:['--id','42']},
 ];
 for(let i=0;i<490;i++){
  const args=pick([[],['--id',''],['--repo','local'],['--id','42'],['--id','42','--projection-id',pick(['-1','0','3.5','NaN','Infinity','foo'])],
    ['--id','42','--projection-id','8','--action',pick(['invalid','reset','merge','none'])],
    ['--id','42','--projection-id','invalid','--action','requeue'],['--id','42','--projection-id','7','--action','invalid']]);
  samples.push({action:pick(['resolve','cancel','unknown','', 'update']),args});
 }
 for(const item of samples){
  const req={op:'runProjectionCommand',...item};
  const expected=await node(req),actual=rustSync(req);
  assert.deepEqual(actual,expected,`invalid CLI fixture ${count}: ${JSON.stringify(req)}`);count++;
 }
 console.log(`Verified ${count} help and reject-before-HTTP Node/Rust Projection CLI fixtures`);
});

test('Projection CLI POSTs to an isolated localhost control API with exact command bodies and output',async()=>{
 let status=200,payload={ok:true,jobId:'42',rows:[1,2]},rawBody=null,captured=[];
 const server=http.createServer(async(req,res)=>{
  let data='';for await(const chunk of req)data+=chunk.toString('utf8');
  try{captured.push({url:req.url,method:req.method,body:JSON.parse(data),contentType:req.headers['content-type']});}
  catch{captured.push({url:req.url,method:req.method,body:data});}
  const reply=rawBody??JSON.stringify(payload);
  res.writeHead(status,{'content-type':'application/json'});res.end(reply);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=String(server.address().port);
 let checked=0;
 try{
  const cases=[];
  const ids=['1','42','test-id','🐼'];
  for(let i=0;i<240;i++){
   const action=pick(['conflicts','list','resolve']);
   const projectionId=pick(['1','2','42','0x10','0b10','0o10','3e0',' 12 ','1.0']);
   const operation=pick(['requeue','discard-local','discard_local']);
   const args=['--port',port,'--id',pick(ids)];
   if(action==='resolve')args.push('--projection-id',projectionId,'--action',operation);
   if(rand(2)===0)args.push('--note',pick(['', 'Approved by human','中文备注','Resolution deferred']));
   if(rand(2)===0)args.push('--host','127.0.0.1');
   if(rand(2)===0)args.push('--repo','local');
   cases.push({action,args});
  }
  for(const item of cases){
   captured=[];status=200;rawBody=null;
   payload=pick([{ok:true,jobId:'42',rows:[1,2]},{status:'ok',items:[]},{result:{summary:'done'},count:2}, {answer:'resolved'}]);
   const req={op:'runProjectionCommand',...item};
   const expected=await node(req);
   const expectedHttp=captured[0];
   captured=[];
   const actual=await rustAsync(req);
   const actualHttp=captured[0];
   assert.deepEqual(actual,expected,`Projection response ${checked} ${JSON.stringify(req).slice(0,300)}`);
   assert.deepEqual(actualHttp,expectedHttp,`Projection command ${checked}`);
   if(item.action==='resolve')assert.equal(actualHttp.body.command,'projection.resolve');
   checked++;
  }
  for(const code of [400,404,409,500,503]){
   for(const raw of ['failed','']){
    status=code;rawBody=raw;
    const req={op:'runProjectionCommand',action:'conflicts',args:['--port',port,'--id','42']};
    const expected=await node(req),actual=await rustAsync(req);
    assert.deepEqual(actual,expected,`Projection HTTP failure ${code}: ${JSON.stringify(raw)}`);checked++;
   }
  }
  console.log(`Verified ${checked} real localhost Projection CLI requests/responses, including HTTP errors`);
 }finally{
  server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 }
});
