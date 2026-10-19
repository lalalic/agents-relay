#!/usr/bin/env node
/** Recomputes Job 481 gate evidence; no untrusted fixture/report input accepted. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {evaluateRecoveryMatrix} from './full-recovery-gates.mjs';
const output=process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(),'relay-recovery-evidence-'));
if(process.argv.length>3)throw Error('Usage: recovery-report.mjs [output-directory]');
const {mkdirSync}=await import('node:fs');
mkdirSync(output,{recursive:true});
const gates=await evaluateRecoveryMatrix();
const counts=Object.fromEntries(['PASS','FAIL','NOT_RUN'].map(status=>[status,gates.filter(x=>x.outcome===status).length]));
const record={schemaVersion:1,job:'481',authority:'Production Reconciler/Graph ingress and isolated SQLite; external effects mocked',counts,gates};
const md=['# Job 481 recovery verification','',`PASS: ${counts.PASS}; FAIL: ${counts.FAIL}; NOT_RUN: ${counts.NOT_RUN}`,'','| Required path | Status | Evidence / blocker |','| --- | --- | --- |',...gates.map(x=>`| ${x.id} | ${x.outcome} | ${(x.reason??x.authority??'').replaceAll('|','/') } |`),'','**Scope:** Two successful L3 paths execute isolated Graph/Reconciler/SQLite. This is not full Job 481 acceptance. L2 real-model runs require independent opt-in and separate evidence.',''];
writeFileSync(join(output,'report.json'),JSON.stringify(record,null,2)+'\n');
writeFileSync(join(output,'report.md'),md.join('\n'));
console.log(JSON.stringify({output,counts},null,2));
if(counts.FAIL)process.exitCode=1;
