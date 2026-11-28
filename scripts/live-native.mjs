#!/usr/bin/env node
// Activate an already published package. Deployment never emits publication events.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {requestJSON} from './report-publication.mjs';
import {PACKAGE,run,git,loopback,sleep,shaPattern,service,publishedPackage,packageIdentity,withReleaseLock} from './native-release-common.mjs';
export function pausedAndQuiescent(job){
  // Pause preserves interrupted execution identity for an eventual resume.
  // Only a CURRENT execution binding means an unfinished running generation;
  // the SQLite execution_process/OS PID gate below still rejects live workers.
  return Boolean(job?.pause?.requestedAt&&Array.isArray(job.tasks)&&Array.isArray(job.plans)
    &&job.tasks.every(t=>!t.executionId)
    &&job.plans.every(p=>!p.executionId));
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

export async function live(args){
  const {packageDir,version,sha}=publishedPackage(args.root,args.sha);
  const link=path.join(args.root,'live');
  const old=fs.realpathSync(link);
  const previous=fs.readFileSync(path.join(old,'SOURCE_REVISION'),'utf8').trim();
  if(args['expected-live-sha']!==undefined&&previous!==args['expected-live-sha']&&previous!==sha)throw Error('Live revision changed; recompute activation target');
  const prior=packageIdentity(args.root,previous);
  if(old!==prior.packageDir)throw Error('Installed package identity mismatch');
  if(old!==packageDir){
    checkIdle(args['allow-paused-job']);
    switchLink(link,packageDir);
    try{restart();await waitForLive(args.api,packageDir,version,sha);run('npx',['pm2','save']);}
    catch(error){switchLink(link,old);restart();await waitForLive(args.api,old,prior.version,previous);run('npx',['pm2','save']);throw error;}
  }else await waitForLive(args.api,packageDir,version,sha);
  console.log(JSON.stringify({version,sha,live:true},null,2));
}
export async function main(argv=process.argv.slice(2)){
  const {values:args}=parseArgs({args:argv,options:{
    root:{type:'string',default:path.join(os.homedir(),'.local/share/agents-relay')},
    api:{type:'string',default:'http://127.0.0.1:8787'},
    sha:{type:'string'},'expected-live-sha':{type:'string'},'allow-paused-job':{type:'string',multiple:true,default:[]},help:{type:'boolean'}
  }});
  if(args.help){console.log('live-native.mjs [--sha SHA (default: HEAD)] [--expected-live-sha SHA] [--root DIR] [--api LOOPBACK] [--allow-paused-job ID]');return;}
  if(args['allow-paused-job'].some(id=>!/^[1-9][0-9]*$/.test(id)))throw Error('Job IDs must be positive decimal strings');
  args.root=fs.realpathSync(args.root);args.api=loopback(args.api);args.sha??=git('rev-parse','HEAD');
  if(args['expected-live-sha']!==undefined&&!shaPattern.test(args['expected-live-sha']))throw Error('Invalid expected live SHA');
  if(!shaPattern.test(args.sha))throw Error('Invalid package SHA');
  await withReleaseLock(args.root,()=>live(args));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
