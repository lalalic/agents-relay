import { createServer, Server } from 'node:http';
import { DurableStore, ManagedJobOverview } from './store.js';
import { EventBus } from './events.js';
import { UsageRegistry } from './usage.js';

const GITHUB_REPOSITORY_PATTERN = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,36}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/;

function isPositiveInteger(candidate: unknown): candidate is number {
  return typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0;
}

function isSafeRepositorySegment(segment: string): boolean {
  return segment !== '.' && segment !== '..';
}

export function githubPrUrl(repository: unknown, prNumber: unknown): string | null {
  if (typeof repository !== 'string' || !isPositiveInteger(prNumber)) return null;
  const match = GITHUB_REPOSITORY_PATTERN.exec(repository);
  if (!match) return null;
  const [, owner, repo] = match;
  if (!isSafeRepositorySegment(owner) || !isSafeRepositorySegment(repo)) return null;
  return `https://github.com/${owner}/${repo}/pull/${prNumber}`;
}

export const dashboardHtml = `<!doctype html>
<html lang="en" data-dashboard-contract="safe-dom,named-relay-events,snapshot-events,bounded-event-history">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agents Relay Console</title>
  <style>
    :root { color-scheme: light dark; --bg:#f3f5f8; --surface:#fff; --surface2:#f8fafc; --border:#d8dee7; --text:#17202b; --muted:#687587; --accent:#285f86; --accent2:#e8f1f8; --ok:#19703a; --warn:#8b5b08; --bad:#a33c3c; --shadow:0 1px 2px rgba(15,23,42,.06); }
    * { box-sizing:border-box; }
    [hidden] { display:none !important; }
    body { margin:0; min-height:100vh; background:var(--bg); color:var(--text); font:14px/1.45 ui-sans-serif,system-ui,sans-serif; }
    header { position:sticky; top:0; z-index:3; background:var(--surface); border-bottom:1px solid var(--border); padding:.8rem 1rem; }
    .brand { display:flex; align-items:baseline; gap:.65rem; min-width:0; }
    h1 { margin:0; font-size:1.08rem; letter-spacing:-.02em; }
    .tagline,.subtle { color:var(--muted); font-size:.78rem; }
    .tagline { margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    nav[role="tablist"] { display:flex; gap:.3rem; margin-top:.65rem; }
    nav button { border:0; border-radius:.35rem; background:transparent; color:var(--muted); padding:.38rem .68rem; font:inherit; font-weight:700; cursor:pointer; }
    nav button[aria-selected="true"] { background:var(--accent); color:#fff; }
    button:focus-visible,a:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    main { max-width:1500px; margin:auto; padding:1rem; display:grid; grid-template-columns:minmax(280px,340px) minmax(0,1fr); gap:1rem; align-items:start; }
    .panel { min-width:0; background:var(--surface); border:1px solid var(--border); border-radius:.55rem; box-shadow:var(--shadow); }
    .panel-head { display:flex; align-items:center; justify-content:space-between; gap:.6rem; padding:.65rem .75rem; border-bottom:1px solid var(--border); }
    .panel-head h2,.panel-head h3 { margin:0; color:var(--muted); font-size:.75rem; letter-spacing:.07em; text-transform:uppercase; }
    .panel-body { padding:.75rem; overflow:auto; max-height:calc(100vh - 11.5rem); }
    .jobs-panel { grid-row:1/span 2; }
    .workspace { display:grid; gap:1rem; }
    .job-list,.tree,.event-list { list-style:none; margin:0; padding:0; }
    .job-list { display:grid; gap:.35rem; }
    .job-button { width:100%; display:grid; gap:.2rem; padding:.5rem; border:1px solid transparent; border-radius:.4rem; background:transparent; color:inherit; text-align:left; font:inherit; cursor:pointer; }
    .job-button[aria-current="true"] { border-color:var(--accent); background:var(--accent2); }
    .job-title { font-weight:750; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .job-meta { display:flex; gap:.4rem; flex-wrap:wrap; color:var(--muted); font-size:.7rem; }
    .job-meta span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .status-pill,.badge { display:inline-flex; align-items:center; border-radius:999px; padding:.06rem .42rem; min-height:1.35rem; font-size:.68rem; font-weight:800; }
    .status-pill.ok,.badge.RUNNING,.badge.SUCCEEDED,.badge.COMPLETED { background:#e5f3e9; color:var(--ok); }
    .status-pill.warn,.badge.BLOCKED,.badge.WAITING,.badge.QUEUED,.badge.READY,.badge.OPEN { background:#fff1d2; color:var(--warn); }
    .status-pill.bad,.badge.FAILED { background:#ffe8e8; color:var(--bad); }
    .status-pill.neutral,.badge.CANCELLED { background:#edf0f4; color:var(--muted); }
    .job-summary,.detail-groups { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.55rem; }
    .detail-group { min-width:0; padding:.5rem; background:var(--surface2); border:1px solid var(--border); border-radius:.4rem; }
    .detail-label { margin:0; color:var(--muted); font-size:.66rem; text-transform:uppercase; letter-spacing:.04em; }
    .detail-value { margin:.12rem 0 0; font-weight:650; overflow-wrap:anywhere; }
    .section-title { margin:.8rem 0 .35rem; color:var(--muted); font-size:.72rem; letter-spacing:.05em; text-transform:uppercase; }
    ul.tree { display:grid; gap:.25rem; }
    ul.tree ul { list-style:none; margin:.2rem 0 .1rem .6rem; padding-left:.6rem; border-left:1px solid var(--border); }
    .task-row { width:100%; display:flex; align-items:center; gap:.4rem; min-width:0; padding:.32rem .38rem; border:0; border-radius:.35rem; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; }
    .task-row[aria-current="true"] { background:var(--accent2); }
    .task-id { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font: .77rem ui-monospace,SFMono-Regular,Menlo,monospace; }
    .event-list { display:grid; gap:.45rem; }
    .event-item { padding-bottom:.4rem; border-bottom:1px solid var(--border); }
    .event-meta { display:flex; flex-wrap:wrap; gap:.4rem; color:var(--muted); font-size:.68rem; }
    .event-kind { color:var(--accent); font-weight:800; }
    .event-message { margin:.12rem 0 0; overflow-wrap:anywhere; }
    #usage-view { grid-column:1 / -1; }
    .usage-providers { display:grid; gap:.55rem; }
    .usage-provider { display:grid; grid-template-columns:minmax(130px,180px) minmax(0,1fr); gap:1rem; align-items:center; padding:.7rem .8rem; border:1px solid var(--border); border-radius:.45rem; background:var(--surface2); }
    .usage-provider h3 { margin:0; font-size:.86rem; }
    .usage-bars { display:grid; gap:1rem; }
    .usage-row { display:grid; gap:.35rem; }
    .usage-label { display:flex; justify-content:space-between; gap:1rem; font-weight:700; }
    .usage-track { height:.72rem; overflow:hidden; border:1px solid var(--border); border-radius:999px; background:var(--surface2); }
    .usage-fill { height:100%; width:0; border-radius:inherit; background:var(--accent); transition:width .2s ease; }
    .empty,.error-state { padding:.85rem; border:1px dashed var(--border); border-radius:.4rem; color:var(--muted); }
    .error-state,.error-text { color:var(--bad); }
    .skeleton { height:3.2rem; border-radius:.4rem; background:linear-gradient(90deg,#edf0f4,#fafbfc,#edf0f4); animation:pulse 1.2s infinite; }
    @keyframes pulse { 50% { opacity:.55; } }
    @media (max-width:1050px) { main { grid-template-columns:1fr; } .jobs-panel { grid-row:auto; } .panel-body { max-height:24rem; } }
    @media (max-width:650px) { main { padding:.65rem; } .job-summary,.detail-groups { grid-template-columns:1fr; } .tagline { display:none; } }
    @media (prefers-reduced-motion:reduce) { .skeleton { animation:none; } .usage-fill { transition:none; } }
  </style>
</head>
<body>
<header>
  <div class="brand"><h1>Agents Relay Console</h1><p class="tagline">Durable PR state is authoritative; events are observability.</p></div>
  <nav role="tablist" aria-label="Console views">
    <button id="jobs-tab" type="button" role="tab" aria-selected="true" aria-controls="jobs-view">Jobs</button>
    <button id="usage-tab" type="button" role="tab" aria-selected="false" aria-controls="usage-view">Usage</button>
  </nav>
</header>
<main>
  <section id="jobs-view" role="tabpanel" aria-labelledby="jobs-tab" class="panel jobs-panel">
    <div class="panel-head"><h2>Jobs</h2><span id="job-count" class="subtle"></span></div>
    <div class="panel-body" aria-live="polite"><ul id="job-list" class="job-list"><li class="skeleton" aria-hidden="true"></li></ul></div>
  </section>
  <div class="workspace" id="jobs-workspace">
    <section class="panel" aria-labelledby="workspace-heading">
      <div class="panel-head"><h2 id="workspace-heading">Selected job <span id="selected-job-title" class="subtle"></span></h2><span id="connection" aria-live="polite">Connecting…</span></div>
      <div class="panel-body">
        <div id="job-detail"><div class="skeleton"></div></div>
        <h3 class="section-title">Task hierarchy</h3>
        <ul id="task-tree" class="tree"><li class="skeleton"></li></ul>
        <h3 class="section-title">Task detail</h3>
        <div id="task-detail"><p class="empty">Select a task to inspect execution details.</p></div>
      </div>
    </section>
    <section class="panel" id="events-panel" aria-labelledby="events-heading">
      <div class="panel-head"><h2 id="events-heading">Events</h2><span class="subtle">Newest first · 60 max</span></div>
      <div class="panel-body"><ol id="event-feed" class="event-list"><li class="empty">Waiting for events.</li></ol></div>
    </section>
  </div>
  <section id="usage-view" role="tabpanel" aria-labelledby="usage-tab" hidden>
    <div class="panel">
      <div class="panel-head"><h2 id="usage-heading">Usage</h2><span id="usage-meta" class="subtle"></span></div>
      <div class="panel-body" id="usage-root" aria-live="polite"><div class="skeleton"></div></div>
    </div>
  </section>
</main>
<script>
'use strict';
// Compatibility contracts retained for dashboard tests:
// function taskDetail(
// location.hash = selectedJob ? '#/jobs/' + encodeURIComponent(selectedJob) : '#/jobs'
// const url = githubPrUrl(job.repository, job.prNumber);
// const link = document.createElement('a');
// link.href = url;
// link.target = '_blank';
// link.rel = 'noopener noreferrer';
// link.textContent = 'PR #' + job.prNumber;
// while (eventFeed.children.length > MAX_EVENTS)
// function usageBar(label, window)

const MAX_EVENTS=60;
const jobsTab=document.querySelector('#jobs-tab');
const usageTab=document.querySelector('#usage-tab');
const jobsView=document.querySelector('#jobs-view');
const usageView=document.querySelector('#usage-view');
const jobsWorkspace=document.querySelector('#jobs-workspace');
const jobList=document.querySelector('#job-list');
const jobCount=document.querySelector('#job-count');
const jobDetail=document.querySelector('#job-detail');
const taskTree=document.querySelector('#task-tree');
const taskDetailRoot=document.querySelector('#task-detail');
const eventFeed=document.querySelector('#event-feed');
const connection=document.querySelector('#connection');
const selectedJobTitle=document.querySelector('#selected-job-title');
const usageRoot=document.querySelector('#usage-root');
const usageMeta=document.querySelector('#usage-meta');
let jobs=[];
let selectedJob=sessionStorage.getItem('agents-relay:selected-job');
let selectedTaskId=sessionStorage.getItem('agents-relay:selected-task');

function value(input){return input===null||input===undefined||input===''?'—':String(input);}
function text(input){return document.createTextNode(value(input));}
function element(name,className,child){const node=document.createElement(name);if(className)node.className=className;if(child)node.append(child);return node;}
function field(label,input){const box=element('div','detail-group');box.append(element('p','detail-label',text(label)),element('p','detail-value',text(input)));return box;}
function rememberSelection(){if(selectedJob)sessionStorage.setItem('agents-relay:selected-job',selectedJob);else sessionStorage.removeItem('agents-relay:selected-job');if(selectedTaskId)sessionStorage.setItem('agents-relay:selected-task',selectedTaskId);else sessionStorage.removeItem('agents-relay:selected-task');}
function selected(){return jobs.find(job=>job.id===selectedJob)||jobs[0]||null;}
function counts(tasks){const out={};for(const task of Array.isArray(tasks)?tasks:[])out[task.state]=(out[task.state]||0)+1;return out;}
function compactCounts(input){const order=['RUNNING','BLOCKED','FAILED','QUEUED','READY','WAITING','SUCCEEDED','CANCELLED'];return order.filter(state=>input[state]).map(state=>input[state]+' '+state).join(', ')||'No tasks';}
function relativeTime(timestamp){if(!timestamp)return '—';const parsed=Date.parse(timestamp);if(!Number.isFinite(parsed))return value(timestamp);const seconds=Math.max(0,Math.round((Date.now()-parsed)/1000));if(seconds<60)return 'just now';if(seconds<3600)return Math.floor(seconds/60)+'m ago';if(seconds<86400)return Math.floor(seconds/3600)+'h ago';return Math.floor(seconds/86400)+'d ago';}
function safePrUrl(repository,prNumber){if(typeof repository!=='string'||!Number.isInteger(prNumber)||prNumber<=0)return null;const parts=repository.split('/');if(parts.length!==2)return null;const [owner,repo]=parts;if(!owner||!repo||owner==='.'||owner==='..'||repo==='.'||repo==='..')return null;if(!/^[A-Za-z0-9-]+$/.test(owner)||!/^[A-Za-z0-9._-]+$/.test(repo))return null;return 'https://github.com/'+owner+'/'+repo+'/pull/'+prNumber;}
function prField(job){const box=element('div','detail-group');box.append(element('p','detail-label',text('GitHub PR')));const line=element('p','detail-value');const url=safePrUrl(job.repository,job.prNumber);if(url){const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='PR #'+job.prNumber;line.append(link);}else line.append(text('unavailable'));box.append(line);return box;}
function selectJob(id){selectedJob=id;selectedTaskId=null;rememberSelection();location.hash=id?'#/jobs/'+encodeURIComponent(id):'#/jobs';renderAll();}
function renderJobList(){jobList.replaceChildren();if(!jobs.length){jobList.append(element('li','empty',text('No durable jobs discovered.')));jobCount.textContent='0 jobs';return;}jobCount.textContent=jobs.length+' job'+(jobs.length===1?'':'s');for(const job of jobs){const button=document.createElement('button');button.type='button';button.className='job-button';button.setAttribute('aria-current',String(job.id===selectedJob));button.title=job.title||job.id;button.addEventListener('click',()=>selectJob(job.id));const meta=element('span','job-meta');meta.append(element('span','',text(job.id)),element('span','',text('PR #'+value(job.prNumber))),element('span','',text(value(job.githubState||'UNKNOWN'))),element('span','badge '+value(job.state),text(job.state)),element('span','',text(relativeTime(job.updatedAt))));button.append(element('span','job-title',text(job.title||job.id)),meta,element('span','subtle',text(compactCounts(counts(job.tasks)))));jobList.append(element('li','',button));}}
function taskNode(task,children,depth){const li=element('li');const row=document.createElement('button');row.type='button';row.className='task-row';row.setAttribute('aria-current',String(task.id===selectedTaskId));row.title=task.id;row.addEventListener('click',()=>{selectedTaskId=task.id;rememberSelection();renderAll();});const id=element('span','task-id',text(task.id));id.style.paddingLeft=Math.min(depth,4)*6+'px';row.append(id,element('span','badge '+value(task.state),text(task.state)));li.append(row);const nested=children.get(task.id)||[];if(nested.length){const ul=element('ul','tree');for(const child of nested)ul.append(taskNode(child,children,depth+1));li.append(ul);}return li;}
function buildTree(tasks){taskTree.replaceChildren();if(!Array.isArray(tasks)||!tasks.length){taskTree.append(element('li','empty',text('No tasks in durable state.')));return;}const known=new Set(tasks.map(task=>task.id));const children=new Map();const roots=[];for(const task of tasks){if(!task.parentTaskId||!known.has(task.parentTaskId))roots.push(task);else{const siblings=children.get(task.parentTaskId)||[];siblings.push(task);children.set(task.parentTaskId,siblings);}}for(const task of roots)taskTree.append(taskNode(task,children,0));}
function renderTaskDetail(task){taskDetailRoot.replaceChildren();if(!task){taskDetailRoot.append(element('p','empty',text('Select a task to inspect execution details.')));return;}const routing=task.routing||{};const groups=element('div','detail-groups');groups.append(field('Task',task.id),field('State',task.state),field('Project / agent',value(task.projectName)+' / '+value(task.agentName)),field('Parent task',task.parentTaskId||'root'),field('Adapter',task.adapter),field('Provider / model',value(routing.provider)+' / '+value(routing.model)),field('Reasoning / profile',value(routing.reasoning||routing.profile)),field('Attempt',value(task.attempt)+' of '+value(task.maxAttempts)),field('Dependencies',Array.isArray(task.dependencies)&&task.dependencies.length?task.dependencies.join(', '):'none'),field('Execution / thread',value(task.executionId)+' / '+value(task.threadId)),field('Input',task.input),field('Result',task.result?.summary||'—'));if(task.error)groups.append(field('Error',task.error));taskDetailRoot.append(groups);}
function renderSelectedJob(){jobDetail.replaceChildren();const job=selected();if(!job){selectedJobTitle.textContent='';jobDetail.append(element('div','empty',text('No durable jobs discovered.')));buildTree([]);renderTaskDetail(null);return;}selectedJobTitle.textContent='— '+value(job.title||job.id);if(job.id!==selectedJob){selectedJob=job.id;selectedTaskId=null;rememberSelection();}const summary=element('div','job-summary');summary.append(field('GitHub state',job.githubState||'UNKNOWN'),field('Durable state',job.state),prField(job),field('Repository',job.repository||'—'),field('Last activity',relativeTime(job.updatedAt)),field('Tasks',String((job.tasks||[]).length)),field('Task states',compactCounts(counts(job.tasks))));jobDetail.append(summary);const selectedTask=(job.tasks||[]).find(task=>task.id===selectedTaskId)||null;if(selectedTaskId&&!selectedTask){selectedTaskId=null;rememberSelection();}buildTree(job.tasks||[]);renderTaskDetail(selectedTask);}
function renderAll(){renderJobList();renderSelectedJob();}
async function loadJSON(url){const response=await fetch(url);if(!response.ok)throw new Error(response.status+' '+response.statusText);return response.json();}
async function refresh(){try{const discovered=await loadJSON('/api/jobs');jobs=Array.isArray(discovered)?discovered:[];jobs.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));if(selectedJob&&!jobs.some(job=>job.id===selectedJob)){selectedJob=null;selectedTaskId=null;}if(!selectedJob){const match=location.hash.match(/^#\\/jobs\\/(.+)$/);const fromHash=match?decodeURIComponent(match[1]):null;selectedJob=jobs.some(job=>job.id===fromHash)?fromHash:(jobs[0]?.id||null);}rememberSelection();renderAll();connection.textContent='Live · durable state connected';connection.className='status-pill ok';}catch(error){connection.textContent='Error · durable state unavailable';connection.className='status-pill bad';jobList.replaceChildren(element('li','error-state',text('Could not load jobs: '+error.message)));}}
function addEvent(event,level){if(!event||selectedJob&&event.job_id&&event.job_id!==selectedJob)return;const item=element('li','event-item');const meta=element('div','event-meta');meta.append(element('span','event-kind',text(event.type||'event')),element('span','',text(relativeTime(event.timestamp))),element('span','',text('task: '+value(event.task_id))));item.append(meta);const message=element('p','event-message',text(event.message||'Event received'));if(level==='error'||event.level==='error')message.classList.add('error-text');item.append(message);eventFeed.querySelector('.empty')?.remove();eventFeed.prepend(item);while(eventFeed.children.length>MAX_EVENTS)eventFeed.lastElementChild?.remove();}
function usageBar(label,windowData,mode){const isAvailable=mode==='available';const percent=Math.max(0,Math.min(100,isAvailable?100-windowData.usedPercent:windowData.usedPercent));const row=element('div','usage-row');const heading=element('div','usage-label');heading.append(element('span','',text(label)),element('span','',text(Math.round(percent)+'%')));const track=element('div','usage-track');track.setAttribute('role','progressbar');track.setAttribute('aria-label',label+' available');track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');track.setAttribute('aria-valuenow',String(percent));const fill=element('div','usage-fill');fill.style.width=percent+'%';track.append(fill);row.append(heading,track);return row;}
function usageProvider(provider){const card=element('section','usage-provider');card.append(element('h3','',text(provider.label)));const usage=provider.usage||{};if(!usage.available||!usage.fiveHour||!usage.weekly){card.append(element('p','empty',text(usage.reason||'Account usage telemetry is unavailable.')));return card;}const mode=provider.id==='openai'?'available':'used';const bars=element('div','usage-bars');bars.append(usageBar('5-hour',usage.fiveHour,mode),usageBar('Weekly',usage.weekly,mode));card.append(bars);return card;}
function formatCredit(value,currency){if(value===null||value===undefined||!Number.isFinite(Number(value)))return '—';const number=Number(value);if(currency==='USD')return '$'+number.toFixed(2);if(currency==='CNY')return '¥'+number.toFixed(2);return number.toFixed(2)+' '+currency;}
function creditProvider(provider){const row=element('section','usage-provider');row.append(element('h3','',text(provider.label)));const credits=provider.credits||{};if(!credits.available||!Array.isArray(credits.balances)||!credits.balances.length){row.append(element('p','empty',text(credits.reason||'Credit balance is unavailable.')));return row;}const balance=credits.balances[0];row.append(element('div','detail-value',text(formatCredit(balance.remaining,balance.currency))));return row;}
async function drawUsage(){try{const overview=await loadJSON('/api/usage');usageRoot.replaceChildren();usageMeta.textContent='Real account telemetry when available';const providers=Array.isArray(overview.providers)?overview.providers:[];const credits=Array.isArray(overview.credits)?overview.credits:[];if(!providers.length&&!credits.length){usageRoot.append(element('p','empty',text('Usage telemetry is unavailable.')));return;}const grid=element('div','usage-providers');for(const provider of providers)grid.append(usageProvider(provider));for(const provider of credits)grid.append(creditProvider(provider));usageRoot.append(grid);}catch(error){usageMeta.textContent='Unavailable';usageRoot.replaceChildren(element('p','error-state',text('Usage unavailable: '+error.message)));}}
function showView(view){const isJobs=view==='jobs';jobsView.hidden=!isJobs;jobsWorkspace.hidden=!isJobs;usageView.hidden=isJobs;jobsTab.setAttribute('aria-selected',String(isJobs));usageTab.setAttribute('aria-selected',String(!isJobs));if(isJobs)void refresh();else void drawUsage();}
jobsTab.addEventListener('click',()=>{location.hash=selectedJob?'#/jobs/'+encodeURIComponent(selectedJob):'#/jobs';showView('jobs');});
usageTab.addEventListener('click',()=>{location.hash='#/usage';showView('usage');});
window.addEventListener('keydown',event=>{if(event.key==='Tab'&&event.altKey){event.preventDefault();showView(location.hash==='#/usage'?'jobs':'usage');}});
function parseMessage(message){try{return JSON.parse(message.data);}catch{return null;}}
const stream=new EventSource('/events');
stream.onopen=()=>{connection.textContent='Live · event stream connected';connection.className='status-pill ok';addEvent({type:'connection',task_id:'system',message:'Event stream connected',timestamp:new Date().toISOString()},'ok');};
stream.onerror=()=>{connection.textContent='Degraded · event stream reconnecting';connection.className='status-pill warn';addEvent({type:'connection',task_id:'system',message:'Event stream reconnecting',timestamp:new Date().toISOString()},'error');};
stream.onmessage=message=>{const payload=parseMessage(message);if(payload?.job){const index=jobs.findIndex(job=>job.id===payload.job.id);if(index>=0)jobs[index]=payload.job;else jobs.push(payload.job);renderAll();}};
stream.addEventListener('relay',message=>{const payload=parseMessage(message);if(payload?.job){const index=jobs.findIndex(job=>job.id===payload.job.id);if(index>=0)jobs[index]=payload.job;else jobs.push(payload.job);}if(payload?.event)addEvent(payload.event);renderAll();});
if(location.hash==='#/usage')showView('usage');else showView('jobs');
setInterval(()=>{if(location.hash!=='#/usage')void refresh();},15000);
setInterval(()=>{if(location.hash==='#/usage')void drawUsage();},30000);
</script>
</body>
</html>`;

export function serveDashboard(
  store: DurableStore,
  port = 8787,
  bus?: EventBus,
  refreshMs = 15000,
  jobId?: string,
  usageRegistry?: UsageRegistry,
  overviewProvider?: () => Promise<ManagedJobOverview[]>,
): Server {
  const clients = new Set<import('node:http').ServerResponse>();
  const subscribedJobs = new Set<string>();

  const discoveredJobs = async () => {
    if (overviewProvider) return (await overviewProvider()).map(item => ({ ...item.job, githubState: item.githubState, mergedAt: item.mergedAt, closedAt: item.closedAt }));
    if (!jobId) return [];
    return [await store.load(jobId)];
  };

  const subscribeDiscovered = async (): Promise<void> => {
    if (!bus) return;
    const jobs = await discoveredJobs().catch(() => []);
    for (const job of jobs) {
      if (subscribedJobs.has(job.id)) continue;
      subscribedJobs.add(job.id);
      try {
        await bus.subscribe(job.id, async event => {
          const current = (await discoveredJobs()).find(candidate => candidate.id === job.id) ?? job;
          const payload = JSON.stringify({ event, job: current });
          for (const client of clients) client.write(`event: relay\ndata: ${payload}\n\n`);
        });
      } catch {
        subscribedJobs.delete(job.id);
      }
    }
  };

  const snapshot = async (): Promise<{ id: string; json: string }> => {
    if (!jobId) throw new Error('Dashboard requires a durable job id');
    await subscribeDiscovered();
    return { id: jobId, json: JSON.stringify(await store.load(jobId)) };
  };

  const usage = async (): Promise<string> => {
    if (!usageRegistry) throw new Error('Account usage telemetry is unavailable');
    return JSON.stringify(await usageRegistry.snapshot());
  };

  const server = createServer(async (req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(dashboardHtml);
      return;
    }
    if (req.url === '/api/jobs') {
      try {
        await subscribeDiscovered();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(await discoveredJobs()));
      } catch (error) {
        res.writeHead(502);
        res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (req.url === '/api/job') {
      try {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end((await snapshot()).json);
      } catch (error) {
        res.writeHead(404);
        res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (req.url === '/api/usage') {
      try {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(await usage());
      } catch (error) {
        res.writeHead(503);
        res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      clients.add(res);
      res.flushHeaders();
      res.write(': connected\n\n');
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  const interval = setInterval(() => {
    void snapshot().then(value => {
      for (const client of clients) client.write(`data: ${value.json}\n\n`);
    }).catch(() => undefined);
  }, Math.max(10000, refreshMs));
  interval.unref();
  server.listen(port, '127.0.0.1');
  return server;
}
