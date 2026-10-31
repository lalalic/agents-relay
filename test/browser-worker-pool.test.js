import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserWorkerPoolManager, BrowserPoolAdmissionError } from '../dist/browser-worker-pool.js';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function withPool(options,fn){
  const dir=await mkdtemp(join(tmpdir(),'relay-browser-slots-'));
  const path=join(dir,'pool.sqlite');
  const pool=new BrowserWorkerPoolManager({path,...options});
  try {await fn(pool,path);} finally {pool.close();await rm(dir,{recursive:true,force:true});}
}
test('3 fixed slots per adapter; full ChatGPT pool queues without occupying Z capacity',async()=>{
  await withPool({capacity:3,queueWaitMs:500,pollMs:5},async pool=>{
    const leased=await Promise.all(['a','b','c'].map(id=>pool.acquire('chatgpt',id)));
    assert.deepEqual(leased.map(x=>x.slot),[1,2,3]);
    assert.equal(pool.snapshot('chatgpt').idle,0);
    assert.equal(pool.snapshot('z').idle,3);
    const fourth=pool.acquire('chatgpt','d');
    await delay(30);
    assert.equal(pool.snapshot('chatgpt').queued,1);
    pool.release(leased[1]);
    const later=await fourth;
    assert.equal(later.slot,2);
    assert.equal(later.executionId,'d');
    pool.release(leased[0]);pool.release(leased[2]);pool.release(later);
    assert.deepEqual([pool.snapshot('chatgpt').idle,pool.snapshot('chatgpt').queued],[3,0]);
  });
});
test('leases are transactionally exclusive across manager instances and generation-fenced',async()=>{
  await withPool({capacity:1,queueWaitMs:500,pollMs:5},async(first,path)=>{
    const second=new BrowserWorkerPoolManager({path,capacity:1,queueWaitMs:500,pollMs:5});
    try{
      const a=await first.acquire('z','execution-1');
      const awaiting=second.acquire('z','execution-2');
      await delay(30);
      assert.equal(second.snapshot('z').queued,1);
      first.release(a);
      const b=await awaiting;
      assert.equal(a.slot,b.slot);
      assert.ok(b.generation>a.generation);
      assert.throws(()=>first.release(a),/Stale browser pool lease/);
      second.release(b);
    }finally{second.close();}
  });
});
test('queue expiration, circuit breaker, cancellation and independently healthy provider',async()=>{
  await withPool({capacity:1,queueWaitMs:60,pollMs:5},async pool=>{
    const a=await pool.acquire('chatgpt','first');
    await assert.rejects(pool.acquire('chatgpt','second'),error=>error instanceof BrowserPoolAdmissionError&&error.code==='POOL_WAIT_EXPIRED');
    assert.equal(pool.snapshot('chatgpt').queued,0);
    pool.reportPreSubmissionOutage('chatgpt',5000);
    await assert.rejects(pool.acquire('chatgpt','blocked'),error=>error.code==='PROVIDER_UNAVAILABLE');
    assert.equal(pool.snapshot('z').health,'HEALTHY');
    pool.reportHealthy('chatgpt');
    pool.release(a);
    const b=await pool.acquire('chatgpt','new');
    pool.release(b);
  });
});
test('quarantined uncertain delivery never becomes an idle reusable slot',async()=>{
  await withPool({capacity:1,queueWaitMs:25,pollMs:5},async pool=>{
    const a=await pool.acquire('z','uncertain');
    pool.bindSession(a,'webhelm-session');pool.bindThread(a,'https://chat.z.ai/c/thread-123');
    pool.quarantine(a);
    assert.equal(pool.snapshot('z').quarantined,1);
    assert.throws(()=>pool.release(a),/Stale browser pool lease release/);
    await assert.rejects(pool.acquire('z','other'),error=>error.code==='POOL_WAIT_EXPIRED');
    assert.throws(()=>pool.releaseQuarantine(a,false),/verif/);
    pool.releaseQuarantine(a,true);
    const b=await pool.acquire('z','next');
    assert.ok(b.generation>a.generation);
    pool.release(b);
  });
});
test('unsafe cross-site URLs and duplicate execution reuse are rejected',async()=>{
  await withPool({capacity:1},async pool=>{
    const a=await pool.acquire('chatgpt','same');
    assert.throws(()=>pool.bindThread(a,'https://evil.example/c/abc'),/Unsafe/);
    await assert.rejects(pool.acquire('chatgpt','same'),/already owns/);
    pool.release(a);
  });
});

test('cancelled FIFO waiter is removed without stopping another worker',async()=>{
  await withPool({capacity:1,queueWaitMs:300,pollMs:5},async pool=>{
    const owner=await pool.acquire('chatgpt','live-owner');
    const controller=new AbortController();
    const waiting=pool.acquire('chatgpt','cancelled-waiter',controller.signal);
    await delay(20);
    assert.equal(pool.snapshot('chatgpt').queued,1);
    controller.abort();
    await assert.rejects(waiting,/aborted/);
    assert.equal(pool.snapshot('chatgpt').queued,0);
    assert.equal(pool.snapshot('chatgpt').leased,1);
    pool.release(owner);
  });
});
test('process restart preserves lease; only verified stop can heal orphaned resource',async()=>{
  await withPool({capacity:1,queueWaitMs:40,pollMs:5},async(first,path)=>{
    const lease=await first.acquire('z','old-process');
    first.bindSession(lease,'owned-session-from-dead-process');
    const restarted=new BrowserWorkerPoolManager({path,capacity:1,queueWaitMs:40,pollMs:5});
    try{
      assert.equal(restarted.snapshot('z').leased,1,'restart must preserve lease, not duplicate');
      await assert.rejects(restarted.acquire('z','new-process'),error=>error.code==='POOL_WAIT_EXPIRED');
      restarted.quarantine(lease);
      assert.equal(restarted.snapshot('z').quarantined,1);
      assert.throws(()=>restarted.releaseQuarantine(lease,false),/verif/);
      restarted.releaseQuarantine(lease,true); // Independent browser stop verification.
      const newLease=await restarted.acquire('z','recovered-process');
      assert.ok(newLease.generation>lease.generation);
      restarted.release(newLease);
    }finally{restarted.close();}
  });
});

test('cross-process FIFO waiting never exceeds configured max queue capacity',async()=>{
  await withPool({capacity:1,maxQueue:1,queueWaitMs:200,pollMs:5},async(first,path)=>{
    const second=new BrowserWorkerPoolManager({path,capacity:1,maxQueue:1,queueWaitMs:200,pollMs:5});
    try{
      const owner=await first.acquire('chatgpt','owner');
      const waiting=second.acquire('chatgpt','first-waiter');
      await delay(30);
      assert.equal(first.snapshot('chatgpt').queued,1);
      await assert.rejects(first.acquire('chatgpt','overcapacity'),error=>error.code==='POOL_CAPACITY_FULL');
      assert.equal(first.snapshot('chatgpt').queued,1);
      first.release(owner);
      const woke=await waiting;
      assert.equal(woke.executionId,'first-waiter');
      second.release(woke);
      assert.equal(first.snapshot('chatgpt').queued,0);
    }finally{second.close();}
  });
});
