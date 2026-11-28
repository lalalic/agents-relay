import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
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
  let upstreamSse=new Set(),browserSse=new Set(),streamConnections=0,omitSseFrames=false;
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
      if(req.url==='/events'){
        streamConnections++;upstreamSse.add(incoming);browserSse.add(res);
        incoming.on('close',()=>upstreamSse.delete(incoming));res.on('close',()=>browserSse.delete(res));
        incoming.on('data',chunk=>{if(!omitSseFrames)res.write(chunk);});
        incoming.on('end',()=>res.end());return;
      }
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
    const env={PATH:path.join(fixture,'bin')+path.delimiter+process.env.PATH,HOME:path.join(fixture,'home'),TMPDIR:fixture,
      AGENTS_RELAY_STORE_DIR:path.join(fixture,'forbidden/stores'),
      AGENTS_RELAY_TROUBLESHOOTER_QA_PATH:path.join(fixture,'troubleshooter-qa.md'),
      AGENTS_RELAY_RESOURCE_ROOT:repo,AGENTS_RELAY_WORKFLOW_SOURCE_REF:sha,
      EVENTS_BUS_CONFIG:path.join(fixture,'no-global-events.json')};
    daemon=spawn(binary,['--isolated-write-store-dir',path.join(fixture,'stores'),
      '--workspace-root',fixture,'--port',String(daemonPort),'--interval','100',
      '--event-history-api','http://127.0.0.1:'+busPort+'/'],{cwd:repo,env,stdio:['ignore','ignore','pipe']});
    daemon.stderr.on('data',c=>{daemonLog=(daemonLog+c).slice(-12000);});
    await eventually(async()=>{assert.equal(daemon.exitCode,null,daemonLog);const v=await fetch(base+'/api/version');return v.ok&&(await v.json()).sourceRef===sha;});
  }
  const jobRow=id=>page.locator('.job-row').filter({hasText:new RegExp('/'+id+':')});
  const badge=async(id,label)=>{await jobRow(id).locator('.badge').filter({hasText:new RegExp('^'+label.replaceAll('.','\\.')+'$')}).waitFor({timeout:30000});};
  const jobs=async()=>{const r=await fetch(base+'/api/jobs');assert(r.ok);return (await r.json()).jobs;};
  async function dbPublication(id){const db=new DatabaseSync(path.join(fixture,'relay.sqlite'),{readOnly:true});try{const row=db.prepare('SELECT json FROM publication_state WHERE job_id=?').get(id);return row?JSON.parse(row.json):null;}finally{db.close();}}
  try{
    // Keep the fixture's WAL connection alive for native read-only observers.
    const wal = new DatabaseSync(path.join(fixture,'relay.sqlite'));
    t.after(()=>wal.close());
    await mkdir(path.join(fixture,'bin'),{recursive:true});
    await writeFile(path.join(fixture,'troubleshooter-qa.md'),'# Isolated Troubleshooter guidance\n\nUse current evidence first.\n');
    const fakeCodex=[
      '#!/bin/sh','IFS= read -r init || exit 1',
      `printf '%s\\n' '${JSON.stringify({jsonrpc:'2.0',id:1,result:{}})}'`,
      'IFS= read -r initialized || exit 2','case "$initialized" in *initialized*) ;; *) exit 3;; esac',
      'IFS= read -r query || exit 4','case "$query" in *account/rateLimits/read*) ;; *) exit 5;; esac',
      `printf '%s\\n' '${JSON.stringify({jsonrpc:'2.0',id:2,result:{rateLimits:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:1900000000},secondary:{usedPercent:60,windowDurationMins:10080,resetsAt:1900000100}}}})}'`,
      'sleep 30','',
    ].join('\n');
    const codexFixture=path.join(fixture,'bin','codex');
    await writeFile(codexFixture,fakeCodex);await chmod(codexFixture,0o700);
    await start('a'.repeat(40));
    await eventually(()=>releaseRequests>0,15000);
    chrome=await chromium.launch(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN,headless:true}:{channel:'chrome',headless:true});
    const context=await chrome.newContext({serviceWorkers:'block'});
    page=await context.newPage();
    page.setDefaultTimeout(8000);
    await page.route('**/api/usage',route=>route.fulfill({status:200,
      contentType:'application/json',body:JSON.stringify({providers:[
        {id:'openai',label:'OpenAI',usage:{available:true,
          fiveHour:{usedPercent:25,windowMinutes:300,resetsAt:1900000000},
          weekly:{usedPercent:60,windowMinutes:10080,resetsAt:1900000100}}},
        {id:'zai',label:'Z.ai',usage:{available:false,
          reason:'Usage unavailable in isolated browser fixture.'}},
      ],credits:[{id:'openrouter',label:'OpenRouter',credits:{available:false,
        reason:'No fixture credit balance.'}}]})}));
    await page.clock.install();
    page.on('pageerror',e=>{
      // Playwright clock.install injects a bootstrap into the dashboard's
      // intentionally opaque-origin report iframe. Chrome denies access to
      // navigator.serviceWorker from that sandbox, and the injected clock
      // bootstrap raises a SecurityError before any product code runs.
      // Keep all actual Dashboard and report application errors fatal.
      const clockSandboxError=e.message.startsWith(
        "Failed to read the 'serviceWorker' property from 'Navigator': Service worker is disabled because the context is sandboxed")
        && e.stack?.includes('at <anonymous>:3:15');
      if(!clockSandboxError)errors.push(e.stack||e.message);
    });
    await t.test('1 Job list, repository/status/search filters; 6 slow Events Bus',async()=>{
      const begin=Date.now();
      await page.goto(base,{waitUntil:'domcontentloaded'});
      await jobRow('91').waitFor({timeout:5000});
      const elapsed=Date.now()-begin;
      assert(elapsed<4000,'initial real browser load took '+elapsed+'ms');
      const apiStart=Date.now(),initial=await jobs();
      assert(Date.now()-apiStart<2000,'SQLite list blocked behind release history');
      assert(initial.some(j=>j.id==='91'));
      await jobRow('91').locator('.job-button').click();
      const legacyDetail=await page.locator('#job-detail').innerText();
      for(const label of ['Creator thread','Implementation thread','Reviewer thread']) assert(!legacyDetail.includes(label),label+' leaked into Job detail');
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
    await t.test('transient Jobs and summary failures preserve data and recover automatically',async()=>{
      await page.locator('#runtime-summary .runtime-stat').first().waitFor();
      const before=await page.locator('#runtime-summary').innerText();
      let failJobs=true,failSummary=true;
      await page.route('**/api/jobs?*',route=>failJobs?route.fulfill({status:503,body:'temporary read failure'}):route.continue());
      await page.route('**/api/runtime-summary',route=>failSummary?route.fulfill({status:503,body:'temporary summary failure'}):route.continue());
      await page.locator('#jobs-refresh').click();
      await page.locator('#jobs-feedback').filter({hasText:'Refresh failed'}).waitFor();
      assert.equal(await page.locator('.job-row').count(),6);
      failJobs=false;
      await page.clock.runFor(2200);
      await page.locator('#jobs-feedback').filter({hasText:'Refresh failed'}).waitFor({state:'hidden'});
      await page.waitForFunction(()=>document.querySelector('#runtime-summary')?.dataset.stale==='true');
      assert.equal(await page.locator('#runtime-summary').innerText(),before);
      failSummary=false;
      await page.locator('#jobs-refresh').click();
      await page.waitForFunction(()=>!document.querySelector('#runtime-summary')?.hasAttribute('data-stale'));
      await page.unroute('**/api/jobs?*');await page.unroute('**/api/runtime-summary');
    });
    await t.test('2 mixed running, queued, completed status survives live snapshots',async()=>{
      await badge('91','COMPLETED');await badge('92','RUNNING');await badge('93','QUEUED');
      await page.locator('#jobs-refresh').click();
      await badge('92','RUNNING');await badge('91','COMPLETED');
    });
    await t.test('connected SSE with a missed lifecycle event recovers through inventory refresh',async()=>{
      await eventually(()=>browserSse.size>0);
      await badge('96','DRAFT');const connections=streamConnections;
      omitSseFrames=true;
      try{
        const response=await page.request.post(base+'/api/job-action?id=96&action=cancel');
        assert(response.ok(),await response.text());
        assert.equal((await response.json()).state,'CANCELLED');
        await badge('96','DRAFT');
        await page.clock.fastForward(31000);
        // The default inventory intentionally excludes CANCELLED Jobs.
        await jobRow('96').waitFor({state:'hidden',timeout:8000});
        assert.equal(streamConnections,connections,'must recover without SSE reconnect');
        await page.locator('#status-filter').selectOption('CANCELLED');
        await badge('96','CANCELLED');
      }finally{
        omitSseFrames=false;
        await page.locator('#status-filter').selectOption('');
        await jobRow('91').waitFor();
      }
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
    await t.test('6 Q&A edits reload from Troubleshooter guidance file; Usage shows quota only',async()=>{
      await page.locator('#qa-tab').click();
      await page.locator('#qa-status').filter({hasText:'Loaded'}).waitFor();
      const guidance=page.locator('#qa-text');
      assert.equal(await guidance.inputValue(),'# Isolated Troubleshooter guidance\n\nUse current evidence first.\n');
      const edited='# Isolated Troubleshooter guidance\n\nUse the updated isolated guidance.\n';
      await guidance.fill(edited);await page.locator('#qa-save').click();
      await page.locator('#qa-status').filter({hasText:'Saved to Markdown file'}).waitFor();
      await page.locator('#qa-reload').click();
      await page.locator('#qa-status').filter({hasText:'Loaded'}).waitFor();
      assert.equal(await guidance.inputValue(),edited);
      await page.reload({waitUntil:'domcontentloaded'});
      await page.locator('#qa-tab').click();
      await page.locator('#qa-status').filter({hasText:'Loaded'}).waitFor();
      assert.equal(await page.locator('#qa-text').inputValue(),edited);
      const persisted=await (await page.request.get(base+'/api/troubleshooter-qa')).json();
      assert.equal(persisted.text,edited);
      // A cold cache is explicitly unavailable; retry without displaying fake quota.
      let coldUsage=true;
      await page.route('**/api/usage',route=>coldUsage?route.fulfill({status:502,body:'refreshing'}):route.fallback());
      await page.locator('#usage-tab').click();
      const usage=page.locator('#usage-root');
      await usage.getByText('Usage unavailable:',{exact:false}).waitFor();
      coldUsage=false;
      await page.clock.runFor(2200);
      await usage.locator('.usage-provider h3').filter({hasText:'OpenAI'}).waitFor();
      assert((await usage.innerText()).includes('75%'));
      assert((await usage.innerText()).includes('Resets'));
      assert(!/GitHub|DeepSeek/i.test(await usage.innerText()));
      await page.locator('#jobs-tab').click();
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
      await page.locator('#job-objective-open').click();
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
    await t.test('9 selected Job header layout, details and scoped Report actions',async()=>{
      await jobRow('92').locator('.job-button').click();
      const title=page.locator('#selected-job-title'),objectiveButton=page.locator('#job-objective-open');
      const header=page.locator('#workspace-heading').locator('..');
      assert.equal(await title.textContent(),'Running job');
      assert.equal(await title.getAttribute('title'),'Running job');
      assert.equal(await objectiveButton.count(),1);
      assert.equal(await header.getByRole('button',{name:'Job report',exact:true}).count(),0);
      assert.equal(await page.locator('#job-detail .jel-actions').getByRole('button',{name:'Job report',exact:true}).count(),1);
      for(const label of ['Review head SHA','Task states','Last activity','Project root'])assert.equal(await page.locator('#job-detail').getByText(label,{exact:true}).count(),0,label);
      assert.equal(await page.locator('.job-status-button').count(),0);
      // Render a real long title through the selected-job refresh API.
      const long='Running job '+('with a deliberately long objective '.repeat(12));
      await page.route('**/api/job?*',async route=>{
        const response=await route.fetch();
        const data=await response.json();
        await route.fulfill({response,json:{...data,title:long}});
      });
      await page.locator('#selected-job-refresh').click();
      await eventually(async()=>await title.textContent()===long);
      await page.unroute('**/api/job?*');
      assert.equal(await title.getAttribute('title'),long);
      const original=page.viewportSize();
      for(const width of [1280,430,375,320]){
        await page.setViewportSize({width,height:900});
        await title.waitFor({state:'visible'});
        const layout=await header.evaluate(head=>{
          const t=head.querySelector('#selected-job-title'),r=head.querySelector('#job-objective-open'),f=head.querySelector('#selected-job-refresh');
          const a=t.getBoundingClientRect(),b=r.getBoundingClientRect(),c=f.getBoundingClientRect(),style=getComputedStyle(t);
          return {nowrap:style.whiteSpace,ellipsis:style.textOverflow,clipped:t.scrollWidth>t.clientWidth,
            oneRow:Math.abs((a.top+a.bottom)-(b.top+b.bottom))<2&&Math.abs((b.top+b.bottom)-(c.top+c.bottom))<2,
            ordered:a.right<=b.left&&b.right<=c.left,overflow:document.documentElement.scrollWidth>innerWidth};
        });
        assert.deepEqual(layout,{nowrap:'nowrap',ellipsis:'ellipsis',clipped:true,oneRow:true,ordered:true,overflow:false},'viewport '+width);
      }
      await objectiveButton.focus();await page.keyboard.press('Enter');
      await page.locator('dialog[open]').getByText('Objective',{exact:true}).waitFor();
      await page.keyboard.press('Escape');
      await page.locator('dialog[open]').waitFor({state:'hidden'});
      await page.locator('#mobile-jobs-back').click();
      await page.locator('#job-list').waitFor({state:'visible'});
      await page.setViewportSize(original);
      await jobRow('92').locator('.job-button').click();
      await page.locator('.task-row[data-task-id="921"]').click();
      await page.locator('#task-detail').getByText('Worker threads').waitFor();
      assert.deepEqual(await page.locator('#task-detail .detail-group:has-text("Worker threads") a').evaluateAll(links=>links.map(link=>link.getAttribute('href')).sort()),['codex://threads/38f84f9e-410d-4e36-96e0-a420594a102d','codex://threads/38f84f9e-410d-4e36-96e0-a420594a102e']);
      const requests=[];let fail=false;
      await page.route('**/api/execution-report?*',async route=>{
        const req=route.request(),params=new URL(req.url()).searchParams;
        requests.push([req.method(),params.get('repo'),params.get('job'),params.get('task')]);
        await route.fulfill({status:fail?500:200,json:fail?{error:'Fixture report failure'}:{jobId:params.get('job'),taskId:params.get('task'),capturedAt:'fixture '+requests.length,html:'<h1>Fixture report '+requests.length+'</h1>'}});
      });
      const report=page.locator('#execution-report-dialog');
      const reportButton=page.locator('#job-detail .jel-actions').getByRole('button',{name:'Job report',exact:true});
      const runReport=async button=>{
        await button.click();
        await report.locator('#execution-report-status').filter({hasText:'Captured fixture'}).waitFor();
        assert.equal(await report.frameLocator('iframe').locator('h1').textContent(),'Fixture report '+requests.length);
        await report.locator('#execution-report-close').click();
      };
      await runReport(reportButton);await runReport(reportButton);
      await page.getByText('View JEL chart',{exact:true}).click();
      assert.equal(await page.locator('#graph-dialog').getByRole('button',{name:'Report'}).count(),0);
      await page.locator('#graph-dialog-close').click();
      const taskDetail=page.locator('#task-detail');
      await taskDetail.locator('.task-detail-actions button').first().waitFor();
      assert.equal(await taskDetail.locator('.task-detail-actions button').count(),2);
      for(const label of ['Title','Task ID','Manual override','Planning decision','Planning source','Planning round','PR comment','Conclusion'])assert.equal(await taskDetail.getByText(label,{exact:true}).count(),0,label);
      assert.deepEqual(await taskDetail.locator('.detail-group:has-text("Worker threads") a').evaluateAll(links=>links.map(link=>link.getAttribute('href')).sort()),['codex://threads/38f84f9e-410d-4e36-96e0-a420594a102d','codex://threads/38f84f9e-410d-4e36-96e0-a420594a102e']);
      const taskOriginal=page.viewportSize();
      for(const width of [1280,430,375,320]){
        await page.setViewportSize({width,height:900});
        const layout=await taskDetail.locator('.task-detail-head').evaluate(head=>{const t=head.querySelector('.task-detail-title'),a=head.querySelector('.task-detail-actions'),x=t.getBoundingClientRect(),y=a.getBoundingClientRect();return {nowrap:getComputedStyle(t).whiteSpace,oneRow:Math.abs((x.top+x.bottom)-(y.top+y.bottom))<2,overflow:document.documentElement.scrollWidth>innerWidth};});
        assert.deepEqual(layout,{nowrap:'nowrap',oneRow:true,overflow:false},'task viewport '+width);
      }
      await page.setViewportSize(taskOriginal);
      await runReport(taskDetail.getByRole('button',{name:'Task report',exact:true}));
      await taskDetail.getByRole('button',{name:'Task input and conclusion',exact:true}).click();
      const taskDialog=page.locator('dialog[open]');
      await taskDialog.getByText('Exact fixture task input',{exact:true}).waitFor();
      const conclusion=taskDialog.locator('.dialog-conclusion .dialog-content-body');
      await conclusion.waitFor();
      assert.equal(await conclusion.innerText(),'Durable conclusion fixture\nwith exact whitespace');
      await page.keyboard.press('Escape');
      await page.locator('.task-row[data-task-id="922"]').click();
      assert.equal(await page.locator('#task-detail .detail-group:has-text("Worker threads") a').count(),1,'neo profile exact mapping should resolve to ChatGPT');
      assert.equal(await page.locator('#task-detail .detail-group:has-text("Worker threads") a').getAttribute('href'),'https://chatgpt.com/c/chatgptThread_neo_fixture_2026');
      assert.equal(await page.locator('#task-detail .detail-group:has-text("Worker threads") a').getAttribute('target'),'_blank');
      assert.equal(await page.locator('#task-detail .detail-group:has-text("Worker threads") a').getAttribute('rel'),'noopener noreferrer');
      assert.match(await page.locator('#task-detail .detail-group:has-text("Worker threads") a').innerText(),/ChatGPT thread/);
      await page.locator('#task-detail').getByRole('button',{name:'Task input and conclusion',exact:true}).click();
      assert.equal(await page.locator('dialog[open] .dialog-conclusion').count(),0,'missing conclusion should remain absent on task switch');
      await page.keyboard.press('Escape');
      await page.locator('.task-row[data-task-id="927"]').click();
      assert.equal(await page.locator('#task-detail .detail-group:has-text("Worker threads") a').count(),0,'task without thread identity should remain unavailable after a mapped task');
      assert.equal(await page.locator('#task-detail .detail-group:has-text("Worker threads") .detail-value').innerText(),'—');
      await page.locator('.task-row[data-task-id="924"]').click();
      assert.equal(await page.locator('#task-detail .detail-group:has-text("Worker threads") a').count(),0,'missing mapping must not invent a link');
      assert.equal(await page.locator('#task-detail .detail-group:has-text("Worker threads") .detail-value').innerText(), '—');
      await page.locator('.task-row[data-task-id="925"]').click();
      assert.equal(await page.locator('#task-detail .detail-group:has-text("Worker threads") a').getAttribute('target'),'_blank');
      assert.equal(await page.locator('#task-detail .detail-group:has-text("Worker threads") a').getAttribute('rel'),'noopener noreferrer');
      await page.locator('.task-row[data-task-id="923"]').click();
      assert.equal(await page.locator('#task-detail .detail-group:has-text("Worker threads") a').count(),0,'malformed Codex identities must not produce links');
      assert.equal(await page.locator('#task-detail .detail-group:has-text("Worker threads") .detail-value').innerText(),'—');
      await page.locator('.task-row[data-task-id="925"]').click();
      assert.equal(await page.locator('#task-detail .detail-group:has-text("Worker threads") a').getAttribute('href'),'https://chatgpt.com/c/worker-thread');
      await page.locator('.task-row[data-task-id="926"]').click();
      assert.equal(await page.locator('#task-detail .detail-group:has-text("Worker threads") a').count(),0,'noncanonical ChatGPT URL must not be linked');
      await page.locator('.task-row[data-task-id="921"]').click();
      assert.deepEqual(requests,[['POST','fixture','92',null],['POST','fixture','92',null],['POST','fixture','92','921']]);
      fail=true;await reportButton.click();
      await report.locator('#execution-report-status').filter({hasText:'Fixture report failure'}).waitFor();
      assert.equal(await report.locator('iframe').getAttribute('srcdoc'),null);
      await report.locator('#execution-report-close').click();
      await page.unroute('**/api/execution-report?*');
      // Fresh empty inventory: report and details must not be actionable.
      const emptyInventory=/\/api\/jobs(?:\?|$)/;
      await page.route(emptyInventory,route=>route.fulfill({json:{jobs:[],repositories:[]}}));
      await page.route('**/events',route=>route.abort());
      await page.reload({waitUntil:'domcontentloaded'});
      await page.locator('#job-detail').getByText('No durable jobs discovered.').waitFor();
      assert(await objectiveButton.isDisabled());assert.equal(await page.locator('#job-detail .jel-actions').count(),0);
      assert.equal(await title.getAttribute('title'),null);
      await page.unroute(emptyInventory);
      await page.unroute('**/events');
    });
    assert.deepEqual(errors,[],'browser page errors');
  }catch(error){console.error(daemonLog);if(page)console.error((await page.locator('body').innerText().catch(()=>'' )).slice(0,5000));throw error;}
  finally{await chrome?.close();await stop();await close(proxy);await close(bus);}
});
