// Direct Node/Rust GitHub identity probes use monkey-patched clients only.
// No gh CLI, actual credentials, providers or network calls.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const {githubAuthContext,githubAppConfig}=await import('../dist/github-auth.js');
const {GhApiClient}=await import('../dist/github-client.js');
const bin=resolve('rust/target/debug/relay-rust2-parity');
const dir=mkdtempSync(join(tmpdir(),'rust2-wave3-auth-'));
const keyfile=join(dir,'mock-key.pem');writeFileSync(keyfile,'NOT A REAL KEY');
let comparisons=0;
const rust=req=>{
 const p=spawnSync(bin,[],{input:JSON.stringify({op:'deliveryWave2',case:'githubAuthContext',...req})+'\n',
  encoding:'utf8',timeout:30000,env:{...process.env,AGENTS_RELAY_STORE_DIR:join(dir,'store')}});
 assert.equal(p.status,0,p.stderr);
 const value=JSON.parse(p.stdout);
 if(!value.ok)throw new Error(value.error);
 return value.value;
};
let rng=0x41eed111;
const random=()=>{rng^=rng<<13;rng^=rng>>>17;rng^=rng<<5;return rng>>>0;};
const alpha=['','alice','bob','Alice',' alice ','user-42','汉字','eve'];
try {
 for(let i=0;i<100;i++){
   const hasApp=(random()%2)===0;
   const probeLogin=(random()%2)===0;
   const args=hasApp?['--github-app-id','app','--github-app-installation-id','7',
     '--github-app-private-key-file',keyfile]:[];
   const trusted=Array.from({length:3},()=>alpha[random()%alpha.length]).join(',');
   const env={AGENTS_RELAY_TRUSTED_AUTHORS:trusted};
   const login=alpha[random()%alpha.length];
   const localLogin=alpha[random()%alpha.length];
   const loginError=(random()%11)===0;
   const localError=(random()%13)===0;
   const req={args,env,probeLogin,login,localLogin,loginError,localError};
   const calls=[];
   GhApiClient.prototype.currentLogin=async function(){
     calls.push('current_login');
     if(loginError)throw Error('fixture current login failed');
     return login;
   };
   GhApiClient.prototype.localLogin=async function(){
     calls.push('local_login');
     if(localError)throw Error('fixture local login failed');
     return localLogin;
   };
   const wrap=async work=>{try{return {ok:true,value:await work()}}catch(e){return {ok:false,error:e.message}}};
   const node=await wrap(async()=>{
     const ctx=await githubAuthContext(args,env,probeLogin);
     return {clientAppAuth:ctx.appAuth,appAuth:ctx.appAuth,
       trustedAuthors:[...ctx.trustedAuthors].sort(),calls:['make_client',...calls]};
   });
   const native=await wrap(()=>rust(req));
   assert.deepEqual(native,node,JSON.stringify(req));
   comparisons++;
 }
 for(const args of [
   ['--github-app-id','app'],['--github-app-id','app','--github-app-installation-id','7',
   '--github-app-private-key-file',join(dir,'missing')]]) {
   const req={args,env:{},probeLogin:false};
   const wrap=async f=>{try{return {ok:true,value:await f()}}catch(e){return {ok:false,error:e.message}}};
   const n=await wrap(async()=>githubAuthContext(args,{},false));
   const r=await wrap(()=>rust(req));
   assert.equal(r.ok,n.ok);
   if(!r.ok && args.length===2)assert.equal(r.error,n.error);
   comparisons++;
 }
 console.log('PASS Rust2 Wave3 GitHub auth randomized Node/Rust mock identity differential '+comparisons);
}finally{rmSync(dir,{recursive:true,force:true});}
