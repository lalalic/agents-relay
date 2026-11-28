import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { endpoint } from './report-publication.mjs';

export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const PACKAGE='agents-relay',SERVICE='agents-relay/daemon';
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const shaPattern=/^[0-9a-f]{40}$/;
export function run(command,args=[],{capture=false,timeout=120000}={}){
  return execFileSync(command,args,{cwd:ROOT,timeout,maxBuffer:64*1024*1024,
    encoding:'utf8',stdio:capture?['ignore','pipe','inherit']:'inherit'});
}
export const git=(...args)=>run('git',args,{capture:true}).trim();
export function loopback(value){
  const u=new URL(value);
  if(u.protocol!=='http:'||!['127.0.0.1','[::1]','localhost'].includes(u.hostname)||!u.port)
    throw Error('Expected explicit loopback HTTP URL with port');
  return endpoint(value);
}
export function service(){
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
export function cleanMain(sha){
  if(git('branch','--show-current')!=='main'||git('status','--porcelain')||git('rev-parse','HEAD')!==sha)
    throw Error('Release requires unchanged clean main checkout');
}

export function packageIdentity(root,sha){
  if(!shaPattern.test(sha))throw Error('Invalid package SHA');
  const packageDir=path.join(root,'versions',sha);
  if(fs.realpathSync(packageDir)!==packageDir ||
     fs.readFileSync(path.join(packageDir,'SOURCE_REVISION'),'utf8').trim()!==sha)
    throw Error('Packaged identity mismatch');
  const version=run(path.join(packageDir,'bin/agents-relay-rust'),['--version'],{capture:true}).trim().split(/\s+/)[1];
  if(!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version))throw Error('Packaged version invalid');
  return {packageDir,version,sha};
}
export function receiptPath(root,sha){return path.join(root,'receipts',sha+'.json');}
export function publishedPackage(root,sha){
  const pkg=packageIdentity(root,sha);
  const row=JSON.parse(fs.readFileSync(receiptPath(root,sha),'utf8'));
  const event=row.event;
  if(event?.type!=='package.published'||event.event_id!=='release:'+PACKAGE+':'+sha+':package.published'||
     event.source?.id!=='release/'+PACKAGE+'/'+sha||event.data?.package!==PACKAGE||
     event.data.sha!==sha||event.data.version!==pkg.version||event.data.registry!=='native')
    throw Error('Publication receipt does not match package');
  return {...pkg,publication:row};
}
export async function withReleaseLock(root,action){
  process.umask(0o077);
  const lock=new DatabaseSync(path.join(root,'.release-lock.sqlite'));
  try{
    lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    return await action();
  }finally{lock.close();}
}
