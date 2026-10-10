import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {deliverLocalMerge} from '../dist/local-git-merge.js';
import {projectAuthoritativeLocalMerge} from '../dist/local-merge-projection.js';

const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'relay-local-projection-'));
 const remote=join(root,'remote.git'); const repo=join(root,'repo'); const other=join(root,'other');
 execFileSync('git',['init','--bare',remote]); execFileSync('git',['clone',remote,repo]);
 git(repo,'config','user.name','Relay Tests'); git(repo,'config','user.email','relay@example.test');
 git(repo,'checkout','-b','main'); writeFileSync(join(repo,'base'),'base'); git(repo,'add','base'); git(repo,'commit','-m','base'); git(repo,'push','-u','origin','main');
 git(repo,'checkout','-b','feature'); writeFileSync(join(repo,'feature'),'feature'); git(repo,'add','feature'); git(repo,'commit','-m','feature');
 const sourceSha=git(repo,'rev-parse','HEAD'); git(repo,'checkout','main');
 return {root,remote,repo,other,sourceSha,close:()=>rmSync(root,{recursive:true,force:true})};
}
function completedJob(delivered){return {id:'job',title:'job',repository:'owner/repo',prNumber:0,externalPrNumber:27,state:'COMPLETED',executionMode:'fixed',continuation:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),tasks:[],localMerge:{sourceRef:'refs/heads/feature',targetRef:'refs/heads/main',status:'succeeded',...delivered}};}

test('local main is pushed to origin without a second merge and repeated delivery is idempotent',()=>{
 const f=fixture(); try{
  const delivered=deliverLocalMerge(f.repo,{sourceRef:'refs/heads/feature',targetRef:'refs/heads/main',status:'pending',sourceSha:f.sourceSha});
  const main=git(f.repo,'rev-parse','main');
  const first=projectAuthoritativeLocalMerge(f.repo,completedJob(delivered));
  assert.equal(first.status,'projected');
  git(f.repo,'fetch','origin','main');
  assert.equal(git(f.repo,'rev-parse','origin/main'),main);
  assert.equal(first.projectedCommitSha,main);
  assert.equal(projectAuthoritativeLocalMerge(f.repo,completedJob(delivered)).status,'already_projected');
 } finally {f.close();}
});

test('remote divergence is rejected rather than synthesizing a second merge',()=>{
 const f=fixture(); try{
  const delivered=deliverLocalMerge(f.repo,{sourceRef:'refs/heads/feature',targetRef:'refs/heads/main',status:'pending',sourceSha:f.sourceSha});
  execFileSync('git',['clone',f.remote,f.other]); git(f.other,'config','user.name','Other'); git(f.other,'config','user.email','other@example.test'); git(f.other,'checkout','main');
  writeFileSync(join(f.other,'remote-only'),'remote'); git(f.other,'add','.'); git(f.other,'commit','-m','remote drift'); git(f.other,'push','origin','main');
  const remote=git(f.other,'rev-parse','HEAD');
  assert.throws(()=>projectAuthoritativeLocalMerge(f.repo,completedJob(delivered)),/diverged/);
  git(f.repo,'fetch','origin','main');assert.equal(git(f.repo,'rev-parse','origin/main'),remote);
 } finally {f.close();}
});

test('projection refuses target branches other than main',()=>{
 const f=fixture();try{
  const delivered=deliverLocalMerge(f.repo,{sourceRef:'refs/heads/feature',targetRef:'refs/heads/main',status:'pending',sourceSha:f.sourceSha});
  assert.throws(()=>projectAuthoritativeLocalMerge(f.repo,completedJob({...delivered,targetRef:'refs/heads/develop'})),/must always be/);
 }finally{f.close();}
});

test('projection publishes later local main commits without resetting to an old receipt',()=>{
 const f=fixture(); try{
  const delivered=deliverLocalMerge(f.repo,{sourceRef:'refs/heads/feature',targetRef:'refs/heads/main',status:'pending',sourceSha:f.sourceSha});
  writeFileSync(join(f.repo,'after'),'after'); git(f.repo,'add','after'); git(f.repo,'commit','-m','move target');
  const newer=git(f.repo,'rev-parse','main');
  const result=projectAuthoritativeLocalMerge(f.repo,completedJob(delivered));
  assert.equal(result.projectedCommitSha,newer);
  git(f.repo,'fetch','origin','main');
  assert.equal(git(f.repo,'rev-parse','origin/main'),newer);
 } finally {f.close();}
});
