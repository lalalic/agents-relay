import test from './test-runtime.js';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {ensureManagedGitHubJob} from '../dist/cli-job-create.js';
import {openLocalManagedStore} from '../dist/local-managed-store.js';
import {createWorkspaceControl} from '../dist/relayd-control.js';

const graph='flowchart TD\nA[agent:first] --> B[agent:last]';
async function fixture(t){
 const root=await mkdtemp(join(process.env.AGENTS_RELAY_STORE_DIR??tmpdir(),'coordinator-atomic-'));
 await mkdir(join(root,'project'));execFileSync('git',['init','-q',join(root,'project')]);t.after(()=>rm(root,{recursive:true,force:true}));
 return {root,project:join(root,'project'),storeDirectory:join(root,'store'),coordinator:{graph,input:'Run one small Graph',
   outputPath:join(root,'result.json'),projectRoot:join(root,'project'),workspaceRoot:root}};
}

test('Coordinator Job and Agent Graph Task are created atomically in SQLite, with normal review and merge',async t=>{
 const f=await fixture(t);const options={objective:'Plan-free Graph Job',projectRoot:f.project,projectPath:'.',coordinator:f.coordinator,
  idempotencyKey:'same-private-run',storeDirectory:f.storeDirectory,noGitHub:true};
 const created=await ensureManagedGitHubJob({},'project',new Set(),options);
 assert.equal(created.job.state,'DRAFT');
 assert.equal(created.job.executionMode,undefined);
 assert.equal(created.job.contentOnly,undefined);
 assert.equal(created.job.reviewEnabled,true);
 assert.equal(created.job.autoMerge,true);
 assert.equal(created.job.plans?.length??0,0);
 assert.equal(created.job.tasks.length,1);
 const task=created.job.tasks[0];
 assert.equal(task.id,'coordinator');assert.equal(task.title,'Coordinator');
 assert.equal(task.agentGraph,graph);assert.equal(task.state,'QUEUED');
 const duplicate=await ensureManagedGitHubJob({},'project',new Set(),options);
 assert.equal(duplicate.job.id,created.job.id);
 assert.equal(duplicate.job.tasks.length,1);
 const local=openLocalManagedStore('project',0,{directory:f.storeDirectory,jobId:created.job.id,noGitHub:true});
 try{const stored=await local.relay.loadJob(created.job.id);
  assert.equal(stored.tasks.length,1);assert.equal(stored.tasks[0].id,'coordinator');
  assert.equal(stored.graphStartContext.projectPath,f.project);
 }finally{local.relay.close()}
 await assert.rejects(()=>ensureManagedGitHubJob({},'project',new Set(),
   {...options,coordinator:{...f.coordinator,graph:'flowchart TD\nX[agent:wrong]'}}),/different Graph or Run/);
});

test('Coordinator creation preserves independent final Review and Git Merge flags',async t=>{
 const f=await fixture(t);
 const noReview=await ensureManagedGitHubJob({},'project',new Set(),{
  objective:'No Final Review, normal Merge',projectRoot:f.project,coordinator:f.coordinator,
  storeDirectory:f.storeDirectory,noGitHub:true,reviewEnabled:false});
 assert.equal(noReview.job.reviewEnabled,false);assert.equal(noReview.job.autoMerge,true);
 const noMerge=await ensureManagedGitHubJob({},'project',new Set(),{
  objective:'Final Review, manual Merge',projectRoot:f.project,coordinator:f.coordinator,
  storeDirectory:f.storeDirectory,noGitHub:true,reviewEnabled:true,autoMerge:false});
 assert.equal(noMerge.job.reviewEnabled,true);assert.equal(noMerge.job.autoMerge,false);
 assert.equal(noMerge.job.tasks[0].id,'coordinator');
});

test('Control preserves caller no-GitHub intent when creating a Coordinator Job', async () => {
  for(const [serverNoGitHub,requestNoGitHub] of [[false,true],[true,false]]){
    let passed;
    const control=createWorkspaceControl({
      client:{},trusted:new Set(),noGitHub:serverNoGitHub,repositories:[],refreshAll:async()=>{},
      ensureManagedGitHubJob:async (_client,_repo,_trusted,options)=>{
        passed=options;
        return {job:{id:'isolated',state:'DRAFT'},pr:{number:0}};
      },
    });
    const response=await control({command:'job.create',repository:'project',
      options:{noGitHub:requestNoGitHub,coordinator:{graph,input:'x'}}});
    assert.equal(passed.noGitHub,true);
    assert.equal(response.taskId,'coordinator');
  }
});
