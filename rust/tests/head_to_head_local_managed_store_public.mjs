// Independent differential for src/local-managed-store.ts: admission
// validation and real SQLite-backed construction (no GitHub access).
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openLocalManagedStore} from '../../dist/local-managed-store.js';
import {relayStoreDirectory,relayUnifiedStorePath} from '../../dist/relay-store.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');

async function parity(request){
  return await new Promise((resolvePromise,reject)=>{
    const child=spawn(binary,[],{cwd:root});
    let out='',err='';
    child.stdout.on('data',c=>out+=c);
    child.stderr.on('data',c=>err+=c);
    child.on('error',reject);
    child.on('close',code=>{
      if(code!==0)return reject(new Error(err||`parity exited ${code}`));
      try{
        const parsed=JSON.parse(out.trim());
        if(!parsed.ok)throw new Error('parity error: '+parsed.error);
        resolvePromise(parsed.value);
      }catch(e){reject(new Error(`parity JSON: ${e.message}: ${out.slice(0,300)}`));}
    });
    child.stdin.end(JSON.stringify(request)+'\n');
  });
}
test('original Node/Rust local-managed-store differential',async()=>{
  const nodeRoot=mkdtempSync(join(tmpdir(),'rust2-lms-node-'));
  const rustRoot=mkdtempSync(join(tmpdir(),'rust2-lms-rust-'));
  const cases=[];
  const repoShapes=['owner/repo','valid-repo_1.x','..','.','a b','','a/b',
    'UPPER.case-2','x'.repeat(120),'中文'];
  for(const repository of repoShapes){
    cases.push({repository,prNumber:7,jobId:undefined});
  }
  const prShapes=[{prNumber:1},{prNumber:0,jobId:'job-17'},{prNumber:0},
    {prNumber:-3},{prNumber:1.5},{prNumber:7}];
  for(const shape of prShapes)
    cases.push({repository:'owner/repo',...shape});
  // noGitHub with pr 0 + jobId
  cases.push({repository:'owner/repo',prNumber:0,jobId:'job-18',noGitHub:true});
  cases.push({repository:'owner/repo',prNumber:5,noGitHub:true});

  const expected=[];
  for(const fixture of cases){
    // relayUnifiedStorePath places relay.sqlite in dirname(directory):
    // give each case its own isolated parent so the DB lands inside it.
    const scopeRoot=mkdtempSync(join(tmpdir(),'rust2-lms-np-'));
    const directory=join(scopeRoot,'jobs','a');
    try{
      const opened=openLocalManagedStore(fixture.repository,fixture.prNumber,
        {directory,noGitHub:true,jobId:fixture.jobId});
      // Authority usability over real SQLite: create job, save task, load.
      const jobId=opened.store.saveJob?
        (await opened.store.saveJob({id:'scope-check',repository:'owner/repo',
          state:'QUEUED',tasks:[],plans:[]})):'';
      const tasks=opened.store.saveTask?
        (await opened.store.saveTask({id:'t1',jobId:'scope-check',state:'QUEUED',
          title:'probe',agentName:'worker'})):'';
      const job=await opened.store.load('scope-check');
      const visible=(job?.tasks??[]).some(t=>t.id==='t1');
      expected.push({ok:true,createJob:true,saveTask:true,taskVisible:visible});
    }catch(error){
      let message=error?.message??String(error);
      // rusqlite embeds the absolute path; node:sqlite does not. Compare the
      // io error class only.
      message=message.replace(/: \/.*$/, '');
      expected.push({ok:false,error:message});
    }
  }
  const results=[];
  for(const fixture of cases){
    const scopeRoot=mkdtempSync(join(tmpdir(),'rust2-lms-rp-'));
    const got=await parity({op:'certLocalManagedStore',method:'open',
      repository:fixture.repository,prNumber:fixture.prNumber,
      jobId:fixture.jobId,noGitHub:fixture.noGitHub??true,
      directory:join(scopeRoot,'jobs','a')});
    if(got.ok===false)
      got.error=got.error.replace(/: \/.*$/, '');
    results.push(got);
  }
  const failures=[];
  for(let i=0;i<cases.length;i++){
    const want=expected[i],got=results[i];
    if(want.ok!==got.ok){failures.push([i,want,got]);continue;}
    if(want.ok===false&&want.error!==got.error){failures.push([i,want,got]);continue;}
    if(want.ok===true&&(want.createJob!==got.createJob
      ||want.saveTask!==got.saveTask
      ||want.taskVisible!==got.taskVisible))failures.push([i,want,got]);
  }
  for(const [i,want,got] of failures.slice(0,6))
    console.log('LMS_DIFF',i,JSON.stringify(want).slice(0,200),
      JSON.stringify(got).slice(0,200));
  assert.deepEqual(failures.map(f=>f[0]),[],
    `${failures.length} local-managed-store mismatches`);
  console.log('Verified',cases.length,'original Node/Rust local-managed-store cases');
});
