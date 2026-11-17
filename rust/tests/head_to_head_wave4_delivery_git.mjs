// Wave4 Git effects compare original src/local-git-merge.ts with native Rust.
// Each repository is a disposable local fixture; no remote push or live refs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deliverLocalMerge} from '../../dist/local-git-merge.js';
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const base=mkdtempSync(join(tmpdir(),'rust2-wave4-merge-'));
const env={...process.env,GIT_AUTHOR_DATE:'2020-01-02T01:02:03+0000',
  GIT_COMMITTER_DATE:'2020-01-02T01:02:03+0000',GIT_TERMINAL_PROMPT:'0',
  AGENTS_RELAY_STORE_DIR:join(base,'store')};
process.env.GIT_AUTHOR_DATE=env.GIT_AUTHOR_DATE;
process.env.GIT_COMMITTER_DATE=env.GIT_COMMITTER_DATE;
const git=(dir,...args)=>{
  const p=spawnSync('git',['-C',dir,...args],{encoding:'utf8',env,timeout:10000});
  assert.equal(p.status,0,p.stderr||p.error?.message);
  return p.stdout.trim();
};
const rust=(repo,receipt)=>{
  const p=spawnSync(binary,[],{
    input:JSON.stringify({op:'wave4LocalMerge',repo,receipt})+'\n',
    encoding:'utf8',cwd:root,timeout:30000,env,
  });
  assert.equal(p.status,0,p.stderr||p.error?.message);
  return JSON.parse(p.stdout.trim());
};
const node=(repo,receipt)=>{
  try{return {ok:true,value:deliverLocalMerge(repo,receipt)}}
  catch(e){return {ok:false,error:e.message}}
};
function repo(where,scenario,index){
  mkdirSync(where,{recursive:true});
  git(where,'init','-q','-b','main');
  git(where,'config','user.name','Fixture');
  git(where,'config','user.email','fixture@example.test');
  writeFileSync(join(where,'base.txt'),'same base\n');
  git(where,'add','base.txt');git(where,'commit','-qm','base');
  git(where,'checkout','-qb','feature');
  writeFileSync(join(where,scenario===7?'base.txt':'feature.txt'),
    scenario===7?'feature change\n':'feature number '+index+'\n');
  git(where,'add','.');git(where,'commit','-qm','feature');
  if(scenario!==9)git(where,'checkout','-q','main');
  if(scenario===7){
    writeFileSync(join(where,'base.txt'),'main change\n');
    git(where,'add','base.txt');git(where,'commit','-qm','main-change');
  }
  if(scenario===2)writeFileSync(join(where,'base.txt'),'dirty\n');
  return {
    sourceSha:git(where,'rev-parse','refs/heads/feature'),
    mainSha:git(where,'rev-parse','refs/heads/main'),
  };
}
test.after(()=>rmSync(base,{recursive:true,force:true}));
test('Wave4 local Git: 40 original Node/Rust real merge, fence and idempotency cases',()=>{
  for(let i=0;i<40;i++){
    const scenario=i%10;
    const left=join(base,'node-'+i),right=join(base,'rust-'+i);
    const leftRefs=repo(left,scenario,i),rightRefs=repo(right,scenario,i);
    assert.deepEqual(leftRefs,rightRefs,'fixture commit identity '+i);
    const receipt={sourceRef:'refs/heads/feature',targetRef:'refs/heads/main',
      sourceSha:leftRefs.sourceSha,correlationJobId:'job-'+i,displayPrNumber:100+i};
    if(scenario===3)receipt.targetRef='refs/heads/dev';
    if(scenario===4)receipt.sourceRef='refs/heads/main';
    if(scenario===5)receipt.sourceSha='f'.repeat(40);
    if(scenario===6)receipt.sourceRef='refs/heads/not-found';
    const original=node(left,receipt);
    const native=rust(right,receipt);
    assert.equal(native.ok,original.ok,'merge status '+i);
    if(original.ok){
      assert.deepEqual(native.value,original.value,'merge receipt '+i);
      assert.equal(git(left,'rev-parse','refs/heads/main'),
        git(right,'rev-parse','refs/heads/main'),'target ref '+i);
      if(scenario===1||scenario===8){
        const secondNode=node(left,receipt);
        const secondRust=rust(right,receipt);
        assert.deepEqual(secondRust,secondNode,'restart/idempotent '+i);
      }
    }else{
      const known=['Local Git merge target must always',
        'Local merge source and target must differ',
        'Local merge source SHA changed after review',
        'Local merge target worktree has tracked or index changes'];
      if(known.some(x=>original.error.includes(x))){
        assert.equal(native.error,original.error,'public error '+i);
      }
      assert.equal(git(left,'rev-parse','refs/heads/main'),leftRefs.mainSha,'Node no partial commit '+i);
      assert.equal(git(right,'rev-parse','refs/heads/main'),rightRefs.mainSha,'Rust no partial commit '+i);
      assert.equal(existsSync(join(left,'.git','MERGE_HEAD')),
        existsSync(join(right,'.git','MERGE_HEAD')),'recovery partial state '+i);
    }
  }
  console.log('PASS Rust2 Wave4 local Git 40 original Node vs Rust real checkout/ref/merge cases');
});
