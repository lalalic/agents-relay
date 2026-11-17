import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const packageRoot=join(dirname(fileURLToPath(import.meta.url)),'../..');
const cli=join(packageRoot,'dist/cli.js');
const daemon=join(packageRoot,'dist/relayd-main.js');
async function freePort(){
  const socket=createServer();
  await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;
  await new Promise(resolve=>socket.close(resolve));
  return port;
}

test('L3 real CLI create persists explicit local Git merge refs without any PR binding',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-cli-local-git-'));
  const repo=join(root,'sample'),store=join(root,'store');
  mkdirSync(repo);mkdirSync(store);
  execFileSync('git',['init','-q','-b','main',repo]);
  writeFileSync(join(repo,'README.md'),'isolated local Git\n');
  const port=await freePort();
  const env={...process.env,AGENTS_RELAY_STORE_DIR:store,AGENTS_RELAY_WORKSPACE_ROOT:root,
    AGENTS_RELAY_WEBHELM_COMMAND:'/usr/bin/false',GIT_TERMINAL_PROMPT:'0'};
  let worker;
  try{
    worker=spawn(process.execPath,[daemon,'--repo','sample','--project-path',repo,
      '--workspace-root',root,'--port',String(port),'--events','none',
      '--interval','3600000','--refresh-ms','3600000'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
    let errors='';worker.stderr.on('data',data=>errors+=String(data).slice(-1500));
    let ready=false;
    for(let i=0;i<65;i++){
      if(worker.exitCode!==null)break;
      try{const response=await fetch(`http://127.0.0.1:${port}/api/jobs?limit=1`);if(response.ok){ready=true;break;}}
      catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(ready,'isolated Relay daemon did not start '+errors);
    const run=args=>spawnSync(process.execPath,[cli,'job',...args,
      '--host','127.0.0.1','--port',String(port),'--events','none'],
      {cwd:repo,env,encoding:'utf8',timeout:12000});
    const created=run(['create','--repo','sample','--project-root',repo,
      '--objective','Local Git code task with explicit refs',
      '--local-merge-source','refs/heads/feature','--local-merge-target','refs/heads/main']);
    assert.equal(created.status,0,created.stderr);
    const id=JSON.parse(created.stdout).job;
    assert.match(String(id),/^[1-9][0-9]*$/);
    const shown=run(['show','--repo','sample','--id',String(id)]);
    assert.equal(shown.status,0,shown.stderr);
    const job=JSON.parse(shown.stdout);
    assert.equal(job.repository,'sample');
    assert.equal(job.projectRoot,realpathSync(repo));
    assert.equal(Object.hasOwn(job,'projectPath'),false,'Job has no nested subproject path');
    assert.equal(job.state,'DRAFT');
    assert.equal(job.prNumber,0);
    assert.deepEqual(job.localMerge,{sourceRef:'refs/heads/feature',targetRef:'refs/heads/main',status:'pending'});
    assert.equal(job.remoteDelivery,undefined,'remote delivery is not a Job creation prerequisite');
    // The compatibility init command must also allocate a numeric managed Job
    // and pass the calling local Git root, never the daemon process cwd.
    const initialized=spawnSync(process.execPath,[cli,'init','--repo','sample',
      '--title','Local no-PR demo','--project-root',repo,'--host','127.0.0.1',
      '--port',String(port),'--events','none'],{cwd:repo,env,encoding:'utf8',timeout:12000});
    assert.equal(initialized.status,0,initialized.stderr);
    const initJob=JSON.parse(initialized.stdout);
    assert.match(String(initJob.job),/^[1-9][0-9]*$/);
    assert.notEqual(String(initJob.job),String(id));
    const missing=run(['create','--repo','sample','--objective','missing target',
      '--local-merge-source','refs/heads/feature']);
    assert.notEqual(missing.status,0);
    assert.match(missing.stderr,/Supply both --local-merge-source and --local-merge-target/);
    const nested=run(['create','--repo','sample','--project-root',repo,'--project-path','nested','--objective','obsolete nested job']);
    assert.notEqual(nested.status,0);
    assert.match(nested.stderr,/Job --project-path is removed/);
    const nestedUpdate=run(['update','--repo','sample','--id',String(id),'--project-path','nested']);
    assert.notEqual(nestedUpdate.status,0);
    assert.match(nestedUpdate.stderr,/Job --project-path is removed/);
    const rejected=run(['create','--repo','owner/sample','--objective','remote alias']);
    assert.notEqual(rejected.status,0);
    assert.match(rejected.stderr,/local Git root basename/);
  }finally{
    if(worker&&worker.exitCode===null){
      worker.kill('SIGTERM');
      await Promise.race([new Promise(resolve=>worker.once('exit',resolve)),
        new Promise(resolve=>setTimeout(resolve,3000))]);
      if(worker.exitCode===null)worker.kill('SIGKILL');
    }
    rmSync(root,{recursive:true,force:true});
  }
});

test('L3 ordinary daemon restores SQLite Jobs after unrelated Workspace layout disappears without --workspace',async()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-workspace-independent-'));
  const repo=join(root,'repos','sample'),unrelated=join(root,'elsewhere');
  const workspace=join(root,'old-Workspace'),store=join(root,'store');
  mkdirSync(repo,{recursive:true});mkdirSync(unrelated);mkdirSync(store);
  mkdirSync(join(workspace,'nested','random'),{recursive:true});
  execFileSync('git',['init','-q','-b','main',repo]);
  writeFileSync(join(repo,'README.md'),'repository outside the Workspace root\n');
  const port=await freePort();
  const env={...process.env,AGENTS_RELAY_STORE_DIR:store,AGENTS_RELAY_WORKSPACE_ROOT:workspace,
    AGENTS_RELAY_WEBHELM_COMMAND:'/usr/bin/false',GIT_TERMINAL_PROMPT:'0'};
  let worker;
  const boot=async()=>{
    worker=spawn(process.execPath,[daemon,'--port',String(port),'--events','none',
      '--interval','3600000','--refresh-ms','3600000'],
      {cwd:unrelated,env,stdio:['ignore','pipe','pipe']});
    let errors='';worker.stderr.on('data',b=>errors+=String(b).slice(-1500));
    for(let i=0;i<65;i++){
      if(worker.exitCode!==null)break;
      try{if((await fetch(`http://127.0.0.1:${port}/api/jobs?limit=1`)).ok)return;}
      catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.fail('daemon without --workspace failed to boot: '+errors);
  };
  const stop=async()=>{
    if(!worker||worker.exitCode!==null)return;
    worker.kill('SIGTERM');
    await Promise.race([new Promise(resolve=>worker.once('exit',resolve)),
      new Promise(resolve=>setTimeout(resolve,4000))]);
    if(worker.exitCode===null)worker.kill('SIGKILL');
  };
  const run=args=>spawnSync(process.execPath,[cli,'job',...args,
    '--host','127.0.0.1','--port',String(port),'--events','none'],
    {cwd:unrelated,env,encoding:'utf8',timeout:12000});
  try{
    await boot();
    const created=run(['create','--repo','sample','--project-root',repo,
      '--objective','Complete from a stored local Git root, independent of Workspace']);
    assert.equal(created.status,0,created.stderr);
    const id=String(JSON.parse(created.stdout).job);
    assert.match(id,/^[1-9][0-9]*$/);
    await stop();
    // Simulate a concurrent rename/deletion of Workspace layout. The legacy
    // AGENTS_RELAY_WORKSPACE_ROOT environment now points at a missing path.
    const {renameSync,existsSync}=await import('node:fs');
    renameSync(workspace,join(root,'renamed-Workspace'));
    assert.equal(existsSync(workspace),false);
    await boot();
    const shown=run(['show','--repo','sample','--id',id]);
    assert.equal(shown.status,0,shown.stderr);
    const job=JSON.parse(shown.stdout);
    assert.equal(job.id,id);
    assert.equal(job.projectRoot,realpathSync(repo));
    assert.equal(job.repository,'sample');
    assert.equal(job.state,'DRAFT');
    const inventory=await (await fetch(`http://127.0.0.1:${port}/api/jobs?limit=20`)).json();
    assert.ok(JSON.stringify(inventory).includes(id),'SQLite Job inventory survives Workspace move');
  }finally{
    await stop();
    rmSync(root,{recursive:true,force:true});
  }
});
