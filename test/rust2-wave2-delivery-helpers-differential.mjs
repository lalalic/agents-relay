// Node->Rust historical GitHub config and Graph-owned cleanup negative parity.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const {githubAppConfig,githubAuthContext}=await import('../dist/github-auth.js');
const {cleanupMergedJobWorktree}=await import('../dist/job-worktree-cleanup.js');
const rust=resolve('rust/target/debug/relay-rust2-parity');
let count=0;
function run(req){
 const result=spawnSync(rust,[],{input:JSON.stringify({op:'deliveryWave2',...req})+'\n',encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 const out=JSON.parse(result.stdout.trim());
 if(!out.ok)throw new Error(out.error);
 return out.value;
}
function wrap(fn){try{return {ok:true,value:fn()}}catch(e){return {ok:false,error:String(e.message)}}}
for(const args of [[],['--github-app-id','app'],['--github-app-id','app','--github-app-installation-id','installation',
 '--github-app-private-key-file','/tmp/not-real'],['--github-app-id'],
 ['--github-app-id','app','--github-app-id','last'],
 ['--github-app-id','app','--github-app-id','second']]){
 for(const env of [{},{AGENTS_RELAY_GITHUB_APP_ID:'env-id',AGENTS_RELAY_GITHUB_APP_INSTALLATION_ID:'env-install',
    AGENTS_RELAY_GITHUB_APP_PRIVATE_KEY_FILE:'/tmp/fake'},
    {AGENTS_RELAY_GITHUB_APP_ID:'partial'},
    {AGENTS_RELAY_GITHUB_APP_INSTALLATION_ID:'partial'}]){
   const n=wrap(()=>githubAppConfig(args,env));
   const r=wrap(()=>run({case:'githubAppConfig',args,env}));
   assert.deepStrictEqual(r,n,JSON.stringify({args,env}));count++;
 }
}
for(const job of [{id:'42',state:'ACTIVE',tasks:[]},
                  {id:'42',state:'COMPLETED',tasks:[]}]){
 let nError;
 try{await cleanupMergedJobWorktree(job);}catch(e){nError=e.message;}
 const r=run({case:'cleanupMergedJobWorktree',job,resolverPresent:false});
 assert.deepStrictEqual(r,{ok:false,error:nError});count++;
}
for(const job of [{id:'42',state:'ACTIVE',tasks:[]},
                  {id:'42',state:'COMPLETED',tasks:[]}]){
 let nError;
 try{await cleanupMergedJobWorktree(job,()=>'/tmp/fixture-project');}catch(e){nError=e.message;}
 const status=job.state==='ACTIVE'?'Job is not completed':'No durable Job head SHA';
 const r=run({case:'cleanupMergedJobWorktree',job,resolverPresent:true,
   result:{status:'blocked',reason:status}});
 assert.deepStrictEqual(r,{ok:false,error:nError});count++;
}
console.log('PASS Rust2 delivery helper differential '+count);
