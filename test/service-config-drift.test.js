import test from './test-runtime.js';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,chmodSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const serviceScript=fileURLToPath(new URL('../skills/agents-relay/bin/services.mjs',import.meta.url));
const serviceDefinitions=JSON.parse(readFileSync(serviceScript,'utf8').match(/^const definitions=(.*);$/m)[1]);
const staticEntry=serviceDefinitions.find(e=>e[0]==='daemon');

test('service doctor detects old PM2 daemon argv, even when process is online, without mutating PM2',t=>{
  const root=mkdtempSync(join(tmpdir(),'relay-pm2-config-review-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const fakeNpx=join(root,'npx');
  writeFileSync(fakeNpx,'#!/bin/sh\ncat "$FAKE_PM2_SNAPSHOT"\n');chmodSync(fakeNpx,0o755);
  const desired=staticEntry[2].map(x=>x.replaceAll('__HOME__',root));
  const makeSnapshot=daemonArgs=>JSON.stringify([
    {name:'agents-relay/daemon',pm2_env:{status:'online',pm_exec_path:'/opt/homebrew/bin/npx',args:daemonArgs}},
    {name:'agents-relay/dashboard-tunnel',pm2_env:{status:'online',pm_exec_path:'/opt/homebrew/bin/cloudflared',
      args:serviceDefinitions.find(x=>x[0]==='dashboard-tunnel')[2]}}
  ]);
  const snapshot=join(root,'snapshot.json');
  const run=(mode)=>spawnSync(process.execPath,[serviceScript,mode],{
    encoding:'utf8',timeout:10000,env:{...process.env,HOME:root,PATH:root+':'+process.env.PATH,FAKE_PM2_SNAPSHOT:snapshot}
  });
  writeFileSync(snapshot,makeSnapshot([...desired,'--workspace',root+'/Workspace','--github-webhook-secret-file','/private/key']));
  const bad=run('doctor');
  assert.equal(bad.status,2,bad.stderr);
  const report=JSON.parse(bad.stdout);
  assert.equal(report.services[0].state,'online');
  assert.equal(report.services[0].configuration,'drift');
  assert.equal(report.services[1].configuration,'match');
  assert.match(bad.stderr,/explicitly re-register/);
  const setup=run('setup');
  assert.equal(setup.status,2,'setup must not falsely report successful upgrade of an existing service');
  assert.equal(JSON.parse(setup.stdout).services[0].configuration,'drift');
  writeFileSync(snapshot,makeSnapshot(desired));
  const good=run('doctor');
  assert.equal(good.status,0,good.stderr);
  assert.equal(JSON.parse(good.stdout).services.every(x=>x.configuration==='match'),true);
});
