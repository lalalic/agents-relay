import test from './test-runtime.js';
import assert from 'node:assert/strict';
import {archiveDisplayPullRequest} from '../dist/github-pr-archive.js';

test('completed Job closes display PR with a single auditable comment, never a PR merge',async()=>{
 const calls=[];
 const comments=[];
 const client={request:async(path,init={})=>{
   calls.push([path,init.method??'GET']);
   if(path.endsWith('/comments?per_page=100'))return comments;
   if(path.endsWith('/comments')){comments.push(JSON.parse(init.body));return {};}
   if(path.endsWith('/pulls/17')){assert.equal(JSON.parse(init.body).state,'closed');return {};}
   throw Error('unexpected GitHub request '+path);
 }};
 assert.equal(await archiveDisplayPullRequest(client,'owner/repo',17,'job-1','a'.repeat(40),'OPEN'),'archived');
 assert.equal(comments.length,1);
 assert.match(comments[0].body,/Agents Relay local completion: job-1/);
 assert.equal(await archiveDisplayPullRequest(client,'owner/repo',17,'job-1','a'.repeat(40),'OPEN'),'archived');
 assert.equal(comments.length,1);
 assert.equal(calls.filter(([p])=>p.endsWith('/pulls/17')).length,2);
 assert.equal(calls.filter(([p])=>p.includes('/merge')).length,0);
});
test('closed display PR does not issue remote writes',async()=>{
 const client={request:()=>{throw Error('must not call API');}};
 assert.equal(await archiveDisplayPullRequest(client,'owner/repo',17,'job','a'.repeat(40),'CLOSED'),'already_closed');
 assert.equal(await archiveDisplayPullRequest(client,'owner/repo',17,'job','a'.repeat(40),'MERGED'),'already_closed');
});
