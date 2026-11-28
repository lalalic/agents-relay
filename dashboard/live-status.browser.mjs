import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const chrome=process.env.CHROME_BIN||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const jobs=[
  {id:'91',repository:'fixture',title:'Completed before SSE',state:'COMPLETED',runtimeStatus:'COMPLETED',updatedAt:'2026-11-25T10:00:00Z',tasks:[],plans:[],reviewEnabled:true,publication:null,publicationFailure:null,publicationObservedAt:null},
  {id:'92',repository:'fixture',title:'Completes from SSE',state:'ACTIVE',runtimeStatus:'PLANNING',updatedAt:'2026-11-25T10:00:00Z',tasks:[],plans:[{status:'PLANNING'}],reviewEnabled:true},
];
const eventual={id:'92',repository:'fixture',title:'Completes from SSE',state:'COMPLETED',runtimeStatus:'PLANNING',updatedAt:'2026-11-25T10:01:00Z'};
const publication={package:'fixture',version:'2.0.260',sha:'a'.repeat(40),registry:'native'};
const sourceByPath={
  '/': ['text/html; charset=utf-8',await readFile(path.join(root,'dashboard/index.html'))],
  '/dashboard.css':['text/css; charset=utf-8',await readFile(path.join(root,'dashboard/dashboard.css'))],
  '/dashboard.js':['text/javascript; charset=utf-8',await readFile(path.join(root,'dashboard/dashboard.js'))],
  '/vendor/markdown-it.min.js':['text/javascript; charset=utf-8',await readFile(path.join(root,'dashboard/vendor/markdown-it.min.js'))],
  '/pwa.js':['text/javascript; charset=utf-8',await readFile(path.join(root,'dashboard/pwa.js'))],
  '/manifest.webmanifest':['application/manifest+json',await readFile(path.join(root,'dashboard/manifest.webmanifest'))],
  '/service-worker.js':['text/javascript; charset=utf-8',await readFile(path.join(root,'dashboard/service-worker.js'))],
  '/icons/icon-180.png':['image/png',await readFile(path.join(root,'dashboard/icons/icon-180.png'))],
  '/icons/icon-192.png':['image/png',await readFile(path.join(root,'dashboard/icons/icon-192.png'))],
  '/icons/icon-512.png':['image/png',await readFile(path.join(root,'dashboard/icons/icon-512.png'))],
};
let sseClients=[];
const server=createServer((req,res)=>{
  const url=new URL(req.url||'/',`http://${req.headers.host}`);
  const json=(value)=>{res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  if(url.pathname==='/dashboard-config.js'){
    res.writeHead(200,{'content-type':'text/javascript'});
    res.end("window.__RELAY_DASHBOARD_CONFIG={version:'2.0.260',sourceRef:'"+'a'.repeat(40)+"',statuses:['DRAFT','ACTIVE','COMPLETED']};document.querySelector('.version').textContent='v'+window.__RELAY_DASHBOARD_CONFIG.version;");return;
  }
  if(url.pathname==='/api/version')return json({version:'2.0.260',sourceRef:'a'.repeat(40)});
  if(url.pathname==='/api/jobs')return json({jobs,repositories:['fixture']});
  if(url.pathname==='/api/job'){const job=jobs.find(job=>job.id===url.searchParams.get('id'));if(job?.id==='91'&&url.searchParams.get('repo')==='fixture')Object.assign(job,{publication,publicationObservedAt:'2026-11-25T10:02:00Z'});return json(job||{});}
  if(url.pathname==='/api/events')return json([]);
  if(url.pathname==='/api/status')return json({limited:false});
  if(url.pathname==='/api/runtime-summary')return json({activeJobs:1,runningTasks:1,workers:{}});
  if(url.pathname==='/api/graphs'||url.pathname==='/api/decision-audit')return json([]);
  if(url.pathname==='/api/execution-router-rules')return json({text:'',hash:'none'});
  if(url.pathname==='/api/troubleshooter-qa')return json({text:'',hash:'none'});
  if(url.pathname==='/api/usage')return json({providers:[],credits:[]});
  if(url.pathname==='/events'){
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive'});res.write(': connected\n\n');sseClients.push(res);
    const timer=setTimeout(()=>res.write(`data: ${JSON.stringify({job:eventual})}\n\n`),1800);
    const publishTimer=setTimeout(()=>res.write(`event: relay\ndata: ${JSON.stringify({event:{type:'package.published',data:{jobId:'91',package:'fixture'}}})}\n\n`),1000);
    req.on('close',()=>{clearTimeout(timer);clearTimeout(publishTimer);sseClients=sseClients.filter(client=>client!==res);});return;
  }
  const asset=sourceByPath[url.pathname];
  if(asset){res.writeHead(200,{'content-type':asset[0]});res.end(asset[1]);return;}
  res.writeHead(404);res.end('not found');
});

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let browser,profile;
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
  console.log('browser fixture listening');
  profile=await mkdtemp(path.join(tmpdir(),'relay-dashboard-browser-'));
  browser=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking','--disable-extensions','--disable-sync','--disable-default-apps','--disable-service-autorun','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',detached:true});
  const portFile=path.join(profile,'DevToolsActivePort');let debuggingPort;
  for(let n=0;n<100;n++){try{debuggingPort=Number((await readFile(portFile,'utf8')).split('\n')[0]);break;}catch{await wait(50);}}
  assert.ok(debuggingPort,'Headless Chrome did not expose a DevTools port');
  console.log('headless Chrome ready');
  const targetResponse=await fetch(`http://127.0.0.1:${debuggingPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${server.address().port}/`)}`,{method:'PUT'});
  assert.equal(targetResponse.status,200,'Could not create isolated browser page');
  const target=await targetResponse.json();
  console.log('browser page created');
  const socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let nextId=0;const pending=new Map(),browserErrors=[];
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.method==='Runtime.exceptionThrown')browserErrors.push(message.params.exceptionDetails.text);if(message.method==='Log.entryAdded'&&message.params.entry.level==='error')browserErrors.push(message.params.entry.text);if(message.id&&pending.has(message.id)){pending.get(message.id)(message);pending.delete(message.id);}});
  const send=(method,params={})=>new Promise(resolve=>{const id=++nextId;pending.set(id,resolve);socket.send(JSON.stringify({id,method,params}));});
  await send('Page.enable');await send('Runtime.enable');await send('Log.enable');
  await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});
  console.log('Dashboard loaded; waiting for SSE projection');
  let state;
  for(let n=0;n<30;n++){
    await wait(100);
    const result=await send('Runtime.evaluate',{expression:`(()=>({rows:[...document.querySelectorAll('.job-row')].map(row=>({title:row.querySelector('.job-title')?.textContent||'',badges:row.querySelector('.job-status-line')?.innerText||''}))}))()`,returnByValue:true});
    state=result.result?.result?.value;
    if(state?.rows.some(row=>row.title.includes('Completes from SSE')&&row.badges.includes('PLANNING')))break;
  }
  assert.ok(state?.rows.some(row=>row.title.includes('Completes from SSE')&&row.badges.includes('PLANNING')),'Dashboard list did not render PLANNING');
  await send('Runtime.evaluate',{expression:`(()=>{const row=[...document.querySelectorAll('.job-row')].find(row=>row.innerText.includes('Completes from SSE'));row?.querySelector('.job-button')?.click()})()`});
  const detail=await send('Runtime.evaluate',{expression:`document.querySelector('#job-detail')?.innerText||''`,returnByValue:true});
  assert.match(detail.result?.result?.value||'',/RUNTIME STATUS\s*PLANNING/,'Dashboard detail did not render PLANNING');
  for(let n=0;n<80;n++){
    await wait(100);
    const result=await send('Runtime.evaluate',{expression:`(()=>({version:document.querySelector('.version')?.textContent||'',rows:[...document.querySelectorAll('.job-row')].map(row=>({title:row.querySelector('.job-title')?.textContent||'',badges:row.querySelector('.job-status-line')?.innerText||''})),feedback:document.querySelector('#jobs-feedback')?.textContent||'',listHtml:document.querySelector('#job-list')?.innerHTML||'',navigationCount:performance.getEntriesByType('navigation').length}))()`,returnByValue:true});
    state=result.result?.result?.value;
    if(state?.rows.some(row=>row.title.includes('Completes from SSE')&&row.badges.includes('COMPLETED'))&&state.rows.some(row=>row.title.includes('Completed before SSE')&&row.badges.includes('v2.0.260')))break;
  }
  assert.ok(state?.rows.length===2,`Dashboard did not render both fixture Jobs: ${JSON.stringify({state,browserErrors})}`);
  assert.equal(state.version,'v2.0.260','Header displayed a revision or wrong version');
  const oldComplete=state.rows.find(row=>row.title.includes('Completed before SSE'));
  const liveComplete=state.rows.find(row=>row.title.includes('Completes from SSE'));
  assert.match(oldComplete.badges,/COMPLETED/);assert.doesNotMatch(oldComplete.badges,/IDLE/);
  assert.match(liveComplete.badges,/COMPLETED/);assert.doesNotMatch(liveComplete.badges,/IDLE/);
  assert.match(oldComplete.badges,/v2\.0\.260/,'Associated package.published event refreshed the Job publication badge');
  assert.equal(state.navigationCount,1,'The live status update caused a page reload');
  console.log(JSON.stringify({result:'PASS',browser:'headless Chrome',header:state.version,
    completedStatuses:[oldComplete.badges,liveComplete.badges],liveSseUpdate:true,livePublicationUpdate:true,
    manualRefresh:false,navigationCount:state.navigationCount},null,2));
  socket.close();
}finally{
  for(const client of sseClients)client.destroy();
  server.closeAllConnections?.();
  await new Promise(resolve=>server.close(resolve));
  if(browser&&!browser.killed){
    try{process.kill(-browser.pid,'SIGTERM');}catch{}
    await Promise.race([new Promise(resolve=>browser.once('exit',resolve)),wait(3000)]);
  }
  if(profile)await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:100});
}
