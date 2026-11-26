#!/usr/bin/env node
// Reviewed main -> immutable native package -> verified activation -> release
// receipt. No Job required. Node is a release tool, not a Relay backend.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { endpoint, requestJSON, releaseEvent,releaseHistoryPath, publishVerified } from './report-publication.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PACKAGE='agents-relay',SERVICE='agents-relay/daemon';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const shaPattern=/^[0-9a-f]{40}$/;
function run(command,args=[],{capture=false,timeout=120000}={}){
  return execFileSync(command,args,{cwd:ROOT,timeout,maxBuffer:64*1024*1024,
    encoding:'utf8',stdio:capture?['ignore','pipe','inherit']:'inherit'});
}
const git=(...args)=>run('git',args,{capture:true}).trim();
function loopback(value){
  const u=new URL(value);
  if(u.protocol!=='http:'||!['127.0.0.1','[::1]','localhost'].includes(u.hostname)||!u.port)
    throw Error('Expected explicit loopback HTTP URL with port');
  return endpoint(value);
}
export function pausedAndQuiescent(job){
  return Boolean(job?.pause?.requestedAt&&Array.isArray(job.tasks)&&Array.isArray(job.plans)
    &&job.tasks.every(t=>!t.executionId&&!t.pausedExecution)
    &&job.plans.every(p=>!p.executionId&&!p.pausedExecutionId));
}
export function assertIdleDatabase(database,allowed=[],alive=(pid)=>{
  try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}
}){
  const db=new DatabaseSync(database,{readOnly:true});
  try{
    db.exec('PRAGMA busy_timeout=2000; BEGIN');
    if(db.prepare('PRAGMA quick_check').all().some(r=>Object.values(r)[0]!=='ok'))throw Error('Relay SQLite integrity check failed');
    const jobs=db.prepare('SELECT job_id,json FROM job_snapshot').all();
    const busy=[];
    for(const row of jobs){
      const j=JSON.parse(row.json);
      if(j.id!==row.job_id)throw Error('Job snapshot identity mismatch');
      if(!['COMPLETED','CANCELLED','FAILED'].includes(j.state)&&!(allowed.includes(j.id)&&pausedAndQuiescent(j)))busy.push(j.id);
    }
    if(busy.length)throw Error('Refusing deployment while nonterminal Jobs exist: '+busy.join(', '));
    for(const {pid,pgid} of db.prepare('SELECT pid,pgid FROM execution_process WHERE ended_at IS NULL').all()){
      if(!Number.isSafeInteger(pid)||pid<=1||!Number.isSafeInteger(pgid)||pgid<=1||alive(pid)||alive(-pgid))
        throw Error('Potentially active worker PID or process group: '+pid+'/'+pgid);
    }
    return jobs.length;
  }finally{db.close();}
}
function service(){
  const row=JSON.parse(run('npx',['pm2','jlist'],{capture:true,timeout:15000})).find(x=>x.name===SERVICE);
  if(!row||path.basename(row.pm2_env.pm_exec_path)!=='agents-relayd'
    ||path.resolve(row.pm2_env.pm_exec_path).startsWith(ROOT+'/'))throw Error('PM2 must use installed agents-relayd launcher');
  const args=row.pm2_env.args;
  if(!Array.isArray(args)||args.filter(x=>x==='--live-store-dir').length!==1)throw Error('No unique live store binding');
  const stores=fs.realpathSync(args[args.indexOf('--live-store-dir')+1]);
  const db=fs.realpathSync(path.join(stores,'..','relay.sqlite'));
  if(db!==path.join(path.dirname(stores),'relay.sqlite'))throw Error('Unexpected SQLite alias');
  return {db};
}
function checkIdle(allowed){
  const count=assertIdleDatabase(service().db,allowed);
  console.log('SQLite idle verification:',count,'Jobs');
}
function switchLink(link,target){
  const stage=link+'.stage-'+process.pid;
  try{fs.symlinkSync(target,stage);fs.renameSync(stage,link);}
  finally{fs.rmSync(stage,{force:true});}
}
async function waitForLive(api,packageDir,version,sha){
  for(let i=0;i<30;i++){
    try{
      const info=await requestJSON(api,'/api/version',{timeout:5000});
      if(info.version!==version||info.sourceRef!==sha)throw Error('release identity mismatch');
      for(const name of ['dashboard.js','dashboard.css']){
        const response=await fetch(api+'/'+name+'?v='+version+'-'+sha,{signal:AbortSignal.timeout(5000),redirect:'error'});
        if(!response.ok||!Buffer.from(await response.arrayBuffer()).equals(fs.readFileSync(path.join(packageDir,'dashboard',name))))throw Error('served asset mismatch');
      }
      return info;
    }catch{await sleep(1000);}
  }
  throw Error('Live Dashboard failed exact package verification');
}
const restart=()=>run('serviceman',['restart','--skill',PACKAGE,'--service','daemon','--apply']);
function cleanMain(sha){
  if(git('branch','--show-current')!=='main'||git('status','--porcelain')||git('rev-parse','HEAD')!==sha)
    throw Error('Release requires unchanged clean main checkout');
}
async function release(args){
  const sha=git('rev-parse','HEAD');cleanMain(sha);
  const version=fs.readFileSync(path.join(ROOT,'rust/Cargo.toml'),'utf8').match(/^version = "([^"]+)"/m)?.[1];
  const event=releaseEvent({packageName:PACKAGE,version,sha,jobId:args['job-id']});
  run(process.execPath,['--test','scripts/report-publication.test.mjs','scripts/test-release-native.mjs'],{timeout:60000});cleanMain(sha);
  const link=path.join(args.root,'live'),packageDir=path.join(args.root,'versions',sha);
  const old=fs.realpathSync(link);
  const previous=fs.readFileSync(path.join(old,'SOURCE_REVISION'),'utf8').trim();
  if(!shaPattern.test(previous))throw Error('Installed revision invalid');
  const priorVersion=run(path.join(old,'bin/agents-relay-rust'),['--version'],{capture:true}).trim().split(/\s+/)[1];
  const dashboardPaths=['dashboard','rust/src/dashboard.rs','rust/src/dashboard_api.rs',
    'rust/src/dashboard_data.rs','rust/src/dashboard_publication.rs','rust/src/relayd.rs',
    'rust/src/relayd_sqlite_write.rs','rust/src/publication_store.rs','rust/src/events_bus_runtime.rs',
    'rust/src/runtime_status.rs','rust/src/runtime_summary.rs','rust/tests/native_dashboard_browser.rs','scripts/test-dashboard-browser.sh'];
  if(git('diff','--name-only',previous,sha,'--',...dashboardPaths)){
    run(path.join(ROOT,'scripts/test-dashboard-browser.sh'),[],{timeout:600000});cleanMain(sha);
  }
  if(args['job-id']){
    const db=new DatabaseSync(service().db,{readOnly:true});
    try{
      const row=db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(args['job-id']);
      const job=row&&JSON.parse(row.json);
      if(job?.state!=='COMPLETED'||job.repository!==PACKAGE||!shaPattern.test(job.localMerge?.mergedCommitSha??''))throw Error('Optional Job must be completed and belong to Agents Relay');
      run('git',['merge-base','--is-ancestor',job.localMerge.mergedCommitSha,sha]);
    }finally{db.close();}
  }
  await requestJSON(args['events-api'],releaseHistoryPath(PACKAGE));
  if(git('remote','get-url','origin')!==git('remote','get-url','--push','--all','origin'))throw Error('Origin fetch/push destinations differ');
  run('git',['fetch','origin','main']);run('git',['merge-base','--is-ancestor','origin/main',sha]);
  run('git',['push','origin',sha+':refs/heads/main']);
  if(git('ls-remote','origin','refs/heads/main').split(/\s+/)[0]!==sha)throw Error('Origin main does not match reviewed release');
  let stage;
  try{
    if(!fs.existsSync(packageDir)){
      stage='build native package';
      run('cargo',['build','--locked','--manifest-path','rust/Cargo.toml','--bins'],{timeout:600000});
      cleanMain(sha);
      const target=path.resolve(ROOT,process.env.CARGO_TARGET_DIR||'rust/target');
      run(path.join(ROOT,'scripts/package-rust-runtime.sh'),[path.join(target,'debug'),packageDir]);
    }
    stage=undefined;
    if(fs.readFileSync(path.join(packageDir,'SOURCE_REVISION'),'utf8').trim()!==sha
      ||run(path.join(packageDir,'bin/agents-relay-rust'),['--version'],{capture:true}).trim().split(/\s+/)[1]!==version)throw Error('Packaged identity mismatch');
    if(old!==packageDir){
      checkIdle(args['allow-paused-job']);cleanMain(sha);checkIdle(args['allow-paused-job']);
      stage='native activation';
      switchLink(link,packageDir);
      try{restart();await waitForLive(args.api,packageDir,version,sha);run('npx',['pm2','save']);}
      catch(error){switchLink(link,old);restart();await waitForLive(args.api,old,priorVersion,previous);run('npx',['pm2','save']);throw error;}
    }else await waitForLive(args.api,packageDir,version,sha);
  }catch(error){
    if(stage)try{await publishVerified(args['events-api'],releaseEvent({packageName:PACKAGE,version,sha,stage,jobId:args['job-id']}));}
    catch(reportError){console.error('Publication failure reporting:',reportError.message);}
    throw error;
  }
  // A verified installation remains live if reporting is unavailable.
  const row=await publishVerified(args['events-api'],event);
  const receipts=path.join(args.root,'receipts');fs.mkdirSync(receipts,{recursive:true,mode:0o700});
  const dest=path.join(receipts,sha+'.json'),tmp=dest+'.tmp-'+process.pid;
  try{fs.writeFileSync(tmp,JSON.stringify(row,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,dest);}
  finally{fs.rmSync(tmp,{force:true});}
  console.log(JSON.stringify({version,sha,publication:row},null,2));
}
export async function main(argv=process.argv.slice(2)){
  const {values:args}=parseArgs({args:argv,options:{
    root:{type:'string',default:path.join(os.homedir(),'.local/share/agents-relay')},
    api:{type:'string',default:'http://127.0.0.1:8787'},
    'events-api':{type:'string',default:'http://127.0.0.1:4223'},
    'job-id':{type:'string'},'allow-paused-job':{type:'string',multiple:true,default:[]},help:{type:'boolean'}
  }});
  if(args.help){console.log('release-native.mjs [--root DIR] [--api LOOPBACK] [--events-api LOOPBACK] [--job-id ID] [--allow-paused-job ID]');return;}
  if([args['job-id'],...args['allow-paused-job']].some(id=>id!==undefined&&!/^[1-9][0-9]*$/.test(id)))throw Error('Job IDs must be positive decimal strings');
  args.root=fs.realpathSync(args.root);args.api=loopback(args.api);args['events-api']=loopback(args['events-api']);
  process.umask(0o077);
  // One exclusive SQLite writer transaction is an OS-released lock even
  // after SIGKILL. It is a separate operational file, never the Job DB.
  const lock=new DatabaseSync(path.join(args.root,'.release-lock.sqlite'));
  try{
    lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    await release(args);
  }finally{lock.close();}

}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
