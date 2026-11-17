import test from './test-runtime.js';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {workerTaskFromArgs} from '../dist/cli-worker-task.js';
import {helpText} from '../dist/cli-help.js';
import {newLocalRepository,repository} from '../dist/cli-support.js';
import {normalizeDaemonArguments} from '../dist/relayd-utilities.js';

test('obsolete PR and GitHub lifecycle CLI flags fail closed',()=>{
 const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
 for(const flag of ['--github-repo','--pr','--no-github','--dependent-pr','--projection-ms','--github-webhook-secret-file','--github-app-id','--github-app-installation-id','--github-app-private-key-file','--github-token','--github-repo=owner/repo','--pr=2','--no-github=true']) assert.throws(()=>execFileSync(process.execPath,[cli,'job','create',flag,'value'],{encoding:'utf8'}),/Unsupported option/);
 for(const flag of ['--github-repo','--pr','--no-github','--dependent-pr','--projection-ms','--github-webhook-secret-file','--github-app-id','--github-app-installation-id','--github-app-private-key-file','--github-token','--github-repo=owner/repo','--pr=2','--no-github=true']) assert.throws(()=>normalizeDaemonArguments([flag,'value']),/Unsupported option/);
});

test('local repository remains the required CLI identity',()=>{
 const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
 assert.throws(()=>execFileSync(process.execPath,[cli,'job','create','--objective','task'],{encoding:'utf8'}),/--repo must name the local Git root directory/);
});


test('retired remote flags are rejected on every public CLI command, including help',()=>{
 const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
 for(const args of [
   ['job','show','--id','1','--pr','2'],
   ['task','list','--id','1','--no-github'],
   ['review','job','--id','1','--github-repo','owner/name'],
   ['job','create','--help','--pr=3'],
   ['--help','--github-repo','owner/name']
 ]) assert.throws(()=>execFileSync(process.execPath,[cli,...args],{encoding:'utf8'}),/Unsupported option/);
});

test('public Task output is local Git work or file, not a PR; historic SQLite enum stays readable',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-output-contract-'));
 try{
   const job={id:'101',repository:'sample',projectRoot:dir,tasks:[],priority:'P2'};
   const input=['--store-dir',dir,'--input','Local test task'];
   const task=await workerTaskFromArgs(job,[...input,'--output','local-git'],new Date().toISOString());
   assert.equal(task.output.kind,'task_pr','internal historical enum retained for persisted records');
   assert.match(task.id,/^[0-9]+$/);
   await assert.rejects(workerTaskFromArgs(job,[...input,'--output','task-pr'],new Date().toISOString()),/--output local-git\|file/);
   assert.match(helpText('task create'),/--output local-git\|file/);
   assert.doesNotMatch(helpText('task create'),/task-pr|j-5-owner-repo-1/);
   assert.doesNotMatch(helpText('review job'),/OWNER\/REPO/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});


test('repo CLI identity rejects remote owners and filesystem paths before contacting a daemon',()=>{
  for(const rejected of ['owner/repo','/tmp/project','../project','.','..','https://github.com/owner/repo'])
    assert.throws(()=>newLocalRepository(['--repo',rejected]),/local Git root basename/);
  assert.equal(newLocalRepository(['--repo','agents-relay']),'agents-relay');
  assert.equal(repository(['--repo','owner/repo']),'owner/repo','historical PR-bound SQLite lookup must remain readable');
});


test('retired job merge command fails locally without contacting any daemon',()=>{
 const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
 assert.throws(()=>execFileSync(process.execPath,[cli,'job','merge','--id','101','--events','none'],{encoding:'utf8'}),/Unsupported command job merge/);
});


test('service manager defines a local, workspace-scan-free daemon without retired GitHub options',()=>{
 const script=readFileSync(fileURLToPath(new URL('../skills/agents-relay/bin/services.mjs',import.meta.url)),'utf8');
 const definitions=script.match(/^const definitions=(.*);$/m);
 assert.ok(definitions,'read the exact service argv definition without invoking serviceman or PM2');
 const services=JSON.parse(definitions[1]);
 const [name,binary,args]=services.find(item=>item[0]==='daemon');
 assert.equal(name,'daemon');
 assert.equal(binary,'npx');
 assert.deepEqual(args.slice(0,4), ['--yes','--package','agents-relay@latest','agents-relayd'],
   'Neo Master daemon must use published npm latest so package.published can restart it');
 for(const obsolete of ['--workspace','--workspace-root','--github-webhook-secret-file',
   '--github-repo','--no-github','--pr'])
   assert.equal(args.includes(obsolete),false,obsolete);
 assert.ok(args.includes('--port'));
});
