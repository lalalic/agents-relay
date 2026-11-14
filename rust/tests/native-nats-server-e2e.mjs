import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

const target = process.env.CARGO_TARGET_DIR ?? resolve(import.meta.dirname, '../target');
const cli = join(target, 'debug/relay-native-job');
const daemon = join(target, 'debug/relay-native-daemon');
const helper = join(target, 'debug/relay-worker-helper');
const env = { ...process.env, RELAY_RUST_EXPERIMENTAL_TEST_ONLY: 'isolated-test' };

const available = spawnSync('/usr/bin/which', ['nats-server'], {encoding:'utf8'}).status===0;
test('Native Rust event outbox reaches a real isolated NATS server and subscriber', { skip: !available }, async () => {
  const {connect} = await import('nats');
  const root = mkdtempSync(join(tmpdir(), 'relay-rust-authority-'));
  let server, nc;
  try {
    mkdirSync(join(root,'work'));mkdirSync(join(root,'work/output'));
    writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'test-only');
    writeFileSync(join(root,'work/graph.mmd'),'flowchart TD\nscript[agent:real-script]\n');
    writeFileSync(join(root,'work/input.md'),'test actual native NATS event');
    const worker=join(root,'script.mjs');
    writeFileSync(worker,[
      "import {readFileSync,writeFileSync} from 'node:fs';",
      "const r=JSON.parse(readFileSync(process.env.RELAY_TASK_REQUEST_PATH,'utf8'));",
      "writeFileSync(process.env.RELAY_RESULT_PATH,JSON.stringify({jobId:r.jobId,taskId:r.taskId,executionId:r.executionId,status:'COMPLETED',output:{ok:true}}));",
    ].join('\n'));
    writeFileSync(join(root,'manifest.json'),JSON.stringify({agents:{
      'real-script':{kind:'script',executable:process.execPath,args:[worker]}
    }}));
    const invoke=(bin,args)=>{
      const result=spawnSync(bin,args,{encoding:'utf8',env,timeout:15000});
      assert.equal(result.status,0,result.stderr);
      return JSON.parse(result.stdout.trim());
    };
    const db=join(root,'relay.sqlite');
    invoke(cli,['init','--db',db]);
    const created=invoke(cli,['create','--db',db,'--project-root',join(root,'work'),
      '--graph-file',join(root,'work/graph.mmd'),'--input-file',join(root,'work/input.md'),
      '--output-path',join(root,'work/output/result.json'),'--title','Real NATS',
      '--repository','native-nats','--request-key','native-nats-e2e']);
    invoke(cli,['activate','--db',db,'--job-id',created.jobId]);
    const base=['--once','--db',db,'--manifest',join(root,'manifest.json'),'--helper',helper];
    assert.equal(invoke(daemon,base).report.jobsCompleted,1);

    const selector=createServer();
    await new Promise(resolve=>selector.listen(0,'127.0.0.1',resolve));
    const port=selector.address().port;
    await new Promise(resolve=>selector.close(resolve));
    server=spawn('nats-server',['-a','127.0.0.1','-p',String(port)],{stdio:'ignore'});
    for(let i=0;i<60;i++){
      try{nc=await connect({servers:'127.0.0.1:'+port,timeout:200,maxReconnectAttempts:0});break}
      catch{await new Promise(resolve=>setTimeout(resolve,40))}
    }
    assert.ok(nc,'isolated NATS server failed to start');
    const subscription=nc.subscribe('relay.events.job.'+created.jobId+'.task.completed');
    const arrival=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('NATS observer timed out')),5000);
      (async()=>{
        try{for await(const message of subscription){clearTimeout(timer);resolve(JSON.parse(new TextDecoder().decode(message.data)));break}}
        catch(error){clearTimeout(timer);reject(error)}
      })();
    });
    await nc.flush();
    const published=invoke(daemon,[...base,'--nats-port',String(port)]);
    assert.equal(published.eventsPublished,1);
    const message=await arrival;
    assert.equal(message.type,'task.completed');
    assert.equal(message.job_id,created.jobId);
    assert.equal(message.task_id,'2');
    assert.match(message.event_id,/^[a-f0-9]{64}$/);
    assert.equal(Object.keys(message.data).length,1,'private worker payload is never transported');
    assert.equal(invoke(daemon,[...base,'--nats-port',String(port)]).eventsPublished,0);
    subscription.unsubscribe();
  } finally {
    await nc?.close().catch(()=>{});
    if(server && server.exitCode===null){
      server.kill('SIGTERM');
      await new Promise(resolve=>server.once('exit',resolve));
    }
    rmSync(root,{recursive:true,force:true});
  }
});
