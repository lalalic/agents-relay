// Offline mocked OAuth transport; no cloud endpoints, tokens or credentials.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const {zWorkerMcpEndpoint,issueZWorkerCredential}=await import('../dist/z-oauth.js');
const binary=resolve('rust/target/debug/relay-rust2-parity');
let passes=0;
function rust(req){
 const p=spawnSync(binary,[],{input:JSON.stringify({op:'deliveryWave2',...req})+'\n',encoding:'utf8',timeout:30000});
 assert.equal(p.status,0,p.stderr);
 const result=JSON.parse(p.stdout.trim());
 if(!result.ok)throw new Error(result.error);
 return result.value;
}
function wrap(fn){try{return {ok:true,value:fn()}}catch(e){return {ok:false,error:e.message}}}
async function nodeScenario(stage){
 let calls=0,state='';
 const origin='https://oauth.example.test';
 const fetcher=async (url,init)=>{
   calls++;
   const parsed=new URL(url),path=parsed.pathname;
   if(path==='/register'){
     if(stage==='register-fail')return new Response('{}',{status:403});
     return new Response(stage==='missing-client'?'{}':'{"client_id":"fixture-client"}',{status:201});
   }
   if(path==='/authorize'&&init.method==='GET'){
     state=parsed.searchParams.get('state');
     return new Response(stage==='missing-rid'?'<html/>':'<input name="rid" value="fixture_rid">',
       {status:stage==='page-fail'?500:200});
   }
   if(path==='/authorize'&&init.method==='POST'){
     if(stage==='consent-fail')return new Response(null,{status:401});
     if(stage==='missing-location')return new Response(null,{status:302});
     const st=stage==='callback-mismatch'?state+'wrong':state;
     const callback='http://127.0.0.1:8765/agents-relay/oauth/callback?'+
       (stage==='missing-code'?'':'code=fixture-code&')+
       'state='+encodeURIComponent(st)+'&iss='+encodeURIComponent(origin);
     return new Response(null,{status:302,headers:{location:callback}});
   }
   if(path==='/token'){
     if(stage==='token-fail')return new Response(null,{status:503});
     if(stage==='invalid-token')return new Response('{"access_token":"x","expires_in":15}',{status:200});
     return new Response('{"access_token":"fixture-access","expires_in":3600,"refresh_token":"fixture-refresh"}',{status:200});
   }
   if(path==='/revoke')return new Response(null,{status:stage==='revoke-fail'?403:200});
   throw Error('unexpected mock OAuth '+init.method+' '+path);
 };
 try {
   const token=await issueZWorkerCredential({origin,operatorToken:stage==='missing-token'?'':'fixture',fetcher});
   return {ok:true,token,calls};
 }catch(error){return {ok:false,error:error.message,calls};}
}
for(const origin of ['https://oauth.example.test','https://oauth.example.test/',
  'https://127.0.0.1:8080','https://HOST:65536','http://bad',
  'https://user:pass@host','https://host/path','https://example.test?abc']) {
 const n=wrap(()=>zWorkerMcpEndpoint(origin));
 const r=wrap(()=>rust({case:'zOAuthEndpoint',origin}));
 assert.deepStrictEqual(r,n,origin);passes++;
}
for(const stage of ['ok','missing-token','register-fail','missing-client','page-fail',
 'missing-rid','consent-fail','missing-location','callback-mismatch','missing-code',
 'token-fail','invalid-token','revoke-fail']) {
 const n=await nodeScenario(stage);
 const r=rust({case:'zOAuthScenario',stage,origin:'https://oauth.example.test',
   operatorToken:stage==='missing-token'?'':'fixture'});
 assert.deepStrictEqual(r,n,JSON.stringify({stage,r,n}));
 passes++;
}
console.log('PASS Rust2 worker C mocked OAuth differential assertions='+passes);
