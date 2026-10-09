#!/usr/bin/env node
// Controller-owned cancellation for an obsolete/invalid E2E round.
// Marks cancellation as expected before mutating the Job so the watcher exits quietly.
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'../..');
const argv=process.argv.slice(2);
const opt=(name,def='')=>{const i=argv.indexOf('--'+name);return i<0?def:argv[i+1]};
const required=name=>{const v=opt(name);if(!v)throw Error(`--${name} is required`);return v};
const repo=required('repo'),job=required('job'),marker=resolve(required('marker'));
mkdirSync(dirname(marker),{recursive:true});
writeFileSync(marker,JSON.stringify({jobId:job,reason:opt('reason','controller superseded round'),at:new Date().toISOString()},null,2)+'\n');
const p=spawnSync(process.execPath,[resolve(root,'dist/cli.js'),'job','cancel','--repo',repo,'--id',job],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:8e6});
if(p.error||p.status!==0)throw Error(p.error?.message||p.stderr||p.stdout||`job cancel exited ${p.status}`);
console.log(JSON.stringify({status:'cancelled',jobId:job,expectedCancelMarker:marker}));
