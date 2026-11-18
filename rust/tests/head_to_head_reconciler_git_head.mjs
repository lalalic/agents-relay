import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Reconciler} from '../../dist/reconciler.js';
import {InMemoryStore} from '../../dist/store.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const git=(repo,...args)=>{
 const result=spawnSync('git',['-C',repo,...args],{encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stderr);return result.stdout.trim();
};
async function nodeHead(entry){
 const store=new InMemoryStore();
 const options={owner:'fixture',noGitHub:true,
  ...(entry.useGit!==false?{cwdForJob:async()=>entry.project}:{})};
 const reconciler=new Reconciler(store,options);
 try{return {head:await reconciler.currentHeadSha(entry.job)};}
 finally{await reconciler.close();}
}
test('Reconciler.currentHeadSha uses exact real Git HEAD/sourceRef with local fallback, Node/Rust',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rust2-local-git-head-'));
 try{
  const repo=join(dir,'project');await mkdir(repo);
  git(repo,'init','--quiet');
  const commit=(message)=>git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
   'commit','--allow-empty','--quiet','-m',message);
  commit('first');const first=git(repo,'rev-parse','HEAD');
  git(repo,'branch','feature');commit('second');
  const second=git(repo,'rev-parse','HEAD');
  const unborn=join(dir,'unborn');await mkdir(unborn);git(unborn,'init','--quiet');
  const notRepo=join(dir,'not-repo');await mkdir(notRepo);
  const cache='cached-old-sha';
  const cases=[
   {project:repo,job:{id:'1',headSha:cache}},
   {project:repo,job:{id:'1',headSha:cache,localMerge:{sourceRef:'refs/heads/feature'}}},
   {project:repo,job:{id:'1',headSha:cache,localMerge:{sourceRef:'refs/heads/missing'}}},
   {project:repo,job:{id:'1',headSha:cache,localMerge:{sourceRef:'refs/heads/../bad'}}},
   {project:repo,job:{id:'1',headSha:cache,localMerge:{sourceRef:''}}},
   {project:notRepo,job:{id:'1',headSha:cache}},
   {project:notRepo,job:{id:'1',review:{headSha:'review-cache'}}},
   {project:notRepo,job:{id:'1'}},
   {project:unborn,job:{id:'1',headSha:cache}},
   {project:repo,job:{id:'1',headSha:cache},useGit:false},
   {project:notRepo,job:{id:'1',headSha:cache,review:{headSha:'review-cache'}}},
  ];
  const child=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:120000,
   input:cases.map(entry=>JSON.stringify({op:'apiReconcilerCurrentGitHead',...entry})).join('\n')+'\n'});
  assert.equal(child.status,0,child.stderr);
  const native=child.stdout.trim().split('\n').map(line=>JSON.parse(line).value);
  assert.equal(native.length,cases.length);
  const comparisons=[];
  for(const [index,entry] of cases.entries()){
   const node=await nodeHead(entry);assert.deepEqual(native[index],node,`case ${index}`);
   comparisons.push(node.head);
  }
  assert.equal(comparisons[0],second);
  assert.equal(comparisons[1],first);
  assert.equal(comparisons[2],cache);
  assert.equal(comparisons[6],'review-cache');
  assert.equal(comparisons[7],null);
  console.log('Verified',cases.length,'original Node/Rust real local Git HEAD/ref/fallback cases');
 }finally{await rm(dir,{recursive:true,force:true});}
});
