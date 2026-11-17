// Deterministic local child-process fixtures and stub HTTP. Never launches
// codex, invokes external providers, or connects to a live endpoint.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const {CommandContinuation,CodexThreadContinuation,WebhookContinuation}=await import('../dist/continuation.js');
const rust=resolve('rust/target/debug/relay-rust2-parity');
let cases=0;
function run(req){
 const p=spawnSync(rust,[],{input:JSON.stringify({op:'deliveryWave2',case:'continuationScenario',...req})+'\n',encoding:'utf8'});
 assert.equal(p.status,0,p.stderr);
 const value=JSON.parse(p.stdout.trim());
 if(!value.ok)throw Error(value.error);
 return value.value;
}
async function node(req) {
 let adapter;
 if(req.adapterKind==='command')adapter=new CommandContinuation();
 else if(req.adapterKind==='codex-thread')adapter=new CodexThreadContinuation('/usr/bin/true');
 else adapter=new WebhookContinuation();
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async (url,init)=>{
   assert.equal(url,'https://offline.test/callback');
   assert.equal(init.method,'POST');
   assert.equal(init.headers['content-type'],'application/json');
   assert.deepStrictEqual(JSON.parse(init.body),{input:'fixture-input'});
   return new Response(null,{status:req.httpStatus});
 };
 try{
   await adapter.continue(req.input,{kind:req.continuationKind,target:req.target});
   return {ok:true};
 }catch(e){return {ok:false,error:e.message};}
 finally{globalThis.fetch=originalFetch;}
}
for(const req of [
 {adapterKind:'command',continuationKind:'command',target:'/usr/bin/true',status:0},
 {adapterKind:'command',continuationKind:'command',target:'/usr/bin/false',status:1},
 {adapterKind:'codex-thread',continuationKind:'codex-thread',target:'fixture-thread',status:0},
 {adapterKind:'codex-thread',continuationKind:'command',target:'fixture-thread',status:0},
 {adapterKind:'command',continuationKind:'codex-thread',target:'fixture-thread',status:0},
 {adapterKind:'webhook',continuationKind:'webhook',target:'https://offline.test/callback',httpStatus:200},
 {adapterKind:'webhook',continuationKind:'webhook',target:'https://offline.test/callback',httpStatus:503},
 {adapterKind:'webhook',continuationKind:'command',target:'https://offline.test/callback',httpStatus:503},
 ]) {
 req.input='fixture-input';
 const r=run(req);
 const n=await node(req);
 assert.deepStrictEqual({ok:r.ok,...(!r.ok?{error:r.error}:{})},n,JSON.stringify(req));
 if(req.adapterKind==='command'&&req.continuationKind==='command'){
   assert.deepStrictEqual(r.calls,[{command:req.target,args:['fixture-input'],invocation:'continuation.command'}]);
 }
 if(req.adapterKind==='codex-thread'&&req.continuationKind==='codex-thread'){
   assert.deepStrictEqual(r.calls,[{command:'/usr/bin/true',args:['exec','resume',req.target,'fixture-input'],invocation:'continuation.codex'}]);
 }
 cases++;
}
console.log('PASS Rust2 worker C continuation differential '+cases);
