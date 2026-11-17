// Real source-vs-port filesystem/Git differential. All repositories and
// worktrees are disposable, no network and no production state.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {cleanupCompletedJobWorktree,managedLocalJobWorktreePath} from '../dist/workspace.js';
const binary=resolve('rust/target/debug/relay-rust2-parity');
const root=mkdtempSync(join(tmpdir(),'rust2-wave3-native-git-'));
const git=(cwd,...args)=>{
 const p=spawnSync('git',['-C',cwd,...args],{encoding:'utf8',timeout:30000,
  env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
 assert.equal(p.status,0,'git '+args+' '+p.stderr);
 return p.stdout.trim();
};
const rust=(request)=>{
 const p=spawnSync(binary,[],{input:JSON.stringify({op:'deliveryWave2',...request})+'\n',
   encoding:'utf8',timeout:30000,env:{...process.env,AGENTS_RELAY_STORE_DIR:join(root,'store')}});
 assert.equal(p.status,0,p.stderr);
 const value=JSON.parse(p.stdout);
 if(!value.ok)throw new Error(value.error);
 return value.value;
};
const seed=[1,3,8,31,52,93,404,'xyz','safe/../strange','--x-', '  ', 'unicode-文'];
let randomSeed=0xc01db17;
for(let i=0;i<115;i++){
 randomSeed^=randomSeed<<13;randomSeed^=randomSeed>>>17;randomSeed^=randomSeed<<5;
 const alphabet='abcABC012_-./! %';
 let text='';
 for(let j=0;j<((randomSeed>>>8)&15)+1;j++)text+=alphabet[((randomSeed+j*13)>>>0)%alphabet.length];
 seed.push(text);
}

let comparisons=0;
try {
 for(const jobId of seed){
  const workspaceRoot=join(root,'workspace');
  const wrap=fn=>{try{return {ok:true,value:fn()}}catch(e){return {ok:false,error:e.message}}};
  const n=wrap(()=>managedLocalJobWorktreePath('myrepo',String(jobId),workspaceRoot));
  const r=wrap(()=>rust({case:'managedLocalWorktreePath',workspaceRoot,repository:'myrepo',jobId:String(jobId)}));
  assert.deepEqual(r,n,'ID '+jobId);
  comparisons++;
 }
 const projectPath=join(root,'myrepo'), workspaceRoot=join(root,'workspace');
 mkdirSync(projectPath,{recursive:true});mkdirSync(workspaceRoot,{recursive:true});
 git(projectPath,'init','-q','-b','main');
 git(projectPath,'config','user.name','Fixture');
 git(projectPath,'config','user.email','fixture@example.test');
 writeFileSync(join(projectPath,'base.txt'),'base');git(projectPath,'add','base.txt');
 git(projectPath,'commit','-qm','base');
 git(projectPath,'branch','feature');
 const original=git(projectPath,'rev-parse','HEAD');
 let serial=0;
 for(const state of ['ACTIVE','COMPLETED']) {
  for(const mode of ['missing','no-sha','lease','planner','stale','dirty','ready']){
   serial++;
   const jobId=String(serial);
   const worktree=managedLocalJobWorktreePath('myrepo',jobId,workspaceRoot);
   const job={id:jobId,repository:'myrepo',projectRoot:projectPath,state,
    headSha:original,localMerge:{sourceRef:'refs/heads/feature',sourceSha:original},
    plans:[],tasks:[]};
   if(mode==='no-sha'){delete job.localMerge.sourceSha;delete job.headSha;}
   if(mode==='lease')job.tasks.push({executionId:'busy',leaseOwner:null});
   if(mode==='planner')job.plans.push({executionId:null,leaseOwner:'busy'});
   if(mode==='stale')job.localMerge.sourceSha='a'.repeat(40);
   if(mode!=='missing'){
    mkdirSync(resolve(worktree,'..'),{recursive:true});
    git(projectPath,'worktree','add','-q','--detach',worktree,'feature');
    if(mode==='dirty')writeFileSync(join(worktree,'scratch.tmp'),'dirty');
   }
   const request={case:'cleanupNative',projectPath,workspaceRoot,job};
   // Re-create only the successfully removed fixture, so both ports observe
   // identical Git/FS preconditions and independently perform the effect.
   const nr=await cleanupCompletedJobWorktree(projectPath,job,workspaceRoot);
   if(nr.status==='removed'){
    git(projectPath,'worktree','add','-q','--detach',worktree,'feature');
   }
   const rr=rust(request);
   assert.deepEqual(rr,nr,JSON.stringify({state,mode,rr,nr}));
   if(mode==='ready'&&state==='COMPLETED'){
    assert.deepEqual(rust(request),{status:'absent'});
   }
   if(mode!=='missing' && rr.status!=='removed') {
     // preserve cleanup isolation after checking: remove only our fixture
     if(mode==='dirty')rmSync(join(worktree,'scratch.tmp'));
     git(projectPath,'worktree','remove',worktree);
   }
   comparisons++;
  }
 }
 // A symlink at the managed path must be blocked; never follow its target.
 const jobId='symlink';
 const link=managedLocalJobWorktreePath('myrepo',jobId,workspaceRoot);
 mkdirSync(resolve(link,'..'),{recursive:true});
 symlinkSync(projectPath,link);
 const job={id:jobId,repository:'myrepo',projectRoot:projectPath,state:'COMPLETED',
  localMerge:{sourceRef:'refs/heads/feature',sourceSha:original},plans:[],tasks:[]};
 const r=rust({case:'cleanupNative',job,projectPath,workspaceRoot});
 const n=await cleanupCompletedJobWorktree(projectPath,job,workspaceRoot);
 assert.deepEqual(r,n);comparisons++;
 console.log('PASS Rust2 Wave3 native cleanup Node/Rust direct Git+FS differential '+comparisons);
}finally{rmSync(root,{recursive:true,force:true});}
