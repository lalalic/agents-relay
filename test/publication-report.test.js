import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { publicationComment, recordPublication, findMergedPullRequest, parseLocalMergeCorrelation } from '../scripts/report-package-published.mjs';
import { parsePackagePublicationMarker } from '../dist/github-webhook.js';

function fakeGitHub(routes) {
  const calls=[];
  const github=async(path,init={})=>{
    calls.push({path,init});
    const key=(init.method||'GET')+' '+path;
    if(!(key in routes)) throw new Error('Unexpected GitHub call '+key);
    const value=routes[key];
    return typeof value==='function'?value(path,init):structuredClone(value);
  };
  return {github,calls};
}

test('publication reporter preserves compatible marker for non-npm channels',()=>{
  const body=publicationComment({packageName:'team-mate-extension',version:'4.7.2',registry:'chrome-web-store:stable',sha:'a'.repeat(40)});
  assert.deepEqual(parsePackagePublicationMarker(body),{
    package:'team-mate-extension',version:'4.7.2',registry:'chrome-web-store:stable',sha:'a'.repeat(40),
  });
});

test('publication reporter correlates merge commit and records exactly one marker',async()=>{
  const sha='b'.repeat(40);
  const {github,calls}=fakeGitHub({
    ['GET /repos/owner/repo/commits/'+sha]:{commit:{message:'ordinary main commit'}},
    ['GET /repos/owner/repo/commits/'+sha+'/pulls']:[{number:42,merged_at:'2026-10-09T00:00:00Z'}],
    'GET /repos/owner/repo/issues/42/comments?per_page=100&page=1':[],
    'POST /repos/owner/repo/issues/42/comments':{},
  });
  const result=await recordPublication({repository:'owner/repo',sha,packageName:'artifact-x',version:'2026.10.9',registry:'github-release'},github);
  assert.deepEqual(result,{recorded:true,pr:42});
  const posted=JSON.parse(calls.find(x=>x.init.method==='POST').init.body).body;
  assert.equal(parsePackagePublicationMarker(posted).version,'2026.10.9');
});

test('publication reporter is idempotent by artifact and exact version',async()=>{
  const sha='c'.repeat(40);
  const marker=publicationComment({packageName:'markcut',version:'3.1.0',registry:'custom:prod',sha});
  const {github,calls}=fakeGitHub({
    ['GET /repos/owner/repo/commits/'+sha]:{commit:{message:'ordinary main commit'}},
    ['GET /repos/owner/repo/commits/'+sha+'/pulls']:[{number:9,merged_at:'2026-10-09T00:00:00Z'}],
    'GET /repos/owner/repo/issues/9/comments?per_page=100&page=1':[{body:marker}],
  });
  assert.deepEqual(await recordPublication({repository:'owner/repo',sha,packageName:'markcut',version:'3.1.0',registry:'custom:prod'},github),{recorded:false,reason:'duplicate',pr:9});
  assert.equal(calls.some(x=>x.init.method==='POST'),false);
});

test('publication reporter supports explicit originating display PR fallback',async()=>{
  const {github}=fakeGitHub({
    'GET /repos/owner/repo/pulls/77':{number:77,state:'closed',merged_at:null},
    'GET /repos/owner/repo/issues/77/comments?per_page=100&page=1':[],
    'POST /repos/owner/repo/issues/77/comments':{},
  });
  const pr=await findMergedPullRequest({repository:'owner/repo',sha:'d'.repeat(40),prNumber:77},github);
  assert.equal(pr.number,77);
  assert.deepEqual(await recordPublication({repository:'owner/repo',sha:'d'.repeat(40),prNumber:77,packageName:'artifact',version:'1',registry:null},github),{recorded:true,pr:77});
});

test('publication reporter refuses uncorrelated publication success',async()=>{
  const sha='e'.repeat(40);
  const {github}=fakeGitHub({
    ['GET /repos/owner/repo/commits/'+sha]:{commit:{message:'ordinary main commit'}},
    ['GET /repos/owner/repo/commits/'+sha+'/pulls']:[],
  });
  assert.deepEqual(await recordPublication({repository:'owner/repo',sha,packageName:'artifact',version:'1',registry:'store'},github),{recorded:false,reason:'no-correlated-publication-target'});
});

test('publication reporter uses local merge metadata and durable issue without any PR',async()=>{
  const sha='f'.repeat(40), source='a'.repeat(40);
  const message=`Agents Relay local merge\n\nAgents-Relay-Source-SHA: ${source}\nAgents-Relay-Job: job-local-publish`;
  assert.deepEqual(parseLocalMergeCorrelation(message),{jobId:'job-local-publish',sourceSha:source,prNumber:null});
  const {github,calls}=fakeGitHub({
    ['GET /repos/owner/repo/commits/'+sha]:{commit:{message}},
    'GET /repos/owner/repo/issues?state=open&per_page=100&page=1':[],
    'POST /repos/owner/repo/issues':{number:101},
    'GET /repos/owner/repo/issues/101/comments?per_page=100&page=1':[],
    'POST /repos/owner/repo/issues/101/comments':{},
  });
  assert.deepEqual(await recordPublication({repository:'owner/repo',sha,packageName:'artifact',version:'2',registry:'store'},github),{recorded:true,jobId:'job-local-publish',issue:101});
  assert.equal(calls.some(call=>call.path.includes('/pulls')),false);
  const posted=JSON.parse(calls.find(call=>call.path.endsWith('/comments')&&call.init.method==='POST').init.body).body;
  assert.equal(JSON.parse(posted.match(/agents-relay:package-published:v1 (\{.*\}) -->/)[1]).jobId,'job-local-publish');
});

test('publication reporter uses display PR directly when local merge metadata includes one',async()=>{
  const sha='1'.repeat(40), source='2'.repeat(40);
  const message=`Agents Relay local merge\n\nAgents-Relay-Source-SHA: ${source}\nAgents-Relay-Job: job-local-pr\nAgents-Relay-Display-PR: 88`;
  const {github}=fakeGitHub({
    ['GET /repos/owner/repo/commits/'+sha]:{commit:{message}},
    'GET /repos/owner/repo/issues/88/comments?per_page=100&page=1':[],
    'POST /repos/owner/repo/issues/88/comments':{},
  });
  assert.deepEqual(await recordPublication({repository:'owner/repo',sha,packageName:'artifact',version:'3',registry:'store'},github),{recorded:true,jobId:'job-local-pr',issue:88,pr:88});
});
