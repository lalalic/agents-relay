import test from './test-runtime.js';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
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
