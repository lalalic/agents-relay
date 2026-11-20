// Independent differential for src/workspace.ts local/identity helpers:
// real temporary Git repositories on both stacks, no network. Covers
// validateProjectRoot, resolveWorkspaceRoot, discovery, remote parsing,
// run-path predicates, worktree path builders, local Job source branch,
// execution worktrees and reviewer cleanliness checks.
import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename} from 'node:path';
import {pathToFileURL} from 'node:url';

const root=resolve(import.meta.dirname,'../..');
const dist=await import(pathToFileURL(root+'/dist/workspace.js'));
const bin=root+'/rust/target/debug/relay-rust2-parity';
const base=mkdtempSync(join(tmpdir(),'rust2-ws-local-'));
const nodeRoot=join(base,'node-ws'),rustRoot=join(base,'rust-ws');
mkdirSync(nodeRoot);mkdirSync(rustRoot);

function git(cwd,...args){
  return execFileSync('git',['-C',cwd,...args],{encoding:'utf8',timeout:30000,
    env:{...process.env,GIT_TERMINAL_PROMPT:'0'}}).trim();
}
function native(request){
  return new Promise((res,rej)=>{
    const child=spawn(bin,[],{cwd:root});
    let out='',err='';
    child.stdout.on('data',c=>out+=c);
    child.stderr.on('data',c=>err+=c);
    child.on('error',rej);
    child.on('close',code=>{
      if(code!==0)return rej(new Error(err||`parity exited ${code}`));
      try{
        const parsed=JSON.parse(out.trim());
        if(!parsed.ok)throw new Error('parity error: '+parsed.error);
        res(parsed.value.outcome);
      }catch(e){rej(new Error(`${e.message}: ${out.slice(0,300)}`));}
    });
    child.stdin.end(JSON.stringify({op:'workspaceLocalParity',...request})+'\n');
  });
}
// Compare an async Node fn with the Rust parity outcome, normalizing the
// stack-specific workspace roots.
const clean=v=>JSON.parse(JSON.stringify(v)
  .replaceAll(nodeRoot,'<ws>').replaceAll(rustRoot,'<ws>')
  .replaceAll(base,'<base>'));
let comparisons=0;
const mismatches=[];
async function compare(name,nodePromise,rustPromise){
  const node=await nodePromise.then(
    v=>({ok:true,value:v}),e=>({ok:false,error:e.message}));
  const rust=await rustPromise.then(
    v=>({ok:true,value:v}),e=>({ok:false,error:e.message}));
  // Pure helpers arrive as {ok,value:{ok,value}} from the adapter envelope;
  // flatten one level so both sides compare bare values.
  const flatten=o=>(o&&o.ok===true&&o.value&&typeof o.value==='object'
    &&('ok' in o.value)&&('value' in o.value||'error' in o.value))?o.value:o;
  const rustFlat=flatten(rust);
  const n=clean(node),r=clean(rustFlat);
  comparisons++;
  if(JSON.stringify(n)!==JSON.stringify(r)){
    mismatches.push(name);
    console.log('WS_DIFF',name,
      'node',JSON.stringify(n).slice(0,300),
      'rust',JSON.stringify(r).slice(0,300));
  }
  return node;
}
// Build one repository fixture under each stack's workspace.
function fixture(wsRoot,name){
  const repo=join(wsRoot,name);
  mkdirSync(repo,{recursive:true});
  git(repo,'init','-q','-b','main');
  git(repo,'config','user.name','Relay Differential');
  git(repo,'config','user.email','diff@example.test');
  writeFileSync(join(repo,'file.txt'),'base\n');
  git(repo,'add','file.txt');
  git(repo,'commit','-qm','base');
  return repo;
}
try{
  // 1. githubRepositoryFromRemote: pure string parsing.
  const remotes=[
    'https://github.com/example/repo.git',
    'git@github.com:example/repo.git',
    'https://github.com/example/repo',
    'ssh://git@github.com/example/repo.git',
    'https://gitlab.com/example/repo.git',
    'https://github.com/example',
    'https://github.com/example/repo/extra',
    '  https://github.com/example/spaces.git  ',
    'https://GitHub.COM/Case/Repo.Git',
    'not a remote',
    '',
    'git@bitbucket.org:example/repo.git',
    'https://github.com/a-b.c/d_e.f.git',
  ];
  for(const remote of remotes){
    await compare('remote:'+remote,
      Promise.resolve(dist.githubRepositoryFromRemote(remote)),
      native({method:'githubRepositoryFromRemote',remote}));
  }
  // 2. isProjectRunPath + taskUsesCanonicalProjectRun predicates.
  const paths=['runs','runs/','runs/result.md','./runs/x','run','runsx',
    'src/runs/x','runs\\result.md','.\\runs\\x','',undefined,
    'runs/../secret','RUNS','runs '];
  for(const p of paths){
    await compare('runpath:'+p,
      (async()=>dist.isProjectRunPath(p))(),
      native({method:'isProjectRunPath',path:p??null}));
  }
  const tasks=[
    {id:'owner',output:{kind:'file',path:'runs/episode/r.md'}},
    {id:'child',parentTaskId:'owner',output:{kind:'task_pr'}},
    {id:'deep',parentTaskId:'child',output:{kind:'task_pr'}},
    {id:'plain',output:{kind:'file',path:'src/out.md'}},
    {id:'missing-parent',parentTaskId:'ghost',output:{kind:'task_pr'}},
    {id:'cycle-a',parentTaskId:'cycle-b',output:{kind:'file',path:'runs/x'}},
    {id:'cycle-b',parentTaskId:'cycle-a',output:{kind:'file',path:'runs/y'}},
    {id:'other-output'},
  ];
  for(const task of tasks){
    await compare('taskrun:'+task.id,
      (async()=>dist.taskUsesCanonicalProjectRun(task,tasks))(),
      native({method:'taskUsesCanonicalProjectRun',task,tasks}));
  }
  // 3. managedJobWorktreePath / managedLocalJobWorktreePath identities.
  const repoIds=['fixture/repo','a-b.c/d_e.f','x'.repeat(90),'bad','bad/x/y',
    'ok/','-','o/p','ünïcode/repo'];
  for(const repository of repoIds){
    await compare('pr-path:'+repository,
      (async()=>dist.managedJobWorktreePath(repository,23,nodeRoot))(),
      native({method:'managedJobWorktreePath',repository,prNumber:23,
        workspaceRoot:rustRoot}));
  }
  for(const pr of [0,-1,1,999999,2.5]){
    await compare('pr-number:'+pr,
      (async()=>dist.managedJobWorktreePath('a/b',pr,nodeRoot))(),
      native({method:'managedJobWorktreePath',repository:'a/b',prNumber:pr,
        workspaceRoot:rustRoot}));
  }
  const jobIds=['281','','  ','ünïcode','a'.repeat(100),'safe/../strange',
    'x y z','--x-','job_1.2-3'];
  for(const jobId of jobIds){
    await compare('local-path:'+jobId,
      (async()=>dist.managedLocalJobWorktreePath('myrepo',jobId,nodeRoot))(),
      native({method:'managedLocalJobWorktreePath',repository:'myrepo',jobId,
        workspaceRoot:rustRoot}));
  }
  for(const repository of ['bad/repo','','ünïcode']){
    await compare('local-repo:'+repository,
      (async()=>dist.managedLocalJobWorktreePath(repository,'j',nodeRoot))(),
      native({method:'managedLocalJobWorktreePath',repository,jobId:'j',
        workspaceRoot:rustRoot}));
  }
  // 4. jobRequiresManagedWorktree / taskRequiresManagedWorktree shapes.
  const jobShapes=[
    {id:'j',tasks:[]},
    {id:'j',prNumber:7,tasks:[{output:{kind:'task_pr'}}]},
    {id:'j',tasks:[{output:{kind:'file',path:'runs/r.md'}}]},
    {id:'j',localMerge:{sourceRef:'refs/heads/x',targetRef:'refs/heads/main'},tasks:[]},
    {id:'j',localMerge:{sourceRef:null},tasks:[]},
    {id:'j',tasks:[{output:null},{output:{kind:'task_pr'}}]},
  ];
  for(const job of jobShapes){
    await compare('jobreq:'+(job.prNumber??job.localMerge?'m':'p'),
      (async()=>dist.jobRequiresManagedWorktree(job))(),
      native({method:'jobRequiresManagedWorktree',job}));
    await compare('taskreq',
      (async()=>dist.taskRequiresManagedWorktree(job,
        job.tasks&&job.tasks[0]))(),
      native({method:'taskRequiresManagedWorktree',job,
        task:(job.tasks&&job.tasks[0])??null}));
    await compare('taskreq-undef',
      (async()=>dist.taskRequiresManagedWorktree(job,undefined))(),
      native({method:'taskRequiresManagedWorktree',job,task:null}));
  }
  // 5. resolveWorkspaceRoot semantics (existing dir, file, missing, default).
  mkdirSync(join(nodeRoot,'existing'));
  mkdirSync(join(rustRoot,'existing'));
  writeFileSync(join(nodeRoot,'plain-file'),'x');
  writeFileSync(join(rustRoot,'plain-file'),'x');
  for(const name of ['existing','plain-file','missing']){
    await compare('ws-root:'+name,
      dist.resolveWorkspaceRoot(join(nodeRoot,name)),
      native({method:'resolveWorkspaceRoot',explicit:join(rustRoot,name)}));
  }
  await compare('ws-root:relative',
    dist.resolveWorkspaceRoot('relative-dir'),
    native({method:'resolveWorkspaceRoot',explicit:'relative-dir'}));
  await compare('ws-root:undefined',
    dist.resolveWorkspaceRoot(undefined),
    native({method:'resolveWorkspaceRoot',explicit:null}));
  // 6. validateProjectRoot over real Git shapes.
  {
    const nodeRepo=fixture(nodeRoot,'repo');
    const rustRepo=fixture(rustRoot,'repo');
    // subdirectory + linked worktree + wrong identity + non-repo + relative
    mkdirSync(join(nodeRepo,'nested'));mkdirSync(join(rustRepo,'nested'));
    git(nodeRepo,'worktree','add','-q','--detach',join(nodeRoot,'wt'),'HEAD');
    git(rustRepo,'worktree','add','-q','--detach',join(rustRoot,'wt'),'HEAD');
    mkdirSync(join(nodeRoot,'notrepo'));mkdirSync(join(rustRoot,'notrepo'));
    const cases=[
      [nodeRepo,rustRepo,'repo'],
      [join(nodeRepo,'nested'),join(rustRepo,'nested'),'repo'],
      [join(nodeRoot,'wt'),join(rustRoot,'wt'),'repo'],
      [join(nodeRoot,'notrepo'),join(rustRoot,'notrepo'),'repo'],
      [nodeRepo,rustRepo,'wrong-name'],
      ['relative','relative','repo'],
    ];
    for(const [np,rp,repository] of cases){
      await compare('validate:'+repository+':'+basename(String(np)),
        dist.validateProjectRoot(np,repository),
        native({method:'validateProjectRoot',projectRoot:rp,repository}));
    }
  }
  // 7. discoverWorkspaceRepositories + resolveWorkspaceRepositoryPath +
  //    resolveManagedProjectPath over a real workspace tree.
  {
    for(const name of ['alpha','beta','zeta'])fixture(nodeRoot,name);
    for(const name of ['alpha','beta','zeta'])fixture(rustRoot,name);
    // hidden + excluded directories are skipped
    mkdirSync(join(nodeRoot,'.hidden'));git(join(nodeRoot,'.hidden'),'init','-q');
    mkdirSync(join(rustRoot,'.hidden'));git(join(rustRoot,'.hidden'),'init','-q');
    mkdirSync(join(nodeRoot,'node_modules','pkg'),{recursive:true});
    mkdirSync(join(rustRoot,'node_modules','pkg'),{recursive:true});
    await compare('discover',
      dist.discoverWorkspaceRepositories(nodeRoot),
      native({method:'discoverWorkspaceRepositories',root:rustRoot}));
    for(const name of ['alpha','zeta','nope']){
      await compare('resolve-repo:'+name,
        dist.resolveWorkspaceRepositoryPath(name,nodeRoot),
        native({method:'resolveWorkspaceRepositoryPath',repository:name,
          root:rustRoot}));
    }
    await compare('managed-path:explicit',
      dist.resolveManagedProjectPath('ignored','/explicit/path',nodeRoot,'/cwd'),
      native({method:'resolveManagedProjectPath',repository:'ignored',
        explicitProjectPath:'/explicit/path',root:rustRoot,cwd:'/cwd'}));
    await compare('managed-path:repo',
      dist.resolveManagedProjectPath('alpha','',nodeRoot,'/cwd'),
      native({method:'resolveManagedProjectPath',repository:'alpha',
        explicitProjectPath:'',root:rustRoot,cwd:'/cwd'}));
    await compare('managed-path:cwd',
      dist.resolveManagedProjectPath(undefined,'',nodeRoot,'/some/cwd'),
      native({method:'resolveManagedProjectPath',repository:null,
        explicitProjectPath:'',root:rustRoot,cwd:'/some/cwd'}));
  }
  // 8. ensureLocalJobSourceBranch + prepareLocalJobExecutionWorktree +
  //    assertCleanWorktreeAtHead over real Jobs. Each stack drives its own
  //    identical fixture repo; paths are normalized by `clean`.
  {
    const nodeRepo=fixture(nodeRoot,'jobs');
    const rustRepo=fixture(rustRoot,'jobs');
    const mkJob=(repo,id,over={})=>({id,projectRoot:repo,repository:'jobs',
      prNumber:0,state:'ACTIVE',tasks:[],plans:[],...over});
    const bound=(repo,id,sourceRef,targetRef)=>mkJob(repo,id,
      {localMerge:{sourceRef,targetRef,status:'pending'}});
    // ordinary SQLite Job source branch + stable reuse
    await compare('source-branch',
      dist.ensureLocalJobSourceBranch(nodeRepo,mkJob(nodeRepo,'283')),
      native({method:'ensureLocalJobSourceBranch',projectPath:rustRepo,
        job:mkJob(rustRepo,'283')}));
    await compare('source-branch-reuse',
      dist.ensureLocalJobSourceBranch(nodeRepo,mkJob(nodeRepo,'283')),
      native({method:'ensureLocalJobSourceBranch',projectPath:rustRepo,
        job:mkJob(rustRepo,'283')}));
    // existing sourceRef: target must be main; valid target returns it
    await compare('target-not-main',
      dist.ensureLocalJobSourceBranch(nodeRepo,
        bound(nodeRepo,'x','refs/heads/feature','refs/heads/dev')),
      native({method:'ensureLocalJobSourceBranch',projectPath:rustRepo,
        job:bound(rustRepo,'x','refs/heads/feature','refs/heads/dev')}));
    await compare('target-main-returns-source',
      dist.ensureLocalJobSourceBranch(nodeRepo,
        bound(nodeRepo,'x','refs/heads/feature','refs/heads/main')),
      native({method:'ensureLocalJobSourceBranch',projectPath:rustRepo,
        job:bound(rustRepo,'x','refs/heads/feature','refs/heads/main')}));
    // invalid sourceRef shapes rejected before any Git effect
    for(const sourceRef of ['refs/heads/..evil','refs/heads/x.lock',
      'refs/heads/ok..ok','refs/tags/v1','not-a-ref','refs/heads/']){
      await compare('bad-source:'+sourceRef,
        dist.prepareLocalJobExecutionWorktree(nodeRepo,
          bound(nodeRepo,'b',sourceRef,'refs/heads/main'),nodeRoot),
        native({method:'prepareLocalJobExecutionWorktree',projectPath:rustRepo,
          job:bound(rustRepo,'b',sourceRef,'refs/heads/main'),
          workspaceRoot:rustRoot}));
    }
    // no localMerge -> canonical project root via validation
    await compare('no-merge-resolves-root',
      dist.prepareLocalJobExecutionWorktree(nodeRepo,mkJob(nodeRepo,'283'),nodeRoot),
      native({method:'prepareLocalJobExecutionWorktree',projectPath:rustRepo,
        job:mkJob(rustRepo,'283'),workspaceRoot:rustRoot}));
    // real worktree lifecycle: create then reuse
    git(nodeRepo,'branch','lj-feature');
    git(rustRepo,'branch','lj-feature');
    const sha=git(nodeRepo,'rev-parse','HEAD');
    const wj=(repo,id)=>bound(repo,id,'refs/heads/lj-feature','refs/heads/main');
    const nodeW=await compare('lj-create',
      dist.prepareLocalJobExecutionWorktree(nodeRepo,wj(nodeRepo,'291'),nodeRoot),
      native({method:'prepareLocalJobExecutionWorktree',projectPath:rustRepo,
        job:wj(rustRepo,'291'),workspaceRoot:rustRoot}));
    await compare('lj-reuse',
      dist.prepareLocalJobExecutionWorktree(nodeRepo,wj(nodeRepo,'291'),nodeRoot),
      native({method:'prepareLocalJobExecutionWorktree',projectPath:rustRepo,
        job:wj(rustRepo,'291'),workspaceRoot:rustRoot}));
    // reviewer cleanliness on the shared checkout
    await compare('clean-head',
      dist.assertCleanWorktreeAtHead(nodeW.value,sha).then(()=>null,
        e=>{throw e;}),
      native({method:'assertCleanWorktreeAtHead',projectPath:nodeW.value,
        headSha:sha}).then(o=>o.ok?null:Promise.reject(new Error(o.error||'assert failed'))));
    writeFileSync(join(nodeW.value,'scratch.txt'),'dirty');
    await compare('clean-dirty',
      dist.assertCleanWorktreeAtHead(nodeW.value,sha).then(()=>null,
        e=>{throw e;}),
      native({method:'assertCleanWorktreeAtHead',projectPath:nodeW.value,
        headSha:sha}).then(o=>o.ok?null:Promise.reject(new Error(o.error||'assert failed'))));
    rmSync(join(nodeW.value,'scratch.txt'));
    await compare('clean-stale',
      dist.assertCleanWorktreeAtHead(nodeW.value,'0'.repeat(40))
        .then(()=>null,e=>{throw e;}),
      native({method:'assertCleanWorktreeAtHead',projectPath:nodeW.value,
        headSha:'0'.repeat(40)}).then(o=>o.ok?null:Promise.reject(new Error(o.error||'assert failed'))));
    // canonical checkout already owning the source branch
    git(nodeRepo,'checkout','-q','-b','repair-in-place');
    git(rustRepo,'checkout','-q','-b','repair-in-place');
    writeFileSync(join(nodeRepo,'preserve.txt'),'keep\n');
    writeFileSync(join(rustRepo,'preserve.txt'),'keep\n');
    const ownJob=(repo)=>bound(repo,'282','refs/heads/repair-in-place',
      'refs/heads/main');
    await compare('lj-owns-branch',
      dist.prepareLocalJobExecutionWorktree(nodeRepo,ownJob(nodeRepo),nodeRoot),
      native({method:'prepareLocalJobExecutionWorktree',projectPath:rustRepo,
        job:ownJob(rustRepo),workspaceRoot:rustRoot}));
    git(nodeRepo,'checkout','-q','main');
    git(rustRepo,'checkout','-q','main');
    rmSync(join(nodeRepo,'preserve.txt'));
    rmSync(join(rustRepo,'preserve.txt'));
  }
  assert.deepEqual(mismatches,[],`${mismatches.length} workspace local mismatches`);
  console.log('Verified',comparisons,
    'original Node/Rust workspace local differential cases');
}finally{
  rmSync(base,{recursive:true,force:true});
}
