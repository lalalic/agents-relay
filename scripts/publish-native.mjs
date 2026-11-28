#!/usr/bin/env node
// Build and publish an immutable package without changing the running service.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {requestJSON,releaseEvent,releaseHistoryPath,publishVerified} from './report-publication.mjs';
import {ROOT,PACKAGE,run,git,loopback,shaPattern,service,cleanMain,packageIdentity,receiptPath,withReleaseLock} from './native-release-common.mjs';

export async function publish(args){
  const sha=git('rev-parse','HEAD');cleanMain(sha);
  const version=fs.readFileSync(path.join(ROOT,'rust/Cargo.toml'),'utf8').match(/^version = "([^"]+)"/m)?.[1];
  const event=releaseEvent({packageName:PACKAGE,version,sha,jobId:args['job-id']});
  run(process.execPath,['--test','scripts/report-publication.test.mjs','scripts/test-release-native.mjs'],{timeout:60000});cleanMain(sha);
  const packageDir=path.join(args.root,'versions',sha);
  const dashboardPaths=['dashboard','rust/src/dashboard.rs','rust/src/dashboard_api.rs',
    'rust/src/dashboard_data.rs','rust/src/dashboard_publication.rs','rust/src/relayd.rs',
    'rust/src/relayd_sqlite_write.rs','rust/src/publication_store.rs','rust/src/events_bus_runtime.rs',
    'rust/src/runtime_status.rs','rust/src/runtime_summary.rs','rust/tests/native_dashboard_browser.rs','scripts/test-dashboard-browser.sh',
    'scripts/publish-native.mjs','scripts/live-native.mjs','scripts/native-release-common.mjs','scripts/report-publication.mjs'];

  const history=await requestJSON(args['events-api'],releaseHistoryPath(PACKAGE));
  if(!Array.isArray(history.events))throw Error('Invalid publication history');
  const previous=history.events.find(row=>row.event?.type==='package.published'&&shaPattern.test(row.event?.data?.sha??'')&&row.event.data.sha!==sha)?.event.data.sha;
  // Missing history or Git objects cannot skip the browser gate.
  let needsBrowser=true;
  if(previous){
    try{git('merge-base','--is-ancestor',previous,sha);needsBrowser=Boolean(git('diff','--name-only',previous,sha,'--',...dashboardPaths));}catch{}
  }
  if(needsBrowser){run(path.join(ROOT,'scripts/test-dashboard-browser.sh'),[],{timeout:600000});cleanMain(sha);}
  if(args['job-id']){
    const db=new DatabaseSync(service().db,{readOnly:true});
    try{
      const row=db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(args['job-id']);
      const job=row&&JSON.parse(row.json);
      if(job?.state!=='COMPLETED'||job.repository!==PACKAGE||!shaPattern.test(job.localMerge?.mergedCommitSha??''))throw Error('Optional Job must be completed and belong to Agents Relay');
      run('git',['merge-base','--is-ancestor',job.localMerge.mergedCommitSha,sha]);
    }finally{db.close();}
  }
  if(git('remote','get-url','origin')!==git('remote','get-url','--push','--all','origin'))throw Error('Origin fetch/push destinations differ');
  run('git',['fetch','origin','main']);run('git',['merge-base','--is-ancestor','origin/main',sha]);
  run('git',['push','origin',sha+':refs/heads/main']);
  if(git('ls-remote','origin','refs/heads/main').split(/\s+/)[0]!==sha)throw Error('Origin main does not match reviewed release');
  let stage='build native package';
  try{
    if(!fs.existsSync(packageDir)){
      stage='build native package';
      run('cargo',['build','--locked','--manifest-path','rust/Cargo.toml','--bins'],{timeout:600000});
      cleanMain(sha);
      const target=path.resolve(ROOT,process.env.CARGO_TARGET_DIR||'rust/target');
      run(path.join(ROOT,'scripts/package-rust-runtime.sh'),[path.join(target,'debug'),packageDir]);
    }
    stage='verify native package';
    if(packageIdentity(args.root,sha).version!==version)throw Error('Packaged identity mismatch');
  }catch(error){
    try{await publishVerified(args['events-api'],releaseEvent({packageName:PACKAGE,version,sha,stage,jobId:args['job-id']}));}
    catch(reportError){console.error('Publication failure reporting:',reportError.message);}
    throw error;
  }
  const row=await publishVerified(args['events-api'],event);
  const receipts=path.join(args.root,'receipts');fs.mkdirSync(receipts,{recursive:true,mode:0o700});
  const dest=receiptPath(args.root,sha),tmp=dest+'.tmp-'+process.pid;
  try{fs.writeFileSync(tmp,JSON.stringify(row,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,dest);}
  finally{fs.rmSync(tmp,{force:true});}
  const result={version,sha,publication:row};
  console.log(JSON.stringify(result,null,2));
  return result;
}
export async function main(argv=process.argv.slice(2)){
  const {values:args}=parseArgs({args:argv,options:{
    root:{type:'string',default:path.join(os.homedir(),'.local/share/agents-relay')},
    'events-api':{type:'string',default:'http://127.0.0.1:4223'},
    'job-id':{type:'string'},help:{type:'boolean'}
  }});
  if(args.help){console.log('publish-native.mjs [--root DIR] [--events-api LOOPBACK] [--job-id ID]');return;}
  if(args['job-id']!==undefined&&!/^[1-9][0-9]*$/.test(args['job-id']))throw Error('Job ID must be a positive decimal string');
  args.root=fs.realpathSync(args.root);args['events-api']=loopback(args['events-api']);
  return await withReleaseLock(args.root,()=>publish(args));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
