import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {LocalAuthorityDurableStore} from '../../dist/local-authority-store.js';
import {InMemoryStore} from '../../dist/store.js';
import {createIsolatedEnvironment} from './harness.mjs';
import {requestTroubleshooterEscalation} from '../../dist/task-recovery.js';
import {deliverPendingEscalations,escalationNotifierFromEnvironment} from '../../dist/escalation-notifier.js';

const stamp='2026-10-20T00:00:00.000Z';
const makeTask=(id,state,parentTaskId=null,agentName='implementation')=>({
 jobId:'notify',id,kind:'work',agentName,adapter:'codex',input:'isolated notification test',
 output:{kind:'task_pr'},parentTaskId,dependencies:[],capabilities:[],state,
 attempt:1,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,
 threadId:null,result:null,error:state==='FAILED'?'Failed execution':null,
 timeoutMs:120000,createdAt:stamp,updatedAt:stamp,
});
async function withEscalation(fn){
 const env=createIsolatedEnvironment('relay-notifier-test-');
 let sqlite=new SQLiteRelayStore(join(env.storeDir,'relay.sqlite'),'notify');
 let store=new LocalAuthorityDurableStore(sqlite,new InMemoryStore(),undefined,true);
 try{
  await store.saveJob({id:'notify',title:'Escalation notifier test',repository:'local/isolated',prNumber:0,state:'ACTIVE',
   executionMode:'fixed',autoMerge:false,reviewEnabled:false,createdAt:stamp,updatedAt:stamp,
   tasks:[makeTask('original','FAILED'),makeTask('troubleshoot-original','QUEUED','original','troubleshooter')]});
  const request=await requestTroubleshooterEscalation(store,'notify','troubleshoot-original',
   {requiredAction:'Authorize provider access',resolutionCondition:'Provider authentication works',context:'Provider login requires human confirmation'});
  assert.equal(request.escalation.notification.status,'pending');
  await fn({store,request,reopen:()=>{
   sqlite.close();
   sqlite=new SQLiteRelayStore(join(env.storeDir,'relay.sqlite'),'notify');
   store=new LocalAuthorityDurableStore(sqlite,new InMemoryStore(),undefined,true);
   return store;
  }});
 }finally{sqlite.close();env.cleanup();}
}
test('configured notifier retry survives crash/restart; only real provider receipt makes delivered',async()=>{
 await withEscalation(async({store,request,reopen})=>{
  const initial=await deliverPendingEscalations(store,'notify',undefined,new Date(stamp));
  assert.equal(initial.pending,1);
  const pending=(await store.load('notify')).tasks[1].escalation.notification;
  assert.equal(pending.status,'pending');assert.match(pending.lastError,/not configured/);
  const sent=[];const deliveryId='provider-message-481';
  let crash=true;
  const notifier=async request=>{
   sent.push(request);
   if(crash){crash=false;throw Error('transport lost after provider accepted request');}
   return {channel:'test-local-notifier',deliveryId,deliveredAt:'2026-10-20T00:02:00.000Z'};
  };
  const first=await deliverPendingEscalations(store,'notify',notifier,new Date(stamp));
  assert.equal(first.failed,1);
  const failed=(await store.load('notify')).tasks[1].escalation.notification;
  assert.equal(failed.status,'pending');assert.equal(failed.attempts,1);
  const notYet=await deliverPendingEscalations(store,'notify',notifier,new Date('2026-10-20T00:00:20.000Z'));
  assert.equal(notYet.pending,1);assert.equal(sent.length,1);
  const nextStore=reopen();
  const retried=await deliverPendingEscalations(nextStore,'notify',notifier,new Date('2026-10-20T00:02:00.000Z'));
  assert.equal(retried.delivered,1);
  assert.equal(sent.length,2);
  assert.deepEqual(sent.map(s=>s.idempotencyKey),Array(2).fill('escalation/'+request.escalation.id));
  const recorded=(await nextStore.load('notify')).tasks[1].escalation.notification;
  assert.equal(recorded.status,'delivered');
  assert.equal(recorded.deliveryId,deliveryId);
  const noRepeat=await deliverPendingEscalations(nextStore,'notify',notifier,new Date('2026-10-20T00:05:00.000Z'));
  assert.deepEqual(noRepeat,{delivered:0,pending:0,failed:0});
  assert.equal(sent.length,2);
 });
});
test('isolated loopback HTTP provider must return actual delivery receipt, not just HTTP success',async()=>{
 const messages=[];
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const part of req)chunks.push(part);
  messages.push({key:req.headers['idempotency-key'],body:JSON.parse(Buffer.concat(chunks).toString())});
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify(messages.length===1?{delivered:true,channel:'fake'}:
   {delivered:true,channel:'isolated-http',deliveryId:'receipt-123',deliveredAt:new Date().toISOString()}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();
  const notifier=escalationNotifierFromEnvironment({AGENTS_RELAY_ESCALATION_NOTIFY_URL:`http://127.0.0.1:${address.port}/notify`});
  assert.ok(notifier);
  await withEscalation(async({store})=>{
   const first=await deliverPendingEscalations(store,'notify',notifier,new Date(stamp));
   assert.equal(first.failed,1);
   assert.equal((await store.load('notify')).tasks[1].escalation.notification.status,'pending');
   const next=await deliverPendingEscalations(store,'notify',notifier,new Date('2026-10-20T00:02:00Z'));
   assert.equal(next.delivered,1);
   assert.equal((await store.load('notify')).tasks[1].escalation.notification.deliveryId,'receipt-123');
  });
  assert.equal(messages.length,2);
  assert.equal(messages[0].key,messages[1].key,'retry must preserve idempotency key');
 }finally{server.close();}
});
test('untrusted notifier destinations are refused before any network access',()=>{
 for(const url of ['http://example.com','file:///etc/passwd','https://user:pass@example.com','https://example.com/#token']){
  assert.throws(()=>escalationNotifierFromEnvironment({AGENTS_RELAY_ESCALATION_NOTIFY_URL:url}));
 }
});
