import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const fixture=process.env.RELAY_UI_FIXTURE;
const repo=process.env.RELAY_UI_REPO;
const binary=process.env.RELAY_UI_DAEMON;
assert(fixture&&repo&&binary,'Run via cargo test --test native_dashboard_browser -- --ignored');
assert(path.isAbsolute(fixture)&&path.basename(fixture).startsWith('relay-browser-'));
assert((await stat(path.join(fixture,'relay.sqlite'))).isFile());
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;};
const close=async server=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
const eventually=async(fn,ms=12000)=>{const until=Date.now()+ms;let error;do{try{const result=await fn();if(result)return result;}catch(e){error=e;}await wait(100);}while(Date.now()<until);throw error||new Error('condition did not converge');};
const release=(version,sha,timestamp,jobId)=>({cursor:1,event:{version:1,kind:'release',type:'package.published',status:'succeeded',event_id:'release:fixture:'+sha+':package.published',timestamp,source:{id:'release/fixture/'+sha},...(jobId?{job_id:jobId}:{}),data:{package:'fixture',version,sha,registry:'native'}}});

test('Real Chrome / native SQLite Dashboard', {timeout:120000},async t=>{
  let delay=5000,rows=[],history=[],releaseRequests=0,daemon,chrome,page,daemonLog='',daemonPort;
  let upstreamSse=new Set(),browserSse=new Set(),streamConnections=0;
  const bus=createServer((req,res)=>{
    const u=new URL(req.url,'http://localhost');
    const send=data=>{if(res.destroyed)return;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));};
    if(u.pathname==='/events'&&u.searchParams.has('sourcePrefix')){
      releaseRequests++;const sourcePrefix=u.searchParams.get('sourcePrefix');
      const timer=setTimeout(()=>send({order:'desc',events:rows.filter(row=>row.event.source?.id?.startsWith(sourcePrefix))}),delay);
      res.on('close',()=>clearTimeout(timer));return;
    }
    if(u.pathname==='/events'){
      const filter=JSON.parse(u.searchParams.get('filter')),order=u.searchParams.get('order'),after=Number(u.searchParams.get('after')||0);
      const events=history.filter(row=>filter.some(group=>group.every(({path,op,value})=>{const v=path.split('.').reduce((x,k)=>x?.[k],row);return op==='eq'?v===value:typeof v==='string'&&v.startsWith(value)&&(op==='prefix'||!v.slice(value.length).includes('/'));}))&&row.cursor>after).sort((a,b)=>order==='asc'?a.cursor-b.cursor:b.cursor-a.cursor).slice(0,Number(u.searchParams.get('limit')||60));
      return send({order,events,next_cursor:events.length?(order==='asc'?events.at(-1).cursor:events[0].cursor):after});
    }
    res.writeHead(404);res.end();
  });
  const busPort=await listen(bus);
  // A transparent test-only proxy lets the browser keep a stable origin
  // across daemon restarts and lets the test close a real SSE connection.
  const proxy=createServer((req,res)=>{
    const up=request({host:'127.0.0.1',port:daemonPort,path:req.url,method:req.method,headers:req.headers},incoming=>{
      res.writeHead(incoming.statusCode,incoming.headers);
      if(req.url==='/events'){streamConnections++;upstreamSse.add(incoming);browserSse.add(res);incoming.on('close',()=>upstreamSse.delete(incoming));res.on('close',()=>browserSse.delete(res));}
      incoming.pipe(res);
    });
    up.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
    req.pipe(up);res.on('close',()=>up.destroy());
  });
  const proxyPort=await listen(proxy);
  const base='http://127.0.0.1:'+proxyPort;
  const errors=[];
  const dropStream=()=>{for(const s of upstreamSse)s.destroy();for(const s of browserSse)s.destroy();};
  async function stop(){
    dropStream();
    if(!daemon||daemon.exitCode!==null||daemon.signalCode!==null)return;
    const exited=once(daemon,'exit');daemon.kill('SIGTERM');
    await Promise.race([exited,wait(5000)]);if(daemon.exitCode===null&&daemon.signalCode===null){daemon.kill('SIGKILL');await exited;}
  }
  async function start(sha){
    if(!daemonPort){const server=createServer();daemonPort=await listen(server);await close(server);}
    daemonLog='';
    const env={PATH:process.env.PATH,HOME:path.join(fixture,'home'),TMPDIR:fixture,
      AGENTS_RELAY_STORE_DIR:path.join(fixture,'forbidden/stores'),
      AGENTS_RELAY_RESOURCE_ROOT:repo,AGENTS_RELAY_WORKFLOW_SOURCE_REF:sha,
      EVENTS_BUS_CONFIG:path.join(fixture,'no-global-events.json')};
    daemon=spawn(binary,['--isolated-write-store-dir',path.join(fixture,'stores'),
      '--workspace-root',fixture,'--port',String(daemonPort),'--interval','100',
      '--event-history-api','http://127.0.0.1:'+busPort+'/'],{cwd:repo,env,stdio:['ignore','ignore','pipe']});
    daemon.stderr.on('data',c=>{daemonLog=(daemonLog+c).slice(-12000);});
    await eventually(async()=>{assert.equal(daemon.exitCode,null,daemonLog);const v=await fetch(base+'/api/version');return v.ok&&(await v.json()).sourceRef===sha;});
  }
  const jobRow=id=>page.locator('.job-row').filter({hasText:new RegExp('/'+id+':')});
  const badge=async(id,label)=>{await jobRow(id).locator('.badge').filter({hasText:new RegExp('^'+label.replaceAll('.','\\.')+'$')}).waitFor({timeout:15000});};
  const jobs=async()=>{const r=await fetch(base+'/api/jobs');assert(r.ok);return (await r.json()).jobs;};
  async function dbPublication(id){const db=new DatabaseSync(path.join(fixture,'relay.sqlite'),{readOnly:true});try{const row=db.prepare('SELECT json FROM publication_state WHERE job_id=?').get(id);return row?JSON.parse(row.json):null;}finally{db.close();}}
  try{
    // Keep the fixture's WAL connection alive for native read-only observers.
    const wal = new DatabaseSync(path.join(fixture,'relay.sqlite'));
    t.after(()=>wal.close());
    await start('a'.repeat(40));
    await eventually(()=>releaseRequests>0,15000);
    chrome=await chromium.launch(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN,headless:true}:{channel:'chrome',headless:true});
    const context=await chrome.newContext({serviceWorkers:'block'});
    page=await context.newPage();
    page.setDefaultTimeout(8000);
    await page.clock.install();
    page.on('pageerror',e=>errors.push(e.message));
    await t.test('1 Job list, repository/status/search filters; 6 slow Events Bus',async()=>{
      const begin=Date.now();
      await page.goto(base,{waitUntil:'domcontentloaded'});
      await jobRow('91').waitFor({timeout:5000});
      const elapsed=Date.now()-begin;
      assert(elapsed<4000,'initial real browser load took '+elapsed+'ms');
      const apiStart=Date.now(),initial=await jobs();
      assert(Date.now()-apiStart<2000,'SQLite list blocked behind release history');
      assert(initial.some(j=>j.id==='91'));
      assert.equal(await page.locator('.job-row').count(),6);
      await page.locator('#repo-filter').selectOption('fixture');
      await eventually(async()=>await page.locator('.job-row').count()===4);
      await page.locator('#status-filter').selectOption('COMPLETED');
      await eventually(async()=>await page.locator('.job-row').count()===2);
      await page.locator('#status-filter').selectOption('');
      await page.locator('#repo-filter').selectOption('');
      await page.locator('#job-search').fill('Draft fixture');
      await eventually(async()=>await page.locator('.job-row').count()===1);
      await jobRow('96').waitFor();
      await page.locator('#job-search').fill('');
      await eventually(async()=>await page.locator('.job-row').count()===6);
      console.log('initial UI '+elapsed+'ms during slow Events Bus');
    });
    await t.test('2 mixed running, queued, completed status survives live snapshots',async()=>{
      await badge('91','COMPLETED');await badge('92','RUNNING');await badge('93','QUEUED');
      await page.locator('#jobs-refresh').click();
      await badge('92','RUNNING');await badge('91','COMPLETED');
    });
    await t.test('3 jobless publication derives Git ancestry; reject unrelated/stale',async()=>{
      const good=release('2.8.1',process.env.RELAY_UI_MERGED_SHA,'2026-11-25T10:01:00Z');
      delete good.event.kind; delete good.event.status;
      rows=[release('2.8.2',process.env.RELAY_UI_LATER_SHA,'2026-11-25T10:02:00Z'),good,good,
        release('9.9.9',process.env.RELAY_UI_BASE_SHA,'2026-11-25T10:00:30Z'),
        release('2.8.0','2'.repeat(40),'2026-11-25T09:59:00Z')];
      delay=0;
      await badge('91','v2.8.1');await badge('97','v2.8.1');
      assert.equal((await dbPublication('97')).latest.version,'2.8.1');
      assert(!((await jobRow('92').innerText()).includes('v2.8.1')));
      assert(!((await jobRow('91').innerText()).includes(process.env.RELAY_UI_MERGED_SHA)));
      assert.equal((await dbPublication('91')).latest.correlation.kind,'first-observed-ancestor');
      assert.equal((await dbPublication('91')).latest.correlation.mergedCommitSha,process.env.RELAY_UI_MERGED_SHA);
      assert.equal((await dbPublication('91')).latest.version,'2.8.1');
      // A genuine historical Job event, including a package name distinct
      // from the repository, must recover its badge when history is read.
      history=[{cursor:5,event:{version:1,job_id:'92',task_id:'release',type:'package.published',status:'succeeded',event_id:'historical-job-publication',timestamp:'2026-11-25T10:02:00Z',data:{repository:'fixture',package:'@fixture/worker',version:'1.4.0'},visibility:'orchestrator',message:'Published @fixture/worker'}}];
      await jobRow('92').locator('.job-button').click();
      await badge('92','v1.4.0');
      assert.equal((await dbPublication('92')).latest.version,'1.4.0');
    });
    await t.test('4 browser refresh and isolated native daemon restart preserve publication',async()=>{
      await page.reload({waitUntil:'domcontentloaded'});await badge('91','v2.8.1');
      await stop();rows=[];await start('a'.repeat(40));
      await page.reload({waitUntil:'domcontentloaded'});await badge('91','v2.8.1');
      assert.equal((await dbPublication('91')).latest.version,'2.8.1');
    });
    await t.test('5 real SSE disconnect/reconnect recovers new persisted publication',async()=>{
      await eventually(()=>browserSse.size>0);
      const before=streamConnections;dropStream();
      rows=[release('2.8.2','4'.repeat(40),'2026-11-25T10:03:00Z','91')];
      await eventually(()=>streamConnections>before);
      await badge('91','v2.8.2');
    });
    await t.test('7 real revision change reloads Dashboard and versioned assets',async()=>{
      await stop();await start('b'.repeat(40));
      await page.clock.fastForward(31000);
      await page.waitForFunction(()=>window.__RELAY_DASHBOARD_CONFIG?.sourceRef==='b'.repeat(40),null,{timeout:15000});
      assert((await page.locator('script[src*="dashboard.js"]').getAttribute('src')).includes('b'.repeat(40)));
      await badge('91','v2.8.2');
    });
    await t.test('8 existing Dashboard selection/refresh and graph-authorized retry/cancel HTTP actions',async()=>{
      await jobRow('94').locator('.job-button').click();
      await page.locator('#selected-job-refresh').click();
      await page.locator('#job-content-open').click();
      assert((await page.locator('body').innerText()).includes('Retry fixture'));
      await page.keyboard.press('Escape');
      await page.locator('dialog[open]').waitFor({state:'hidden'});
      const result=await page.request.post(base+'/api/task-action?id=94&task=941&action=retry');
      assert(result.ok(),await result.text());
      assert.equal((await result.json()).tasks[0].state,'QUEUED');
      const cancel=await page.request.post(base+'/api/task-action?id=94&task=941&action=cancel');
      assert(cancel.ok(),await cancel.text());
      assert.equal((await cancel.json()).tasks[0].state,'CANCELLED');
      await page.locator('#jobs-refresh').click();
      await eventually(async()=>{const r=await fetch(base+'/api/job?id=94&repo=fixture');return r.ok&&(await r.json()).tasks[0].state==='CANCELLED';});
    });
    assert.deepEqual(errors,[],'browser page errors');
  }catch(error){console.error(daemonLog);if(page)console.error((await page.locator('body').innerText().catch(()=>'' )).slice(0,5000));throw error;}
  finally{await chrome?.close();await stop();await close(proxy);await close(bus);}
});
