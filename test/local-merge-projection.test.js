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

test('authoritative projection converges a stale divergent remote without rewriting local history',()=>{
 const f=fixture(); try{
  const delivered=deliverLocalMerge(f.repo,{sourceRef:'refs/heads/feature',targetRef:'refs/heads/main',status:'pending',sourceSha:f.sourceSha});
  const localMain=git(f.repo,'rev-parse','main'); const authoritativeTree=git(f.repo,'rev-parse',`${localMain}^{tree}`);

  // Simulate remote main independently advancing while local authority keeps its own merge history.
  execFileSync('git',['clone',f.remote,f.other]); git(f.other,'config','user.name','Other'); git(f.other,'config','user.email','other@example.test'); git(f.other,'checkout','main');
  writeFileSync(join(f.other,'remote-only'),'remote'); git(f.other,'add','.'); git(f.other,'commit','-m','remote drift'); git(f.other,'push','origin','main');
  const remoteBefore=git(f.other,'rev-parse','HEAD');

  const result=projectAuthoritativeLocalMerge(f.repo,completedJob(delivered));
  assert.equal(result.status,'projected'); assert.equal(result.remoteTargetSha,remoteBefore);
  git(f.repo,'fetch','origin','main'); const remoteAfter=git(f.repo,'rev-parse','origin/main');
  assert.equal(remoteAfter,result.projectedCommitSha);
  assert.equal(git(f.repo,'rev-parse',`${remoteAfter}^{tree}`),authoritativeTree,'remote tree must equal authoritative local merged tree');
  assert.doesNotThrow(()=>git(f.repo,'merge-base','--is-ancestor',f.sourceSha,remoteAfter),'reviewed PR head must become remote target ancestor');
  assert.equal(git(f.repo,'rev-parse','main'),localMain,'local authority history must remain unchanged');
  assert.equal(git(f.repo,'rev-parse',`${remoteAfter}^1`),remoteBefore,'projection must fast-forward from current remote target');
  assert.equal(git(f.repo,'rev-parse',`${remoteAfter}^2`),f.sourceSha,'projection second parent must be reviewed source head');

  const again=projectAuthoritativeLocalMerge(f.repo,completedJob(delivered));
  assert.equal(again.status,'already_projected');
 } finally {f.close();}
});

test('authoritative projection refuses moved local target',()=>{
 const f=fixture(); try{
  const delivered=deliverLocalMerge(f.repo,{sourceRef:'refs/heads/feature',targetRef:'refs/heads/main',status:'pending',sourceSha:f.sourceSha});
  writeFileSync(join(f.repo,'after'),'after'); git(f.repo,'add','after'); git(f.repo,'commit','-m','move target');
  assert.throws(()=>projectAuthoritativeLocalMerge(f.repo,completedJob(delivered)),/moved after authoritative delivery/);
 } finally {f.close();}
});
