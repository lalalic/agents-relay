'use strict';
// Direct Relay root and authenticated Neo /dashboard/ share the same UI.
const RELAY_PREFIX = location.pathname.startsWith('/dashboard/') ? '/relay' : '';
// Only cookie-authenticated Dashboard writes need CSRF. Direct loopback Relay
// retains the existing API behavior and receives no Neo session credential.
async function dashboardWrite(url,options){
  if(!RELAY_PREFIX)return fetch(url,options);
  const auth=await fetch('/dashboard/csrf',{credentials:'same-origin',cache:'no-store'});
  if(!auth.ok)throw Error('Dashboard login expired');
  const receipt=await auth.json();
  if(typeof receipt.csrf!=='string'||!receipt.csrf)throw Error('Missing Dashboard CSRF token');
  return fetch(url,{...options,credentials:'same-origin',
    headers:{...(options?.headers||{}),'X-Neo-CSRF':receipt.csrf}});
}
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
const DASHBOARD_VERSION=window.__RELAY_DASHBOARD_CONFIG.version;
const jobsTab=document.querySelector('#jobs-tab');
const usageTab=document.querySelector('#usage-tab');
const graphsTab=document.querySelector('#graphs-tab');
const rulesTab=document.querySelector('#rules-tab');
const qaTab=document.querySelector('#qa-tab');
const qaView=document.querySelector('#qa-view');
const qaText=document.querySelector('#qa-text');
const qaStatus=document.querySelector('#qa-status');
const qaSave=document.querySelector('#qa-save');
let qaRevision='';

const jobsView=document.querySelector('#jobs-view');
const usageView=document.querySelector('#usage-view');
const graphsView=document.querySelector('#graphs-view');
const rulesView=document.querySelector('#rules-view');
const jobsWorkspace=document.querySelector('#jobs-workspace');
const jobList=document.querySelector('#job-list');
const jobsRefresh=document.querySelector('#jobs-refresh');
const jobSearch=document.querySelector('#job-search');
const repoFilter=document.querySelector('#repo-filter');
const statusFilter=document.querySelector('#status-filter');
const jobsFeedback=document.querySelector('#jobs-feedback');
const selectedJobRefresh=document.querySelector('#selected-job-refresh');
const jobContentButton=document.querySelector('#job-content-open');
const mobileJobsBack=document.querySelector('#mobile-jobs-back');
const mobileJobs=window.matchMedia('(max-width:650px)');
const jobDetail=document.querySelector('#job-detail');
const taskTree=document.querySelector('#task-tree');
const taskDetailRoot=document.querySelector('#task-detail');
const eventFeed=document.querySelector('#event-feed');
const eventsAllTasks=document.querySelector('#events-all-tasks');
const eventsScope=document.querySelector('#events-scope');
const selectedJobTitle=document.querySelector('#selected-job-title');
const usageRoot=document.querySelector('#usage-root');
const usageMeta=document.querySelector('#usage-meta');
const graphsMeta=document.querySelector('#graphs-meta');
const graphList=document.querySelector('#graph-list');
const graphTitle=document.querySelector('#graph-title');
const graphPath=document.querySelector('#graph-path');
const graphCanvas=document.querySelector('#graph-canvas');
const graphDescription=document.querySelector('#graph-description');
const rulesText=document.querySelector('#rules-text');
const rulesMeta=document.querySelector('#rules-meta');
const rulesStatus=document.querySelector('#rules-status');
const rulesSave=document.querySelector('#rules-save');const rulesTest=document.querySelector('#rules-test');const routerTestResults=document.querySelector('#router-test-results');const auditLog=document.querySelector('#audit-log');const auditRefresh=document.querySelector('#audit-refresh');
const rateLimitWarning=document.querySelector('#rate-limit-warning');
const runtimeSummary=document.querySelector('#runtime-summary');
let jobs=[];
let selectedJob=sessionStorage.getItem('agents-relay:selected-job');
let selectedTaskId=sessionStorage.getItem('agents-relay:selected-task');
let selectedRepo=storedFilterValue('agents-relay:repo-filter');
let selectedStatus=storedFilterValue('agents-relay:status-filter');
let jobRepositories=[];
let searchQuery=sessionStorage.getItem('agents-relay:job-search')||'';
let workflowGraphs=[];
let selectedGraphId='entry';
const WORKFLOW_SOURCE_REF=window.__RELAY_DASHBOARD_CONFIG.sourceRef;
let eventTaskId=selectedTaskId;
const collapsedTasks=new Set();
const expandedTasks=new Set();
const displayedEventIds=new Set();
function value(input){return input===null||input===undefined||input===''?'—':String(input);}
function storedFilterValue(key){const stored=sessionStorage.getItem(key);if(!stored)return '';try{const parsed=JSON.parse(stored);if(Array.isArray(parsed))return parsed.length===1&&typeof parsed[0]==='string'?parsed[0]:'';if(typeof parsed==='string')return parsed;}catch{return stored;}return '';}
function text(input){return document.createTextNode(value(input));}
function element(name,className,child){const node=document.createElement(name);if(className)node.className=className;if(child)node.append(child);return node;}
function yamlScalar(input){if(input===null)return 'null';if(typeof input==='boolean'||typeof input==='number')return String(input);return JSON.stringify(String(input));}
function yamlDump(input,indent=0){const pad=' '.repeat(indent);if(Array.isArray(input)){if(!input.length)return pad+'[]';return input.map(item=>{if(item&&typeof item==='object'){return pad+'-\n'+yamlDump(item,indent+2);}return pad+'- '+yamlScalar(item);}).join('\n');}if(input&&typeof input==='object'){const entries=Object.entries(input);if(!entries.length)return pad+'{}';const lines=[];for(const [key,item] of entries){if(typeof item==='string'&&item.includes('\n')){lines.push(pad+key+': |');for(const line of item.replace(/\n$/,'').split('\n'))lines.push(' '.repeat(indent+2)+line);continue;}if(item&&typeof item==='object'){lines.push(pad+key+':');lines.push(yamlDump(item,indent+2));}else{lines.push(pad+key+': '+yamlScalar(item));}}return lines.join('\n');}return pad+yamlScalar(input);}
function field(label,input){const box=element('div','detail-group');box.append(element('p','detail-label',text(label)),element('p','detail-value',text(input)));return box;}
function threadField(label,threadId){const box=element('div','detail-group');box.append(element('p','detail-label',text(label)));const id=String(threadId||'').trim();if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id)){box.append(element('p','detail-value',text(id||'—')));return box;}const link=document.createElement('a');link.className='detail-value';link.href='https://chatgpt.com/c/'+encodeURIComponent(id);link.target='implementation';link.rel='noopener noreferrer';link.textContent=id.slice(0,8);link.title=id;box.append(link);return box;}function markdownField(label,input){const box=element('div','detail-group');box.append(element('p','detail-label',text(label)),markdownValue(input));return box;}
function rememberSelection(){if(selectedJob)sessionStorage.setItem('agents-relay:selected-job',selectedJob);else sessionStorage.removeItem('agents-relay:selected-job');if(selectedTaskId)sessionStorage.setItem('agents-relay:selected-task',selectedTaskId);else sessionStorage.removeItem('agents-relay:selected-task');}
function syncMobileJobsView(){const detail=mobileJobs.matches&&Boolean(selectedJob)&&location.hash.startsWith('#/jobs/');document.body.dataset.mobileJobsView=detail?'detail':'list';}
function shortManagedId(id,repository,kind){const parts=String(repository||'').split('/');if(parts.length!==2)return String(id||'');const prefix=kind+'-'+parts[0].length+'-'+parts[0]+'-'+parts[1]+'-';const value=String(id||'');const suffix=value.startsWith(prefix)?value.slice(prefix.length):'';return /^[0-9]+$/.test(suffix)?'#'+suffix:value;}function jobSelectionKey(job){return job?String(job.repository||'')+'|'+String(job.id||''):'';}function dedupeJobs(entries){const byId=new Map();for(const job of entries){const key=jobSelectionKey(job);if(!key)continue;const existing=byId.get(key);if(!existing){byId.set(key,job);continue;}const fresh=isFreshEnough(job.updatedAt,existing.updatedAt);const preferred=fresh?job:existing;const other=fresh?existing:job;byId.set(key,{...other,...preferred,prNumber:Number(preferred.prNumber||0)>0?preferred.prNumber:other.prNumber});}return [...byId.values()];}
function jobForSelection(selection){return jobs.find(job=>jobSelectionKey(job)===selection)||jobs.find(job=>job.id===selection)||null;}
function selected(){return jobForSelection(selectedJob)||jobs[0]||null;}
function counts(tasks){const out={};for(const task of Array.isArray(tasks)?tasks:[])out[task.state]=(out[task.state]||0)+1;return out;}
function compactCounts(input){const order=['RUNNING','AWAITING_DECISION','BLOCKED','FAILED','QUEUED','DRAFT','SUCCEEDED','CANCELLED'];return order.filter(state=>input[state]).map(state=>input[state]+' '+state).join(', ')||'No tasks';}
function relativeTime(timestamp){if(!timestamp)return '—';const parsed=Date.parse(timestamp);if(!Number.isFinite(parsed))return value(timestamp);const seconds=Math.max(0,Math.round((Date.now()-parsed)/1000));if(seconds<60)return 'just now';if(seconds<3600)return Math.floor(seconds/60)+'m ago';if(seconds<86400)return Math.floor(seconds/3600)+'h ago';return Math.floor(seconds/86400)+'d ago';}
function safePrUrl(repository,prNumber){if(typeof repository!=='string'||!Number.isInteger(prNumber)||prNumber<=0)return null;const parts=repository.split('/');if(parts.length!==2)return null;const [owner,repo]=parts;if(!owner||!repo||owner==='.'||owner==='..'||repo==='.'||repo==='..')return null;if(!/^[A-Za-z0-9-]+$/.test(owner)||!/^[A-Za-z0-9._-]+$/.test(repo))return null;return 'https://github.com/'+owner+'/'+repo+'/pull/'+prNumber;}
function safeCommitUrl(repository,sha){if(typeof repository!=='string'||typeof sha!=='string'||!/^[0-9a-f]{7,64}$/i.test(sha))return null;const parts=repository.split('/');if(parts.length!==2||!parts[0]||!parts[1])return null;return 'https://github.com/'+parts[0]+'/'+parts[1]+'/commit/'+sha;}
function commitField(label,job,sha){const box=element('div','detail-group');box.append(element('p','detail-label',text(label)));const line=element('p','detail-value');const url=safeCommitUrl(job?.githubRepo,sha);if(url){const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=sha.slice(0,7);line.append(link);}else line.append(text(sha||'—'));box.append(line);return box;}
function prField(job){if(Number(job.prNumber||0)===0)return field('GitHub PR','Not applicable');const box=element('div','detail-group');box.append(element('p','detail-label',text('GitHub PR')));const line=element('p','detail-value');const prNumber=Number(job.prNumber||0);const url=safePrUrl(job.githubRepo,prNumber);if(url){const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='PR #'+prNumber;line.append(link);}else line.append(text('unavailable'));box.append(line);return box;}
function safeWorkerThreadUrl(input,adapter){try{const url=new URL(input);const parts=url.pathname.split('/');const domain=adapter==='z'?'chat.z.ai':'chatgpt.com';if(url.protocol!=='https:'||url.hostname!==domain||parts.length!==3||parts[1]!=='c'||!/^[A-Za-z0-9_-]{8,160}$/.test(parts[2]))return null;return url.origin+url.pathname;}catch{return null;}}
function chatField(task){const box=element('div','detail-group');box.append(element('p','detail-label',text('Worker threads')));const items=Array.isArray(task.threadHistory)?task.threadHistory.slice(-8).reverse():[];if(items.length===0)items.push({threadUrl:task.threadUrl,attempt:task.attempt});let shown=0;for(const item of items){const url=safeWorkerThreadUrl(item.threadUrl,task.adapter);if(!url)continue;const line=element('p','detail-value');const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open '+(task.adapter==='z'?'Z.ai':'ChatGPT')+' thread'+(Number.isInteger(item.attempt)?' · attempt '+item.attempt:'');line.append(link);box.append(line);shown++;}if(!shown){const line=element('p','detail-value');if(task.adapter==='chatgpt'&&typeof task.threadId==='string'){const url=safeWorkerThreadUrl('https://chatgpt.com/c/'+encodeURIComponent(task.threadId),'chatgpt');if(url){const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open ChatGPT thread';line.append(link);shown++;}}if(!shown)line.append(text('—'));box.append(line);}return box;}
function taskCommentField(task){const box=element('div','detail-group');box.append(element('p','detail-label',text('PR comment')));const line=element('p','detail-value');if(typeof task.taskUrl==='string'&&task.taskUrl.startsWith('https://github.com/')){const link=document.createElement('a');link.className='task-link';link.href=task.taskUrl;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open task comment';line.append(link);}else line.append(text('—'));box.append(line);return box;}
function parseAgentGraphSource(source){if(typeof source!=='string'||!source.trim())return null;const agents=new Map(),edges=[];for(const raw of source.split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith('%%')||line.startsWith('flowchart '))continue;let match=line.match(/^([A-Za-z_][A-Za-z0-9_.-]*)(?:\[agent:([A-Za-z_][A-Za-z0-9_.-]*)\])?\s*-->\s*([A-Za-z_][A-Za-z0-9_.-]*)(?:\[agent:([A-Za-z_][A-Za-z0-9_.-]*)\])?$/);if(match){agents.set(match[1],match[2]||agents.get(match[1])||match[1]);agents.set(match[3],match[4]||agents.get(match[3])||match[3]);edges.push([match[1],match[3]]);continue;}match=line.match(/^([A-Za-z_][A-Za-z0-9_.-]*)\[agent:([A-Za-z_][A-Za-z0-9_.-]*)\]$/);if(match){agents.set(match[1],match[2]);continue;}return null;}const incoming=new Map([...agents.keys()].map(id=>[id,0]));for(const [,to] of edges)incoming.set(to,(incoming.get(to)||0)+1);const remaining=new Map(incoming),waves=[];let ready=[...remaining].filter(([,degree])=>degree===0).map(([id])=>id).sort();while(ready.length){waves.push(ready);const next=[];for(const id of ready)for(const [from,to] of edges)if(from===id){const degree=(remaining.get(to)||0)-1;remaining.set(to,degree);if(degree===0)next.push(to);}ready=[...new Set(next)].sort();}return {agents,waves};}
function agentGraphField(task){if(typeof task.agentGraph!=='string'||!task.agentGraph.trim())return null;const box=element('div','detail-group');box.style.gridColumn='1 / -1';box.append(element('p','detail-label',text('Task agent graph')));const graph=element('div','agent-graph');const parsed=parseAgentGraphSource(task.agentGraph);if(parsed&&parsed.waves.length){parsed.waves.forEach((wave,index)=>{const row=element('div','agent-wave');if(index>0)row.append(element('span','agent-arrow',text('↓')));for(const id of wave)row.append(element('span','agent-node',text(id+' · '+(parsed.agents.get(id)||id))));graph.append(row);});}const source=document.createElement('pre');source.className='agent-graph-source';source.textContent=task.agentGraph;graph.append(source);box.append(graph);return box;}
function clearEvents(){displayedEventIds.clear();eventFeed.replaceChildren(element('li','empty',text('Waiting for events.')));}
async function loadEventHistory(){const job=selected();if(!job){clearEvents();return;}const params=new URLSearchParams({job:job.id,limit:String(MAX_EVENTS)});if(eventTaskId)params.set('task',eventTaskId);try{const history=await loadJSON(RELAY_PREFIX+'/api/events?'+params.toString());clearEvents();for(const event of Array.isArray(history)?history.slice().reverse():[])addEvent(event);}catch{clearEvents();}}
function copySelectedJobIdentity(job){if(!job||!navigator.clipboard?.writeText)return;void navigator.clipboard.writeText(repoName(job.repository)+'/'+value(job.id)).catch(()=>{});}
function selectJob(job){selectedJob=jobSelectionKey(job);selectedTaskId=null;eventTaskId=null;rememberSelection();clearEvents();location.hash=selectedJob?'#/jobs/'+encodeURIComponent(selectedJob):'#/jobs';copySelectedJobIdentity(job);renderAll();void loadEventHistory();}
function matchesQuickFilter(job){return !selectedStatus?window.__RELAY_DASHBOARD_CONFIG.statuses.some(status=>status==='DRAFT'?job.draft||job.state==='DRAFT':job.state===status):selectedStatus==='DRAFT'?job.draft||job.state==='DRAFT':job.state===selectedStatus;}
function matchesSearch(job){const query=searchQuery.trim().toLowerCase();if(!query)return true;const pr=String(job.prNumber||'');const normalized=query.replace(/^prs*#?/,'').replace(/^#/,'');return String(job.title||job.id||'').toLowerCase().includes(query)||String(job.id||'').toLowerCase().includes(query)||shortManagedId(job.id,job.repository,'j').toLowerCase().includes(query)||pr.includes(normalized);}
function filteredJobs(){return jobs.filter(job=>(!selectedRepo||selectedRepo===job.repository)&&matchesQuickFilter(job)&&matchesSearch(job)).slice(0,20);}
function syncFilters(){
  const repos=jobRepositories.length?jobRepositories:[...new Set(jobs.map(job=>job.repository).filter(Boolean))].sort();
  const repoOptions=[new Option('All repos',''),...repos.map(repo=>new Option(repo,repo))];
  if(repoFilter.options.length!==repoOptions.length||[...repoFilter.options].some((option,index)=>option.value!==repoOptions[index].value))repoFilter.replaceChildren(...repoOptions);
  if(selectedRepo&&!repos.includes(selectedRepo))selectedRepo='';
  if(!['','DRAFT','ACTIVE','COMPLETED','CANCELLED'].includes(selectedStatus))selectedStatus='';
  statusFilter.value=selectedStatus;
  repoFilter.value=selectedRepo;
  if(jobSearch.value!==searchQuery)jobSearch.value=searchQuery;
}
function repoName(repository){if(typeof repository!=='string'||!repository)return 'unknown-repo';const parts=repository.split('/').filter(Boolean);return parts.at(-1)||repository;}
const buildJelDiagram=window.__RELAY_DASHBOARD_CONFIG.buildJelDiagram;
const jelChart=document.querySelector('#jel-chart');
function inspectJelTask(id){
  if(!selected()?.tasks?.some(task=>task.id===id))return;
  selectedTaskId=id;eventTaskId=id;rememberSelection();clearEvents();
  dismissGraphViewer();renderAll();void loadEventHistory();
  document.querySelector('#task-detail').scrollIntoView({block:'start',behavior:'smooth'});
}
let jelRenderSequence=0;
async function openJelChart(job){
  const renderId=++jelRenderSequence;
  jelChart.replaceChildren(element('p','subtle',text('Rendering job lifecycle…')));
  showGraphViewer(jelChart,'JEL · '+value(job.repository)+'/'+value(job.id));
  const source=buildJelDiagram(job);
  try{
    if(!window.mermaid)throw new Error('Mermaid unavailable');
    if(!window.__relayMermaidReady){window.mermaid.initialize({startOnLoad:false,securityLevel:'strict',flowchart:{htmlLabels:false}});window.__relayMermaidReady=true;}
    const rendered=await window.mermaid.render('relay-jel-'+renderId,source);
    if(renderId!==jelRenderSequence||!graphDialog.open||graphViewerContent!==jelChart)return;
    const svg=sanitizeGraphSvg(rendered.svg);
    const definitions=graphNodeDefinitions(source);
    for(const node of svg.querySelectorAll('g.node')){const entry=Array.from(definitions.entries()).find(([key])=>node.id.includes('-flowchart-'+key+'-'));if(entry)addNodeLabel(node,entry[1]);}
    applyGraphPalette(svg);
    applyJelHighlights(svg);
    for(const node of svg.querySelectorAll('g.node')){
      const match=node.id.match(/-flowchart-task_([0-9]+)-/);
      const task=match?job.tasks?.[Number(match[1])]:null;
      if(!task?.id)continue;
      node.classList.add('jel-inspectable');node.setAttribute('role','button');node.setAttribute('tabindex','0');
      node.setAttribute('aria-label','Inspect Task '+task.id);
      node.addEventListener('click',()=>inspectJelTask(task.id));
      node.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();inspectJelTask(task.id);}});
    }
    jelChart.replaceChildren(svg);
    fitGraphViewer();
  }catch(error){
    if(renderId!==jelRenderSequence||!graphDialog.open||graphViewerContent!==jelChart)return;
    jelChart.replaceChildren(element('pre','jel-source',text(source)));
  }
}
function applyJelHighlights(svg){
  const palette={failed:['#fee2e2','#b91c1c','#991b1b'],retry:['#ede9fe','#7c3aed','#5b21b6'],troubleshooter:['#fef3c7','#b45309','#92400e'],review:['#dbeafe','#2563eb','#1e40af']};
  for(const node of svg.querySelectorAll('g.node')){
    const taskIndex=node.id.match(/-flowchart-task_([0-9]+)-/);
    const task=taskIndex?selected()?.tasks?.[Number(taskIndex[1])]:null;
    const kind=node.id.includes('-flowchart-failed_')||task?.state==='FAILED'?'failed':
      node.id.includes('-flowchart-retry_')||(task?.attempt||0)>1?'retry':
      node.id.includes('-flowchart-troubleshooter_')||task?.agentName==='troubleshooter'?'troubleshooter':
      task&&['job-acceptance-reviewer','reviewer'].includes(task.agentName)?'review':null;
    if(!kind)continue;
    node.classList.add('jel-'+kind);
    const [fill,stroke,color]=palette[kind];
    for(const shape of node.querySelectorAll('rect,polygon,circle,ellipse')){shape.setAttribute('fill',fill);shape.setAttribute('stroke',stroke);shape.setAttribute('stroke-width','2');}
    for(const label of node.querySelectorAll('text,tspan'))label.setAttribute('fill',color);
  }
}
function jelField(job){const box=element('div','detail-group');box.append(element('p','detail-label',text('Job Execution Lifecycle')));const line=element('p','detail-value');const link=element('a','',text('View JEL chart'));link.href='#graph-dialog';link.addEventListener('click',event=>{event.preventDefault();void openJelChart(job);});line.append(link);box.append(line);return box;}
function renderJobList(){jobList.replaceChildren();const visible=filteredJobs();if(!jobs.length){jobList.append(element('li','empty',text('No durable jobs discovered.')));return;}if(!visible.length){jobList.append(element('li','empty',text('No jobs match the selected filters.')));return;}for(const job of visible){const row=element('div','job-row'+(isCompleteUnmerged(job)?' complete-unmerged':''));row.setAttribute('aria-current',String(jobSelectionKey(job)===selectedJob));row.addEventListener('click',()=>selectJob(job));const content=element('div','job-content');const select=document.createElement('button');select.type='button';select.className='job-button';select.setAttribute('aria-current',String(jobSelectionKey(job)===selectedJob));select.title=job.title||job.id;select.addEventListener('click',event=>{event.stopPropagation();selectJob(job);});select.append(element('span','job-title',text(repoName(job.repository)+'/'+value(job.id)+(Number(job.prNumber||0)>0?'/PR#'+value(job.prNumber):'')+': '+value(job.title||job.id))));const states=element('span','job-status-line');states.append(element('span','badge '+value(job.state),text(value(job.state))));states.append(element('span','badge '+value(job.runtimeStatus||'IDLE'),text(value(job.runtimeStatus||'IDLE'))));if(job.publicationFailure)states.append(element('span','badge FAILED',text('PUBLISH FAILED: '+value(job.publicationFailure.stage))));else if(job.publication?.version)states.append(element('span','badge SUCCEEDED',text('v'+job.publication.version)));else if(Number(job.prNumber||0)>0&&job.githubState==='MERGED')states.append(element('span','badge MERGED',text('PR Merged')));else if(job.state==='COMPLETED'&&job.githubState==='CLOSED')states.append(element('span','badge SUCCEEDED',text('PR Archived')));if(job.state==='ACTIVE'&&job.reviewEnabled!==false)states.append(element('span','badge flag-review',text('REVIEW REQUIRED')));if(job.localMerge?.status==='failed')states.append(element('span','badge FAILED',text('MERGE FAILED: '+value(job.localMerge.error||'Unknown error'))));else if(isCompleteUnmerged(job))states.append(element('span','badge MERGE_PENDING',text('MERGE PENDING')));const primary=element('div','job-primary');primary.append(states);const lastLine=element('div','job-last-line');lastLine.append(element('span','subtle',text(compactCounts(counts(job.tasks)))),element('span','subtle',text(relativeTime(job.updatedAt))));content.append(select,primary,lastLine);row.append(content);jobList.append(element('li','',row));}}
function taskTagDisplay(job,task){const display=task.tag&&job?.tag?.values?.[task.tag];return typeof display==='string'&&display?display:null;}
function taskVerdict(job,task){if(task.state!=="SUCCEEDED")return null;const data=task.result?.data||{};if(["reviewer","job-acceptance-reviewer"].includes(task.agentName)){const verdict=data.verdict||((job?.review?.taskId===task.id)?job.review.outcome:null);return ({approved:"APPROVED",pass:"APPROVED","changes-required":"CHANGES REQUIRED",changes_required:"CHANGES REQUIRED"})[verdict]||null;}if(task.agentName==="troubleshooter"){const original=job?.tasks?.find(t=>t.id===task.parentTaskId);const resolution=original?.resolution;if(resolution?.state!=="resolved"||resolution.owner!=="troubleshooter")return null;return ({exact_original_retry:"RETRY VERIFIED",same_job_dependency:"DEPENDENCY REGISTERED",blocker_job_dependency:"BLOCKER REGISTERED",cancel_supersede:"SUPERSEDED"})[resolution.path]||null;}return null;}function taskSubtreeComplete(task,children){return ['SUCCEEDED','CANCELLED'].includes(task.state)&&(children.get(task.id)||[]).every(child=>taskSubtreeComplete(child,children));}
function taskStateLabel(task){const resolution=task?.resolution?.state;return task?.state==='FAILED'&&typeof resolution==='string'&&resolution.trim()?task.state+' / '+resolution:task.state;}
function taskNode(task,children,depth){const li=element('li');const nested=children.get(task.id)||[];const line=element('div','task-line');if(nested.length){const key=(selectedJob||'')+':'+task.id;const collapsed=collapsedTasks.has(key)||(!expandedTasks.has(key)&&taskSubtreeComplete(task,children));const fold=document.createElement('button');fold.type='button';fold.className='task-fold';fold.setAttribute('aria-expanded',String(!collapsed));fold.setAttribute('aria-label',(collapsed?'Expand ':'Collapse ')+task.id);fold.textContent=collapsed?'▸':'▾';line.append(fold);const ul=element('ul','tree');ul.hidden=collapsed;for(const child of nested)ul.append(taskNode(child,children,depth+1));fold.addEventListener('click',()=>{const next=!ul.hidden;ul.hidden=next;fold.setAttribute('aria-expanded',String(!next));fold.setAttribute('aria-label',(next?'Expand ':'Collapse ')+task.id);fold.textContent=next?'▸':'▾';if(next){collapsedTasks.add(key);expandedTasks.delete(key);}else{collapsedTasks.delete(key);expandedTasks.add(key);}});li.append(line,ul);}else li.append(line);const row=document.createElement('button');row.type='button';row.className='task-row';row.setAttribute('aria-current',String(task.id===selectedTaskId));row.title=task.id;row.addEventListener('click',()=>{const deselect=selectedTaskId===task.id;selectedTaskId=deselect?null:task.id;eventTaskId=deselect?null:task.id;rememberSelection();clearEvents();renderAll();void loadEventHistory();});const label=element('span','task-id',text(value(task.id)+': '+value(task.title||task.input?.split(/\r?\n/).find(line=>line.trim())?.trim()||shortManagedId(task.id,selected()?.repository,'t'))));label.style.paddingLeft=Math.min(depth,4)*6+'px';const verdict=taskVerdict(selected(),task);row.append(label,element('span','badge '+(verdict==='APPROVED'||verdict==='RESOLVED'?'SUCCEEDED':verdict==='CHANGES REQUIRED'||verdict==='WAITING'?'BLOCKED':value(task.state)),text(task.state==='FAILED'?taskStateLabel(task):(verdict||task.state))));const tag=taskTagDisplay(selected(),task);if(tag){const badge=element('span','task-tag',text(tag));badge.title=(selected()?.tag?.description||'Task tag')+': '+task.tag;row.append(badge);}line.append(row);return li;}
function buildTree(tasks){taskTree.replaceChildren();if(!Array.isArray(tasks)||!tasks.length){taskTree.append(element('li','empty',text('No tasks in durable state.')));return;}const work=tasks.filter(task=>task.kind!=='planner');if(!work.length){taskTree.append(element('li','empty',text('No work tasks in durable state.')));return;}const known=new Set(work.map(task=>task.id));const children=new Map();const roots=[];for(const task of work){if(!task.parentTaskId||!known.has(task.parentTaskId))roots.push(task);else{const siblings=children.get(task.parentTaskId)||[];siblings.push(task);children.set(task.parentTaskId,siblings);}}for(const task of roots)taskTree.append(taskNode(task,children,0));}
function attemptBudget(task){const attempt=Number(task?.attempt)||0;const max=Number(task?.maxAttempts)||0;if(max>=3&&max%3===0){const effectiveMax=Math.max(max,Math.ceil(attempt/3)*3);return attempt+' / 3×'+(effectiveMax/3);}return attempt+' / '+max;}
const JOB_STATES=['DRAFT','ACTIVE','COMPLETED','CANCELLED'];
async function setJobState(job,state,select){if(!job||state===job.state)return;select.disabled=true;try{const params=new URLSearchParams({id:job.id,state,repo:job.repository,pr:String(job.prNumber)});const response=await dashboardWrite(RELAY_PREFIX+'/api/job-state?'+params.toString(),{method:'POST'});if(!response.ok)throw new Error(response.status+' '+response.statusText);const updated=await response.json();const index=jobs.findIndex(candidate=>jobSelectionKey(candidate)===jobSelectionKey(job));if(index>=0)jobs[index]=updated;else jobs.push(updated);renderAll();void loadEventHistory();}catch(error){select.title='Set job lifecycle state: '+error.message;select.value=job.state;}finally{select.disabled=false;}}
function jobStateField(job){const box=element('div','detail-group');box.append(element('p','detail-label',text('Lifecycle state')));const select=document.createElement('select');select.className='job-filter job-state-select';select.dataset.state=job.state;select.setAttribute('aria-label','Job lifecycle state');for(const state of JOB_STATES)select.append(new Option(state,state));select.value=job.state;select.addEventListener('change',()=>void setJobState(job,select.value,select));box.append(select);return box;}
const TASK_STATES=['DRAFT','QUEUED','RUNNING','AWAITING_DECISION','BLOCKED','SUCCEEDED','FAILED','CANCELLED'];
async function setTaskState(task,state,select){const job=selected();if(!job||state===task.state)return;select.disabled=true;try{const params=new URLSearchParams({id:job.id,task:task.id,state,repo:job.repository,pr:String(job.prNumber)});const response=await dashboardWrite(RELAY_PREFIX+'/api/task-state?'+params.toString(),{method:'POST'});if(!response.ok)throw new Error(response.status+' '+response.statusText);const updated=await response.json();const index=jobs.findIndex(candidate=>jobSelectionKey(candidate)===jobSelectionKey(job));if(index>=0)jobs[index]=updated;else jobs.push(updated);renderAll();void loadEventHistory();}catch(error){select.title='Set task state: '+error.message;select.value=task.state;}finally{select.disabled=false;}}
function taskStateField(task){const box=element('div','detail-group');box.append(element('p','detail-label',text('State')));const select=document.createElement('select');select.className='job-filter task-state-select';select.setAttribute('aria-label','Task state');for(const state of TASK_STATES)select.append(new Option(state,state));select.value=task.state;select.addEventListener('change',()=>void setTaskState(task,select.value,select));box.append(select);return box;}
function manualOverrideField(task){const rows=Array.isArray(task.manualStateOverrides)?task.manualStateOverrides:[];const last=rows.at(-1);return field('Manual override',last?last.from+' → '+last.to+' · '+relativeTime(last.at):'—');}
function iconSvg(name){const paths={close:'M5 5l14 14M19 5 5 19',detail:'M7 3h7l4 4v14H7zM14 3v5h4M10 12h5m-5 4h5'};const ns='http://www.w3.org/2000/svg';const svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');const path=document.createElementNS(ns,'path');path.setAttribute('d',paths[name]);svg.append(path);return svg;}
// Content-only dialogs: durable Job/Task intent, original inputs and actual review feedback.
// No lifecycle state, transport details, or raw runtime diagnostics belong here.
const detailMarkdownRenderer=typeof window.markdownit==='function'?window.markdownit({html:false,linkify:false,breaks:true}):null;
function detailMarkdownTokens(tokens,parent){
  const allowed=new Set(['p','h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote','table','thead','tbody','tr','td','th','em','strong','s','a']);
  const stack=[parent];
  for(const token of tokens||[]){
    const current=stack[stack.length-1];
    if(token.type==='inline'){detailMarkdownTokens(token.children,current);continue;}
    if(token.type==='text'||token.type==='html_inline'||token.type==='text_special'){
      current.append(document.createTextNode(token.content||''));continue;
    }
    if(token.type==='softbreak'||token.type==='hardbreak'){
      current.append(document.createElement('br'));continue;
    }
    if(token.type==='code_inline'){
      current.append(element('code','',document.createTextNode(token.content||'')));continue;
    }
    if(token.type==='fence'||token.type==='code_block'){
      const pre=document.createElement('pre');
      pre.append(element('code','',document.createTextNode(token.content||'')));
      current.append(pre);continue;
    }
    if(token.type==='image'){
      // Intent is reading job instructions, not requesting remote image loads.
      current.append(document.createTextNode(token.content||''));continue;
    }
    if(token.type==='hr'){current.append(document.createElement('hr'));continue;}
    if(token.nesting===-1){if(stack.length>1)stack.pop();continue;}
    if(token.nesting===1){
      const tag=String(token.tag||'').toLowerCase();
      if(!allowed.has(tag)){stack.push(current);continue;}
      const next=document.createElement(tag);
      if(tag==='a'){
        const href=token.attrGet('href')||'';
        // No javascript:, data:, file:, or protocol-relative links.
        if(/^(https?:\/\/|mailto:|#|\/(?!\/)|\.\.?\/)/i.test(href)){
          next.href=href;next.target='_blank';next.rel='noopener noreferrer';
        }
      }
      current.append(next);stack.push(next);
    }
  }
}
function detailMarkdown(source){
  const container=element('div','dialog-markdown');
  const content=String(source||'');
  if(detailMarkdownRenderer)detailMarkdownTokens(detailMarkdownRenderer.parse(content,{}),container);
  else container.append(element('p','',text(content)));
  return container;
}
function detailText(value){return typeof value==='string'?value.trim():'';}
function detailKey(value){return detailText(value).replace(/\s+/g,' ').toLowerCase();}
function uniqueInputs(items,objective){
  const seen=new Set([detailKey(objective)]);
  const objectiveBlocks=new Set(detailText(objective).split(/\n\s*\n/).map(detailKey).filter(block=>block.length>45));
  const inputs=[];
  for(const item of items){
    let content=detailText(item.content);
    if(!content||seen.has(detailKey(content)))continue;
    // An input can include the complete objective as contextual boilerplate; remove only
    // duplicated standalone paragraphs, preserving any distinct instructions.
    content=content.split(/\n\s*\n/).filter(block=>!objectiveBlocks.has(detailKey(block))).join('\n\n').trim();
    const key=detailKey(content);
    if(!key||seen.has(key))continue;
    seen.add(key);
    inputs.push({...item,content});
  }
  return inputs;
}
function readerReviewComments(job,task){
  const comments=[];
  const seen=new Set();
  function add(content,author,createdAt,taskId){
    const message=detailText(content);
    const key=detailKey(message);
    if(!message||seen.has(key))return;
    seen.add(key);
    comments.push({text:message,author,createdAt,taskId});
  }
  const tasks=task?[task]:(job?.tasks||[]);
  for(const item of tasks)for(const comment of item.comments||[]){
    // The append-only stream also holds automatic recovery/state-change events.
    // Those are not comments about the work and do not belong in this reader.
    if(comment.kind&&comment.kind!=='human'&&comment.kind!=='review.feedback'&&comment.kind!=='escalation.responded')continue;
    if(comment.author==='relay'&&comment.kind!=='review.feedback')continue;
    add(comment.text,comment.author,comment.createdAt,task?undefined:item.id);
  }
  for(const request of job?.reviewRevisionRequests||[]){
    if(task&&request.originalTaskId!==task.id)continue;
    for(const finding of request.findings||[]){
      add([finding.summary,finding.evidence].filter(Boolean).join('\n\n'),'Reviewer',request.createdAt,task?undefined:request.originalTaskId);
    }
  }
  if(!task){
    const verdict=job?.review?.evidence?.data||{};
    for(const finding of verdict.findings||[])add(typeof finding==='string'?finding:[finding.summary,finding.evidence].filter(Boolean).join('\n\n'),'Final Review',job.review?.updatedAt);
    for(const observation of verdict.non_blocking_observations||[])add(typeof observation==='string'?observation:[observation.summary,observation.evidence].filter(Boolean).join('\n\n'),'Final Review',job.review?.updatedAt);
  }
  return comments.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
}
function readerInputSection(item){
  const section=element('section','dialog-content-section');
  section.append(element('h3','',text('Input')));
  const body=element('div','dialog-content-body');
  if(item.source)body.append(element('p','dialog-input-source',text(item.source)));
  body.append(detailMarkdown(item.content));
  section.append(body);
  return section;
}
function readerCommentsSection(comments){
  const section=element('section','dialog-content-section dialog-comments');
  section.append(element('h3','',text('Review comments')));
  const body=element('div','dialog-content-body');
  if(!comments.length)body.append(element('p','dialog-empty',text('No review comments recorded')));
  else{
    const list=element('ol','dialog-comment-list');
    for(const comment of comments){
      const item=element('li','dialog-comment');
      const meta=element('div','dialog-comment-meta');
      if(comment.author)meta.append(element('strong','',text(comment.author)));
      if(comment.taskId)meta.append(element('span','',text('Task '+comment.taskId)));
      if(comment.createdAt){const when=element('time','',text(comment.createdAt));when.dateTime=comment.createdAt;meta.append(when);}
      item.append(meta,detailMarkdown(comment.text));
      list.append(item);
    }
    body.append(list);
  }
  section.append(body);
  return section;
}
function showDetailsDialog(kind,id,title,objective,inputs,comments){
  const dialog=element('dialog','details-dialog');
  const headingId='details-dialog-heading';
  dialog.setAttribute('aria-labelledby',headingId);
  const head=element('div','details-dialog-head');
  const heading=element('div','dialog-heading');
  const eyebrow=element('div','dialog-eyebrow',text(kind+' '+id));
  const name=element('h2','',text(kind==='Task'&&detailKey(title)===detailKey(objective)?'Task details':title||kind+' '+id));name.id=headingId;
  heading.append(eyebrow,name);
  const close=element('button','icon-button');
  close.append(iconSvg('close'));close.type='button';close.setAttribute('aria-label','Close details');
  close.title='Close details';close.addEventListener('click',()=>dialog.close());
  head.append(heading,close);
  const body=element('div','details-dialog-body');
  const objectiveSection=element('section','dialog-content-section dialog-objective');
  objectiveSection.append(element('h3','',text(kind==='Task'?'Task objective':'Objective')));
  objectiveSection.append(element('div','dialog-content-body',detailMarkdown(objective||title)));
  body.append(objectiveSection);
  for(const item of inputs)body.append(readerInputSection(item));
  body.append(readerCommentsSection(comments));
  dialog.append(head,body);
  dialog.addEventListener('close',()=>dialog.remove());
  document.body.append(dialog);dialog.showModal();close.focus();
}
function openJobDetails(){
  const job=selected();if(!job)return;
  const objective=job.objective||job.description||job.title;
  const candidates=[];
  if(job.continuation?.input)candidates.push({source:'Job',content:job.continuation.input});
  for(const task of job.tasks||[]){
    if(task.parentTaskId||task.kind==='planner'||['Final Review','Troubleshooter'].includes(task.title)||['reviewer','job-acceptance-reviewer','troubleshooter'].includes(task.agentName))continue;
    candidates.push({source:task.title||'Task '+task.id,content:task.input});
  }
  for(const plan of job.plans||[])if(plan.source==='initial'&&plan.guidance)candidates.push({source:'Planning guidance',content:plan.guidance});
  const inputs=uniqueInputs(candidates,objective);
  showDetailsDialog('Job',job.id,job.title,objective,inputs,readerReviewComments(job));
}
function taskReaderEnvelope(task){
  const raw=detailText(task.input);
  if(!raw.startsWith('{'))return null;
  try{
    const parsed=JSON.parse(raw);
    return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:null;
  }catch{return null;}
}
function taskReaderObjective(task,envelope=taskReaderEnvelope(task)){
  const explicit=detailText(task.objective)||detailText(envelope?.taskObjective)||detailText(envelope?.objective);
  if(explicit)return explicit;
  const title=detailText(task.title);
  // A serialized Script/DAG execution envelope is not a natural-language objective.
  // Until an actual Task objective is persisted, use its title rather than inventing one.
  if(envelope)return title||'Task '+task.id;
  if(title&&/\s/.test(title))return title;
  const first=detailText(task.input).split(/\n\s*\n/).map(item=>item.trim())
    .find(item=>item&&!/^(Job ID|Task ID|Review head SHA|Execution ID):/i.test(item));
  return first||title||'Task '+task.id;
}
function taskReaderInputs(task,envelope=taskReaderEnvelope(task)){
  if(!envelope)return [{content:task.input}];
  const inputs=[];
  const request=detailText(envelope.taskInput)||detailText(envelope.input)||detailText(envelope.prompt);
  const instruction=detailText(envelope.instruction)||detailText(envelope.instructions);
  if(request)inputs.push({source:'Task request',content:request});
  if(instruction)inputs.push({source:'Execution instructions',content:instruction});
  // For unknown JSON input contracts, preserve the full input without turning it
  // into a fake objective. Known DAG transport fields are not user-facing content.
  if(!inputs.length)inputs.push({content:'```json\n'+JSON.stringify(envelope,null,2)+'\n```'});
  return inputs;
}
function openTaskDetails(task){
  const job=selected();
  const envelope=taskReaderEnvelope(task);
  const objective=taskReaderObjective(task,envelope);
  const candidates=taskReaderInputs(task,envelope);
  for(const attachment of task.attachments||[])candidates.push({source:'Attachment',content:attachment});
  const inputs=uniqueInputs(candidates,objective);
  showDetailsDialog('Task',task.id,task.title,objective,inputs,readerReviewComments(job,task));
}
document.querySelector('#job-content-open').addEventListener('click',openJobDetails);function renderTaskDetail(task){taskDetailRoot.replaceChildren();if(!task){taskDetailRoot.append(element('p','empty',text('Select a task to inspect execution details.')));return;}const routing=task.routing||{};const groups=element('div','detail-groups');groups.append(field('Title',task.title||'—'),field('Task ID',task.id),field('Kind',task.kind||'work'),taskStateField(task),...(task.state==='FAILED'&&task.resolution?.state?[field('Resolution state',task.resolution.state),field('Resolution path',task.resolution.path||'—'),field('Resolution target',task.resolution.targetTaskId||'—')]:[]),manualOverrideField(task),field('Planning decision',task.planningDecisionId||'—'),field('Planning source',task.planningSource||'—'),field('Planning round',task.planningRound===undefined?'—':String(task.planningRound)),field('Project / agent',value(task.projectName)+' / '+value(task.agentName)),field('Parent task',task.parentTaskId||'root'),...(task.resolutionClassification?[field('Resolution classification',task.resolutionClassification.kind),field('Resolution target',task.resolutionClassification.targetTaskId),field('Resolution evidence',task.resolutionClassification.evidence),field('Resolution reason',task.resolutionClassification.reason)]:[]),field('Adapter',task.adapter),field('Provider / model',value(routing.provider)+' / '+value(routing.model)),field('Reasoning / profile',value(routing.reasoning||routing.profile)),field('Attempt',attemptBudget(task)),field('Dependencies',Array.isArray(task.dependencies)&&task.dependencies.length?task.dependencies.join(', '):'none'),taskCommentField(task),chatField(task));const job=selected();if(task.reviewHeadSha&&job)groups.append(commitField('HEAD commit',job,task.reviewHeadSha));const graph=agentGraphField(task);if(graph)groups.append(graph);if(task.plannerResult)groups.append(field('Objective status',task.plannerResult.objective_status),markdownField('Assessment',task.plannerResult.assessment));if(task.error)groups.append(field('Error',task.error));const result=task.result?.data??task.result;if(result){groups.append(field('Conclusion',result.verdict||result.outcome?.verdict||task.result?.summary||'Available'));}taskDetailRoot.append(groups);const details=element('button','icon-button');details.append(iconSvg('detail'));details.type='button';details.setAttribute('aria-label','Task details and conclusion');details.title='Task details and conclusion';details.addEventListener('click',()=>openTaskDetails(task));taskDetailRoot.append(details);}
function reviewStatus(job){const review=job?.review;if(!review)return 'Not started';if(review.outcome==='approved'&&review.headSha===job.headSha)return 'MERGE READY · approved';const stale=Array.isArray(job?.tasks)&&job.tasks.some(task=>['reviewer','job-acceptance-reviewer'].includes(task.agentName)&&task.reviewHeadSha&&job.headSha&&task.reviewHeadSha!==job.headSha);if(stale)return 'STALE · awaiting review';return String(review.outcome||'pending').replace('_',' ').toUpperCase();}function renderSelectedJob(){jobDetail.replaceChildren();const job=selected();if(!job){selectedJobTitle.textContent='';jobContentButton.disabled=true;jobContentButton.dataset.state='IDLE';jobDetail.append(element('div','empty',text('No durable jobs discovered.')));buildTree([]);renderTaskDetail(null);return;}selectedJobTitle.textContent=value(job.title||job.id);jobContentButton.disabled=false;jobContentButton.dataset.state=JOB_STATES.includes(job.state)?job.state:'IDLE';jobContentButton.setAttribute('aria-label','Job details · '+value(job.state));jobContentButton.title='Job details · '+value(job.state);if(jobSelectionKey(job)!==selectedJob){selectedJob=jobSelectionKey(job);selectedTaskId=null;eventTaskId=null;clearEvents();rememberSelection();}const summary=element('div','job-summary');summary.append(field('PR state',Number(job.prNumber||0)===0?'Not applicable':job.githubState||'UNKNOWN'),jobStateField(job),field('Runtime status',job.runtimeStatus||'IDLE'),field('Review',job.reviewEnabled===false?'Not required':reviewStatus(job)),field('Creator thread',job.creatorThreadId||'—'),threadField('Implementation thread',job.implementationThreadId),threadField('Reviewer thread',job.reviewerThreadId),commitField('Review head SHA',job,job.review?.headSha||job.headSha||''),prField(job),field('Repository',job.repository||'—'),field('Project root',job.projectRoot||'—'),field('Last activity',relativeTime(job.updatedAt)),field('Task states',compactCounts(job.tasks)),jelField(job));jobDetail.append(summary);const selectedTask=(job.tasks||[]).find(task=>task.id===selectedTaskId)||null;if(selectedTaskId&&!selectedTask){selectedTaskId=null;eventTaskId=null;clearEvents();rememberSelection();}buildTree(job.tasks||[]);renderTaskDetail(selectedTask);renderEventScope();}function renderAll(){jobs.sort(compareJobs);syncFilters();renderJobList();renderSelectedJob();syncMobileJobsView();}
function isCompleteUnmerged(job){return job.runtimeStatus==='MERGE_PENDING';}
function compareJobs(a,b){const lifecycleGroup=job=>job.state==='COMPLETED'||job.state==='CANCELLED'?1:0;const timestamp=job=>{const updated=Date.parse(job.updatedAt||'');if(Number.isFinite(updated))return updated;const created=Date.parse(job.createdAt||'');return Number.isFinite(created)?created:0;};return lifecycleGroup(a)-lifecycleGroup(b)||timestamp(b)-timestamp(a)||String(a.repository||'').localeCompare(String(b.repository||''))||String(a.id||'').localeCompare(String(b.id||''));}
async function loadJSON(url){const response=await fetch(url);if(!response.ok)throw new Error(response.status+' '+response.statusText);return response.json();}
async function refreshVersion(){try{const live=await loadJSON(RELAY_PREFIX+'/api/version');if(live?.version&&live.version!==DASHBOARD_VERSION)location.reload();}catch{}}
function renderRateLimitStatus(status){
  if(!status?.limited){rateLimitWarning.hidden=true;rateLimitWarning.textContent='';return;}
  const until=status.cooldownUntil?new Date(status.cooldownUntil):null;
  const suffix=until&&!Number.isNaN(until.getTime())?' Live GitHub refresh will retry after '+until.toLocaleTimeString()+'.':' Live GitHub refresh is temporarily paused.';
  rateLimitWarning.textContent='GitHub API rate limit reached. Showing cached job data.'+suffix;
  rateLimitWarning.hidden=false;
}
function runtimePill(label,value){const pill=element('span','runtime-stat');pill.append(document.createTextNode(label+' '),element('strong','',text(value)));return pill;}
async function drawRuntimeSummary(){try{const summary=await loadJSON(RELAY_PREFIX+'/api/runtime-summary');runtimeSummary.replaceChildren(runtimePill('Active Jobs',summary.activeJobs||0),runtimePill('Running Tasks',summary.runningTasks||0),runtimePill('ChatGPT',summary.workers?.chatgpt||0),runtimePill('Codex',summary.workers?.codex||0));for(const item of Array.isArray(summary.models)?summary.models:[])runtimeSummary.append(runtimePill(item.model,item.count));}catch{runtimeSummary.replaceChildren();}}
async function refreshStatus(){try{renderRateLimitStatus(await loadJSON(RELAY_PREFIX+'/api/status'));}catch{renderRateLimitStatus(null);}}
function rememberJobFilters(){sessionStorage.setItem('agents-relay:repo-filter',selectedRepo);sessionStorage.setItem('agents-relay:status-filter',selectedStatus);sessionStorage.setItem('agents-relay:job-search',searchQuery);}
function jobsQuery(force=false){const params=new URLSearchParams();if(searchQuery.trim())params.set('q',searchQuery.trim());if(selectedStatus)params.set('status',selectedStatus);if(selectedRepo)params.set('repo',selectedRepo);if(force)params.set('refresh','1');return params.toString();}
let jobsRequestSequence=0;
async function refresh(force=true){const requestSequence=++jobsRequestSequence;jobsRefresh.disabled=true;jobsFeedback.textContent='';try{const params=jobsQuery(force);const discovered=await loadJSON(RELAY_PREFIX+'/api/jobs'+(params?'?'+params:''));if(requestSequence!==jobsRequestSequence)return;const result=Array.isArray(discovered)?{jobs:discovered,repositories:[...new Set(discovered.map(job=>job.repository).filter(Boolean))].sort()}:discovered;jobs=dedupeJobs(Array.isArray(result.jobs)?result.jobs:[]).sort(compareJobs).slice(0,20);jobRepositories=result.repositories||[];void drawRuntimeSummary();jobs.sort(compareJobs);if(selectedJob&&!jobForSelection(selectedJob)){selectedJob=null;selectedTaskId=null;}if(!selectedJob){const match=location.hash.match(/^#\/jobs\/(.+)$/);const fromHash=match?decodeURIComponent(match[1]):null;const fromRoute=jobForSelection(fromHash);selectedJob=jobSelectionKey(fromRoute||jobs[0]);}rememberSelection();rememberJobFilters();renderAll();void loadEventHistory();jobsFeedback.textContent='';}catch(error){if(requestSequence!==jobsRequestSequence)return;jobsFeedback.textContent='Refresh failed: '+error.message;jobList.replaceChildren(element('li','error-state',text('Could not load jobs: '+error.message)));}finally{if(requestSequence===jobsRequestSequence){jobsRefresh.disabled=false;syncFilters();}}}
function renderEventScope(){const task=eventTaskId&&selected()?.tasks?.find(candidate=>candidate.id===eventTaskId);eventsAllTasks.disabled=!task;eventsAllTasks.setAttribute('aria-pressed',String(!task));eventsScope.textContent=task?'Task '+task.id+' · newest first · 60 max':'Job-wide · newest first · 60 max';}
function eventLabel(type){return ({'task.process.launched':'Process launched','task.started':'Worker started','task.process.exited':'Sync process exited','task.process.async_exited':'Async process exited','task.completed':'Worker completed','task.failed':'Worker failed','task.blocked':'Worker blocked','review.started':'Review started','review.approved':'Review approved','review.changes_required':'Review changes required','review.blocked':'Review blocked'})[type]||type||'Event';}
function eventSeverity(event,level){const type=String(event?.type||'').toLowerCase(),eventLevel=String(event?.level||level||'').toLowerCase(),outcome=String(event?.outcome||event?.status||'').toLowerCase();if(eventLevel==='error'||outcome==='failed'||type.endsWith('.failed')||type==='task.failed')return 'error';if(eventLevel==='warn'||outcome==='blocked'||type.endsWith('.blocked')||type==='task.blocked'||type==='review.blocked')return 'warn';return 'normal';}
function addEvent(event,level){const current=selected();if(!event||current&&event.job_id&&event.job_id!==current.id||eventTaskId&&event.task_id!==eventTaskId)return;if(event.event_id&&displayedEventIds.has(event.event_id))return;if(event.event_id)displayedEventIds.add(event.event_id);const severity=eventSeverity(event,level);const item=element('li','event-item'+(severity==='error'?' event-error':severity==='warn'?' event-warn':''));const meta=element('div','event-meta');meta.append(element('span','event-kind',text(eventLabel(event.type))),element('span','event-type',text(event.type||'event')),element('span','',text(relativeTime(event.timestamp))),element('span','',text('task: '+value(event.task_id))));item.append(meta);const message=element('p','event-message',text(event.message||'Event received'));item.append(message);eventFeed.querySelector('.empty')?.remove();eventFeed.prepend(item);while(eventFeed.children.length>MAX_EVENTS)eventFeed.lastElementChild?.remove();}
function resetText(windowData){if(!Number.isFinite(windowData.resetsAt))return '';const at=new Date(windowData.resetsAt*1000);const minutes=Math.max(0,Math.ceil((at.getTime()-Date.now())/60000));const relative=minutes<60?minutes+'m':minutes<1440?Math.floor(minutes/60)+'h '+minutes%60+'m':Math.floor(minutes/1440)+'d '+Math.floor((minutes%1440)/60)+'h';return 'Resets '+at.toLocaleString()+' · in '+relative;}
function usageBar(label,windowData){const percent=Math.max(0,Math.min(100,100-windowData.usedPercent));const row=element('div','usage-row');const heading=element('div','usage-label');heading.append(element('span','',text(label)),element('span','',text(Math.round(percent)+'%')));const track=element('div','usage-track');track.setAttribute('role','progressbar');track.setAttribute('aria-label',label+' available');track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');track.setAttribute('aria-valuenow',String(percent));const fill=element('div','usage-fill');fill.style.width=percent+'%';track.append(fill);row.append(heading,track);const reset=resetText(windowData);if(reset)row.append(element('div','subtle',text(reset)));return row;}
function usageProvider(provider){const card=element('section','usage-provider');card.append(element('h3','',text(provider.label)));const usage=provider.usage||{};if(!usage.available||!usage.fiveHour||!usage.weekly){card.append(element('p','empty',text(usage.reason||'Account usage telemetry is unavailable.')));return card;}const bars=element('div','usage-bars');bars.append(usageBar('5-hour remaining',usage.fiveHour),usageBar('Weekly remaining',usage.weekly));card.append(bars);return card;}
function formatCredit(value,currency){if(value===null||value===undefined||!Number.isFinite(Number(value)))return '—';const number=Number(value);if(currency==='USD')return '$'+number.toFixed(2);if(currency==='CNY')return '¥'+number.toFixed(2);return number.toFixed(2)+' '+currency;}
function creditProvider(provider){const row=element('section','usage-provider');row.append(element('h3','',text(provider.label)));const credits=provider.credits||{};if(!credits.available||!Array.isArray(credits.balances)||!credits.balances.length){row.append(element('p','empty',text(credits.reason||'Credit balance is unavailable.')));return row;}const balance=credits.balances[0];row.append(element('div','detail-value',text(formatCredit(balance.remaining,balance.currency))));return row;}
function shortReset(reset){if(!Number.isFinite(reset))return '';const at=new Date(reset*1000);const minutes=Math.max(0,Math.ceil((at.getTime()-Date.now())/60000));const relative=minutes<60?minutes+'m':minutes<1440?Math.floor(minutes/60)+'h '+minutes%60+'m':Math.floor(minutes/1440)+'d '+Math.floor((minutes%1440)/60)+'h';return 'Reset '+relative;}
function githubBucket(label,bucket){const row=element('div','usage-row');const heading=element('div','usage-label');heading.append(element('span','',text(label)),element('span','',text(bucket.remaining+' / '+bucket.limit)));const percent=bucket.limit>0?Math.max(0,Math.min(100,100*bucket.remaining/bucket.limit)):0;const track=element('div','usage-track');track.setAttribute('role','progressbar');track.setAttribute('aria-label',label+' remaining');track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');track.setAttribute('aria-valuenow',String(Math.round(percent)));const fill=element('div','usage-fill');fill.style.width=percent+'%';track.append(fill);row.append(heading,track);const reset=shortReset(bucket.reset);if(reset){const hint=element('div','subtle',text(reset));hint.title=new Date(bucket.reset*1000).toLocaleString();row.append(hint);}return row;}
function githubCounterLine(label,values){const entries=Object.entries(values||{}).sort((a,b)=>Number(b[1])-Number(a[1])).slice(0,8);return entries.length?element('div','subtle',text(label+' · '+entries.map(([key,count])=>key+' '+count).join(' · '))):null;}
function githubDiagnostics(status){const body=element('div','usage-details-body');if(status?.calls)body.append(element('div','subtle',text('Calls · GraphQL '+(status.calls.graphql||0)+' · REST '+(status.calls.rest||0)+' · quota '+(status.calls.rateLimit||0))));const operations=githubCounterLine('GraphQL operations',status?.graphql?.operations);if(operations)body.append(operations);const contexts=githubCounterLine('GraphQL contexts',status?.graphql?.contexts);if(contexts)body.append(contexts);if(status?.readPaths){body.append(element('div','subtle',text('Reads · scans '+(status.readPaths.workspaceScans||0)+' · PR '+(status.readPaths.prRefreshes||0)+' · coalesced '+(status.readPaths.prRefreshCoalesced||0))));const triggers=githubCounterLine('Refresh triggers',status.readPaths.prRefreshesByTrigger);if(triggers)body.append(triggers);const coalesced=githubCounterLine('Coalesced',status.readPaths.prRefreshCoalescedByTrigger);if(coalesced)body.append(coalesced);}if(!body.children.length)return null;const details=element('details','usage-details');details.append(element('summary','',text('Diagnostics')),body);return details;}
function githubUsageCard(effective,status){
  const card=element('section','usage-provider');
  card.append(element('h3','',text('GitHub API')));
  const bars=element('div','usage-bars');
  if(effective)bars.append(githubBucket('Available',effective));
  else bars.append(element('p','empty',text('Quota unavailable')));
  const diagnostics=githubDiagnostics(status);
  if(diagnostics)bars.append(diagnostics);
  card.append(bars);
  return card;
}
async function drawUsage(){try{const overview=await loadJSON(RELAY_PREFIX+'/api/usage');usageRoot.replaceChildren();usageMeta.textContent='Real account telemetry when available';const providers=Array.isArray(overview.providers)?overview.providers:[];const credits=Array.isArray(overview.credits)?overview.credits:[];const grid=element('div','usage-providers');if(overview.githubEffective||overview.githubStatus)grid.append(githubUsageCard(overview.githubEffective,overview.githubStatus));for(const provider of providers)grid.append(usageProvider(provider));for(const provider of credits)grid.append(creditProvider(provider));if(!grid.children.length){usageRoot.append(element('p','empty',text('Usage telemetry is unavailable.')));return;}usageRoot.append(grid);}catch(error){usageMeta.textContent='Unavailable';usageRoot.replaceChildren(element('p','error-state',text('Usage unavailable: '+error.message)));}}
function selectedWorkflowGraph(){return workflowGraphs.find(graph=>graph.id===selectedGraphId)||null;}
function graphLinks(source){const links=new Map();for(const line of source.split('\n')){const match=/^\s*click\s+([A-Za-z0-9_]+)\s+href\s+"([a-z0-9-]+\.mmd)"(?:\s+"[^"\n]*")?\s*$/.exec(line);if(!match)continue;const id=match[2].slice(0,-4);if(workflowGraphs.some(graph=>graph.id===id))links.set(match[1],id);}return links;}
function graphFromHash(){if(location.hash==='#/graphs'||location.hash==='#/graphs/entry')return 'main';if(!location.hash.startsWith('#/graphs/'))return null;const id=location.hash.slice(9);return /^[a-z0-9-]+$/.test(id)?id:null;}
const WORKFLOW_NAV_KEY='agents-relay:workflow-navigation';
function graphHistory(){try{const value=JSON.parse(sessionStorage.getItem(WORKFLOW_NAV_KEY)||'null');if(value&&Array.isArray(value.entries)&&value.entries.every(id=>typeof id==='string'&&/^[a-z0-9-]+$/.test(id)))return value;}catch{}return {entries:[]};}
function saveGraphHistory(data){sessionStorage.setItem(WORKFLOW_NAV_KEY,JSON.stringify(data));}
function graphHistoryIndex(){const n=history.state?.workflowIndex;return Number.isInteger(n)&&n>=0?n:null;}
function initializeGraphHistory(){const route=graphFromHash();if(route===null)return;let data=graphHistory();const index=graphHistoryIndex();if(index!==null&&data.entries[index]===route)return;data={entries:[route]};saveGraphHistory(data);history.replaceState({...history.state,workflowIndex:0,workflowPath:route==='main'?['main']:['main',route]},'');}
function navigateGraph(id){if(id!=='entry'&&!workflowGraphs.some(graph=>graph.id===id))return;if(graphFromHash()===null)return;initializeGraphHistory();const data=graphHistory();const current=graphHistoryIndex()??0;const path=history.state?.workflowPath;const valid=Array.isArray(path)&&path.at(-1)===graphFromHash()&&path[0]==='main';const nextPath=id==='main'?['main']:[...(valid?path:['main']),id];data.entries=data.entries.slice(0,current+1);data.entries.push(id);saveGraphHistory(data);history.pushState({workflowIndex:current+1,workflowPath:nextPath},'','#/graphs/'+id);syncGraphRoute();}
function syncGraphRoute(){const route=graphFromHash();if(route===null)return;initializeGraphHistory();selectedGraphId=route;renderGraphList();void renderSelectedGraph();}
function renderGraphNavigation(){const graph=selectedWorkflowGraph();initializeGraphHistory();const data=graphHistory();const index=graphHistoryIndex()??0;document.querySelector('#graph-back').disabled=index<=0;document.querySelector('#graph-forward').disabled=index>=data.entries.length-1;const path=history.state?.workflowPath;const names=Array.isArray(path)&&path.at(-1)===selectedGraphId?path:[selectedGraphId==='main'?'main':'main',...(selectedGraphId==='main'?[]:[selectedGraphId])];document.querySelector('#graph-breadcrumb').textContent=names.map(id=>id==='main'?'Main (conceptual)':workflowGraphs.find(g=>g.id===id)?.name||id).join(' / ');}
function renderGraphList(){graphList.replaceChildren();if(!workflowGraphs.length){graphList.append(element('p','empty',text('No workflow graphs found.')));return;}for(const graph of workflowGraphs){const button=document.createElement('button');button.type='button';button.className='graph-button';button.setAttribute('aria-current',String(graph.id===selectedGraphId));button.append(element('strong','',text(graph.name)),element('span','',text(graph.path)));button.addEventListener('click',()=>navigateGraph(graph.id));graphList.append(button);}}
async function graphDetail(kind,name){const panel=document.querySelector('#graph-detail');panel.hidden=false;panel.replaceChildren(element('strong','',text(kind+': '+name)),element('p','subtle',text('Loading authoritative references…')));try{const params=new URLSearchParams({graph:selectedGraphId,kind,name});const result=await loadJSON(RELAY_PREFIX+'/api/graph-symbol?'+params);panel.replaceChildren(element('strong','',text(kind+': '+name)));const sections=[['Graph',[result.graph]],['Canonical contract',result.contracts],['Implementation',result.implementation],['Tests',result.tests]];for(const [heading,refs] of sections){panel.append(element('p','detail-label',text(heading)));if(!refs?.length){panel.append(element('p','subtle',text('No exact symbol reference found.')));continue;}for(const ref of refs){const link=element('a','',text(ref.path+(ref.line>0?':'+ref.line:'')+' ['+(ref.evidence==='exact-token'?'verified graph token':'text-search suggestion')+']'));if(WORKFLOW_SOURCE_REF){link.href='https://github.com/lalalic/agents-relay/blob/'+WORKFLOW_SOURCE_REF+'/'+ref.path+(ref.line>0?'#L'+ref.line:'');link.target='_blank';link.rel='noopener noreferrer';}else{link.removeAttribute('href');link.title='Source revision unavailable';}link.target='_blank';link.rel='noopener noreferrer';panel.append(link,document.createTextNode('  '));}}panel.scrollIntoView({block:'nearest'});}catch(error){panel.append(element('p','error-state',text('Reference lookup unavailable: '+error.message)));}}
function interactiveNode(node,callback,label){node.classList.add('drillable');node.setAttribute('tabindex','0');node.setAttribute('role','button');node.setAttribute('aria-label',label);node.addEventListener('click',callback);node.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();callback();}});}
function graphNodeDefinitions(source){const result=new Map();for(const line of source.split('\n')){const pattern=/([A-Za-z0-9_]+)(?:\["([^"\n]+)"\]|\{"([^"\n]+)"\})/g;for(const match of line.matchAll(pattern))result.set(match[1],match[2]||match[3]);}return result;}
function addNodeLabel(node,label){const ns='http://www.w3.org/2000/svg';const old=node.querySelector('g.label');if(old)old.remove();const textNode=document.createElementNS(ns,'text');textNode.setAttribute('x','0');textNode.setAttribute('y','0');textNode.setAttribute('text-anchor','middle');textNode.setAttribute('dominant-baseline','middle');textNode.setAttribute('fill','#182536');textNode.setAttribute('font-size','13');const rect=node.querySelector('rect.label-container,rect.basic,rect');const width=Math.max(65,Number(rect?.getAttribute('width')||135)-14);const maxChars=Math.max(9,Math.floor(width/7.2));const words=label.split(/\s+/);const lines=[];let current='';for(const word of words){if(current&&(current+' '+word).length>maxChars){lines.push(current);current=word;}else current=current?current+' '+word:word;}if(current)lines.push(current);for(let i=0;i<lines.length;i++){const tspan=document.createElementNS(ns,'tspan');tspan.setAttribute('x','0');tspan.setAttribute('dy',i===0?String(-((lines.length-1)*7)):'14');tspan.textContent=lines[i];textNode.append(tspan);}node.append(textNode);}
function sanitizeGraphSvg(markup){const parsed=new DOMParser().parseFromString(markup.replace(/^<svg\b/,'<svg xmlns:xlink="http://www.w3.org/1999/xlink"'),'image/svg+xml');const source=parsed.documentElement;if(source.localName!=='svg'||parsed.querySelector('parsererror'))throw new Error('Invalid SVG');const ns='http://www.w3.org/2000/svg';const elements=new Set(['svg','g','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','defs','marker','title','desc','clipPath']);const attributes=new Set(['id','class','viewBox','width','height','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','d','points','transform','fill','stroke','stroke-width','stroke-dasharray','stroke-linecap','stroke-linejoin','opacity','fill-opacity','stroke-opacity','font-size','font-family','font-weight','text-anchor','dominant-baseline','markerWidth','markerHeight','markerUnits','refX','refY','orient','preserveAspectRatio','clip-path','marker-start','marker-mid','marker-end','role','aria-label']);const clean=node=>{if(node.nodeType===3)return document.createTextNode(node.textContent||'');if(node.nodeType!==1||node.namespaceURI!==ns||!elements.has(node.localName))return null;const out=document.createElementNS(ns,node.localName);for(const attr of node.attributes){if(!attr.namespaceURI&&attr.name==='style'){for(const declaration of attr.value.split(';')){const split=declaration.indexOf(':');if(split<0)continue;const property=declaration.slice(0,split).trim();const cssValue=declaration.slice(split+1).trim();if((property==='stroke'||property==='fill')&&/^(?:#[0-9a-fA-F]{3,8}|rgb\([0-9.,%\s]+\)|none|currentColor)$/.test(cssValue))out.setAttribute(property,cssValue);else if(property==='stroke-width'&&/^[0-9]+(?:\.[0-9]+)?(?:px)?$/.test(cssValue))out.setAttribute(property,cssValue);}continue;}if(attr.namespaceURI||!attributes.has(attr.name))continue;if(['marker-start','marker-mid','marker-end','clip-path'].includes(attr.name)){if(!attr.value.startsWith('url(#')||!attr.value.endsWith(')')||!(/^[a-zA-Z0-9_-]+$/.test(attr.value.slice(5,-1))))continue;}else if(attr.value.toLowerCase().includes('url(')||attr.value.includes('<')||attr.value.includes('>'))continue;out.setAttribute(attr.name,attr.value);}for(const child of node.childNodes){const safe=clean(child);if(safe)out.appendChild(safe);}return out;};return clean(source);}
function applyGraphPalette(svg){const ns='http://www.w3.org/2000/svg';for(const path of svg.querySelectorAll('path')){if(path.closest('marker')){if(!path.hasAttribute('fill'))path.setAttribute('fill','#65768a');continue;}if(!path.hasAttribute('fill'))path.setAttribute('fill','none');if(!path.hasAttribute('stroke'))path.setAttribute('stroke','#65768a');}for(const node of svg.querySelectorAll('g.node')){const error=node.classList.contains('failure')||node.classList.contains('exception');for(const shape of node.querySelectorAll('rect,polygon,circle,ellipse')){shape.setAttribute('fill',error?'#ffe4e4':'#f9fbff');shape.setAttribute('stroke',error?'#be3030':'#657f9e');shape.setAttribute('stroke-width','1.3');}for(const label of node.querySelectorAll('text'))label.setAttribute('fill',node.classList.contains('drillable')?'#2367b1':error?'#7c1818':'#182536');}for(const rect of svg.querySelectorAll('rect')){if(!rect.closest('g.node')&&!rect.hasAttribute('fill'))rect.setAttribute('fill','#ffffff');}for(const label of svg.querySelectorAll('text'))if(!label.hasAttribute('fill'))label.setAttribute('fill','#182536');}
async function renderSelectedGraph(){const graph=selectedWorkflowGraph();renderGraphNavigation();document.querySelector('#graph-detail').hidden=true;if(!graph){graphTitle.textContent='Graph not found';graphPath.textContent='';graphDescription.textContent='';graphCanvas.replaceChildren(element('p','error-state',text('Graph not found: '+selectedGraphId+'. Select Entry or another graph.')));return;}graphTitle.textContent=graph.name;graphDescription.textContent=graph.description||'';graphPath.textContent=graph.path;graphCanvas.replaceChildren(element('p','subtle',text('Rendering…')));try{if(!window.mermaid)throw new Error('Mermaid renderer unavailable');if(!window.__relayMermaidReady){window.mermaid.initialize({startOnLoad:false,securityLevel:'strict',flowchart:{htmlLabels:false}});window.__relayMermaidReady=true;}const rendered=await window.mermaid.render('relay-graph-'+graph.id.replace(/[^A-Za-z0-9_-]/g,'-'),graph.source.replace(/^\s*click\s+[^\n]*$/gm,''));if(graph.id!==selectedGraphId)return;const svg=sanitizeGraphSvg(rendered.svg);graphCanvas.replaceChildren(svg);const definitions=graphNodeDefinitions(graph.source);for(const node of svg.querySelectorAll('g.node')){const entry=Array.from(definitions.entries()).find(([key])=>node.id.includes('-flowchart-'+key+'-'));const label=entry?.[1]||'';if(label)addNodeLabel(node,label);const target=entry?.[0];const next=target?graphLinks(graph.source).get(target):null;if(next){interactiveNode(node,()=>navigateGraph(next),'Explore '+target);}else{const match=/^(state|guard|action):\s*([A-Za-z0-9_.-]+)/.exec(label);if(match)interactiveNode(node,()=>graphDetail(match[1]==='guard'?'Guard':match[1]==='action'?'Action':'State',match[2]),'Inspect '+match[1]+' '+match[2]);}}applyGraphPalette(svg);}catch(error){graphCanvas.replaceChildren(element('p','error-state',text('Visual preview unavailable: '+error.message+'.')));}}
async function drawGraphs(){try{const graphs=await loadJSON(RELAY_PREFIX+'/api/graphs');workflowGraphs=Array.isArray(graphs)?graphs:[];const requested=graphFromHash();selectedGraphId=requested||'main';graphsMeta.textContent=(workflowGraphs.length-1)+' executable workflow graphs · main is conceptual';renderGraphList();await renderSelectedGraph();}catch(error){graphsMeta.textContent='Unavailable';workflowGraphs=[];selectedGraphId='main';renderGraphList();await renderSelectedGraph();graphPath.textContent='Executable graphs unavailable: '+error.message;}}
function auditWorker(record){return value(record?.selected?.worker?.adapter??record?.worker?.adapter??record?.selected?.worker?.id??record?.worker?.id);}
function auditModel(record){const model=record?.selected?.model;return value(typeof model==='string'?model:model?.model);}
function renderAudit(records){auditLog.replaceChildren();if(!Array.isArray(records)||!records.length){auditLog.append(element('p','empty',text('No schema v5 routing decisions yet.')));return;}for(const record of records){const card=element('article','audit-entry');const head=element('div','audit-entry-head');head.append(element('strong','',text(auditWorker(record)+' · '+auditModel(record))),element('span','subtle',text(new Date(record.timestamp).toLocaleString())));card.append(head);const correlation=record.correlation||{};card.append(element('div','subtle',text([correlation.job_id,correlation.task_id].filter(Boolean).join(' / ')||'uncorrelated')));const probabilities=record.decision_evidence?.probabilities||{};const gates=(record.gate_results||[]).filter(item=>!item.eligible).map(item=>item.candidate_id+': '+item.rejection_reasons.join(', '));const nl=String.fromCharCode(10);const details=document.createElement('pre');details.textContent='fallback: '+String(Boolean(record.decision_evidence?.fallback))+(Object.keys(probabilities).length?nl+'probabilities: '+JSON.stringify(probabilities,null,2):'')+(gates.length?nl+'rejected: '+gates.join(nl):'');card.append(details);auditLog.append(card);}}
async function drawAudit(){auditRefresh.disabled=true;try{renderAudit(await loadJSON(RELAY_PREFIX+'/api/decision-audit'));}catch(error){auditLog.replaceChildren(element('p','error-state',text('Audit unavailable: '+error.message)));}finally{auditRefresh.disabled=false;}}
async function drawRules(){rulesStatus.textContent='';try{const rules=await loadJSON(RELAY_PREFIX+'/api/execution-router-rules');rulesText.value=typeof rules.text==='string'?rules.text:'';rulesMeta.textContent=rules.hash&&rules.hash!=='none'?'Loaded · '+rules.hash.slice(0,12):'No custom rules saved';}catch(error){rulesMeta.textContent='Unavailable';rulesStatus.textContent='Could not load rules: '+error.message;}void drawAudit();}
async function testRouter(){rulesTest.disabled=true;routerTestResults.replaceChildren(element('p','subtle',text('Calling router with current status…')));try{if(!selectedJob||!selectedTaskId)throw new Error('Select a Job and Task first');const response=await dashboardWrite(RELAY_PREFIX+'/api/router-test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId:selected()?.id,taskId:selectedTaskId})});if(!response.ok)throw new Error(response.status+' '+await response.text());const result=await response.json();const routeSelection=result.selected||{};const payload={selected:routeSelection,proposed_fields:result.proposedFields||{},probabilities:result.probabilities||{},fallback:Boolean(result.fallback),effective_choices:result.effectiveChoices||[],routing_instruction:result.routingInstruction||'',merged_choices:result.mergedChoices||[],hard_gates:result.gates||[],laya_input:result.decisionInput||null};routerTestResults.replaceChildren(element('strong','',text((routeSelection.worker||'—')+' · '+(routeSelection.model||'—'))));routerTestResults.append(element('div','subtle',text('route: '+(routeSelection.route||'—'))),element('pre','',text(yamlDump(payload))));}catch(error){routerTestResults.replaceChildren(element('p','error-state',text('Router test failed: '+error.message)));}finally{rulesTest.disabled=false;}}
async function saveRules(){rulesSave.disabled=true;rulesStatus.textContent='Saving…';try{const response=await dashboardWrite(RELAY_PREFIX+'/api/execution-router-rules',{method:'PUT',headers:{'content-type':'text/plain; charset=utf-8'},body:rulesText.value});if(!response.ok)throw new Error(response.status+' '+await response.text());const rules=await response.json();rulesMeta.textContent='Saved · '+rules.hash.slice(0,12);rulesStatus.textContent='Saved. New routing decisions will load these rules.';}catch(error){rulesStatus.textContent='Save failed: '+error.message;}finally{rulesSave.disabled=false;}}
async function drawQa(){qaStatus.textContent='Loading…';try{const result=await loadJSON(RELAY_PREFIX+'/api/troubleshooter-qa');qaText.value=result.text;qaRevision=result.hash;qaStatus.textContent='Loaded';}catch(error){qaStatus.textContent='Load failed: '+error.message;}}
async function saveQa(){qaSave.disabled=true;qaStatus.textContent='Saving…';try{const response=await dashboardWrite(RELAY_PREFIX+'/api/troubleshooter-qa',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({text:qaText.value,hash:qaRevision})});if(!response.ok)throw new Error(response.status+' '+await response.text());const saved=await response.json();qaRevision=saved.hash;qaStatus.textContent='Saved to Markdown file';}catch(error){qaStatus.textContent='Save failed: '+error.message;}finally{qaSave.disabled=false;}}
function showView(view){const isJobs=view==='jobs';const isUsage=view==='usage';const isGraphs=view==='graphs';const isRules=view==='rules';const isQa=view==='qa';qaView.hidden=!isQa;qaTab.setAttribute('aria-selected',String(isQa));jobsView.hidden=!isJobs;jobsWorkspace.hidden=!isJobs;usageView.hidden=!isUsage;graphsView.hidden=!isGraphs;rulesView.hidden=!isRules;jobsTab.setAttribute('aria-selected',String(isJobs));usageTab.setAttribute('aria-selected',String(isUsage));graphsTab.setAttribute('aria-selected',String(isGraphs));rulesTab.setAttribute('aria-selected',String(isRules));if(isUsage)void drawUsage();else if(isGraphs)void drawGraphs();else if(isRules)void drawRules();else if(isQa)void drawQa();}
jobsTab.addEventListener('click',()=>{location.hash=selectedJob?'#/jobs/'+encodeURIComponent(selectedJob):'#/jobs';showView('jobs');});
jobsRefresh.addEventListener('click',()=>void refresh(true));
eventsAllTasks.addEventListener('click',()=>{eventTaskId=null;clearEvents();renderEventScope();void loadEventHistory();});
function applyLocalJobFilters(){rememberJobFilters();renderJobList();}
repoFilter.addEventListener('change',()=>{selectedRepo=repoFilter.value;applyLocalJobFilters();});
jobSearch.addEventListener('input',()=>{searchQuery=jobSearch.value;applyLocalJobFilters();});
statusFilter.addEventListener('change',()=>{selectedStatus=statusFilter.value;applyLocalJobFilters();});
selectedJobRefresh.addEventListener('click',()=>void refreshSelected());
mobileJobsBack.addEventListener('click',()=>{location.hash='#/jobs';syncMobileJobsView();window.scrollTo({top:0,behavior:'instant'});});
mobileJobs.addEventListener('change',syncMobileJobsView);
window.addEventListener('hashchange',syncMobileJobsView);
usageTab.addEventListener('click',()=>{location.hash='#/usage';showView('usage');});
graphsTab.addEventListener('click',()=>{location.hash='#/graphs/entry';showView('graphs');});
document.querySelector('#graph-entry').addEventListener('click',()=>navigateGraph('main'));
const graphDialog=document.querySelector('#graph-dialog');
const graphViewport=document.querySelector('#graph-dialog-viewport');
const graphZoomLevel=document.querySelector('#graph-zoom-level');
let graphZoom=1;
let graphViewerContent=null;
let graphViewerHome=null;
let graphViewerNext=null;
let graphViewerWasHidden=false;
function graphViewerSvg(){return graphViewerContent?.querySelector('svg')||null;}
function graphIntrinsicSize(svg){
  const view=svg.viewBox?.baseVal;
  const width=view?.width||Number.parseFloat(svg.getAttribute('width'))||svg.getBoundingClientRect().width||900;
  const height=view?.height||Number.parseFloat(svg.getAttribute('height'))||svg.getBoundingClientRect().height||500;
  return {width:Math.max(1,width),height:Math.max(1,height)};
}
function setGraphZoom(value,preserveCenter=true){
  const svg=graphViewerSvg();
  const dimensions=svg?graphIntrinsicSize(svg):null;
  const centerX=dimensions?(graphViewport.scrollLeft+graphViewport.clientWidth/2)/(dimensions.width*graphZoom):0;
  const centerY=dimensions?(graphViewport.scrollTop+graphViewport.clientHeight/2)/(dimensions.height*graphZoom):0;
  graphZoom=Math.max(.05,Math.min(6,Number.isFinite(value)?value:1));
  if(svg&&dimensions){
    svg.style.width=dimensions.width*graphZoom+'px';
    svg.style.height=dimensions.height*graphZoom+'px';
    svg.style.maxWidth='none';
    if(preserveCenter){
      graphViewport.scrollLeft=dimensions.width*graphZoom*centerX-graphViewport.clientWidth/2;
      graphViewport.scrollTop=dimensions.height*graphZoom*centerY-graphViewport.clientHeight/2;
    }
  }
  graphZoomLevel.textContent=Math.round(graphZoom*100)+'%';
}
function fitGraphViewer(){
  const svg=graphViewerSvg();
  if(!svg){setGraphZoom(1,false);return;}
  const {width,height}=graphIntrinsicSize(svg);
  const availableWidth=Math.max(1,graphViewport.clientWidth-48);
  const availableHeight=Math.max(1,graphViewport.clientHeight-48);
  setGraphZoom(Math.min(availableWidth/width,availableHeight/height),false);
  graphViewport.scrollLeft=Math.max(0,(graphViewport.scrollWidth-graphViewport.clientWidth)/2);
  graphViewport.scrollTop=Math.max(0,(graphViewport.scrollHeight-graphViewport.clientHeight)/2);
}
function showGraphViewer(content,title){
  if(graphDialog.open)return;
  // A native dialog close event can arrive after a fast reopen. Restore the
  // previous content synchronously so it is never orphaned by replaceChildren.
  if(graphViewerContent)closeGraphViewer();
  graphViewerContent=content;
  graphViewerHome=content.parentNode;
  graphViewerNext=content.nextSibling;
  graphViewerWasHidden=content.hidden;
  content.hidden=false;
  graphViewport.replaceChildren(content);
  document.querySelector('#graph-dialog-title').textContent=title;
  graphDialog.showModal();
  graphViewport.scrollLeft=0;
  graphViewport.scrollTop=0;
  fitGraphViewer();
}
function closeGraphViewer(){
  const content=graphViewerContent;
  if(!content)return;
  if(content===jelChart)jelRenderSequence++;
  const svg=graphViewerSvg();
  if(svg){svg.style.width='';svg.style.height='';svg.style.maxWidth='';}
  const next=graphViewerNext?.parentNode===graphViewerHome?graphViewerNext:null;
  graphViewerHome.insertBefore(content,next);
  content.hidden=graphViewerWasHidden;
  graphViewerContent=null;
  graphViewerHome=null;
  graphViewerNext=null;
  graphZoom=1;
  graphZoomLevel.textContent='100%';
}
document.querySelector('#graph-maximize').addEventListener('click',()=>showGraphViewer(graphCanvas,graphTitle.textContent));
function dismissGraphViewer(){if(graphDialog.open)graphDialog.close();closeGraphViewer();}
graphDialog.addEventListener('close',()=>{if(!graphDialog.open)closeGraphViewer();});
graphDialog.addEventListener('cancel',event=>{event.preventDefault();dismissGraphViewer();});
document.querySelector('#graph-dialog-close').addEventListener('click',dismissGraphViewer);
document.querySelector('#graph-zoom-in').addEventListener('click',()=>setGraphZoom(graphZoom*1.25));
document.querySelector('#graph-zoom-out').addEventListener('click',()=>setGraphZoom(graphZoom/1.25));
document.querySelector('#graph-zoom-reset').addEventListener('click',fitGraphViewer);
graphViewport.addEventListener('wheel',event=>{if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();setGraphZoom(graphZoom*(event.deltaY<0?1.15:1/1.15));},{passive:false});
let graphDrag=null;
graphViewport.addEventListener('pointerdown',event=>{
  if(event.target.closest('.drillable')||event.button!==0)return;
  graphDrag={id:event.pointerId,x:event.clientX,y:event.clientY,left:graphViewport.scrollLeft,top:graphViewport.scrollTop};
  graphViewport.setPointerCapture(event.pointerId);
});
graphViewport.addEventListener('pointermove',event=>{
  if(!graphDrag||event.pointerId!==graphDrag.id)return;
  graphViewport.scrollLeft=graphDrag.left-(event.clientX-graphDrag.x);
  graphViewport.scrollTop=graphDrag.top-(event.clientY-graphDrag.y);
});
for(const eventName of ['pointerup','pointercancel','lostpointercapture'])graphViewport.addEventListener(eventName,()=>{graphDrag=null;});
document.querySelector('#graph-back').addEventListener('click',()=>history.back());
document.querySelector('#graph-forward').addEventListener('click',()=>history.forward());
window.addEventListener('popstate',()=>{if(graphFromHash()){renderGraphNavigation();showView('graphs');}else if(location.hash==='#/usage')showView('usage');else if(location.hash==='#/execution-router-rules')showView('rules');else if(location.hash==='#/troubleshooter-qa')showView('qa');else showView('jobs');});
window.addEventListener('hashchange',()=>{if(graphFromHash()){renderGraphNavigation();showView('graphs');}else if(location.hash==='#/usage')showView('usage');else if(location.hash==='#/execution-router-rules')showView('rules');else if(location.hash==='#/troubleshooter-qa')showView('qa');else showView('jobs');});
rulesTab.addEventListener('click',()=>{location.hash='#/execution-router-rules';showView('rules');});
qaTab.addEventListener('click',()=>{location.hash='#/troubleshooter-qa';showView('qa');});
qaSave.addEventListener('click',()=>void saveQa());
document.querySelector('#qa-reload').addEventListener('click',()=>{if(!qaText.value||confirm('Discard unsaved Q&A edits and reload?'))void drawQa();});
rulesSave.addEventListener('click',()=>void saveRules());
rulesTest.addEventListener('click',()=>void testRouter());
auditRefresh.addEventListener('click',()=>void drawAudit());
window.addEventListener('keydown',event=>{if(event.key==='Tab'&&event.altKey){event.preventDefault();const views=['jobs','usage','graphs','rules','qa'];const current=location.hash==='#/usage'?'usage':graphFromHash()?'graphs':location.hash==='#/execution-router-rules'?'rules':location.hash==='#/troubleshooter-qa'?'qa':'jobs';const next=views[(views.indexOf(current)+1)%views.length];location.hash=next==='usage'?'#/usage':next==='graphs'?'#/graphs':next==='rules'?'#/execution-router-rules':next==='qa'?'#/troubleshooter-qa':(selectedJob?'#/jobs/'+encodeURIComponent(selectedJob):'#/jobs');showView(next);}});
function parseMessage(message){try{return JSON.parse(message.data);}catch{return null;}}
function isFreshEnough(incoming,current){const a=Date.parse(incoming||''),b=Date.parse(current||'');return !Number.isFinite(b)||!Number.isFinite(a)||a>=b;}
function applyStatePatch(patch){if(!patch?.jobId)return false;const job=jobs.find(candidate=>candidate.id===patch.jobId);if(!job)return false;if(patch.jobState&&isFreshEnough(patch.jobUpdatedAt,job.updatedAt)){job['state']=patch.jobState;if(patch.jobUpdatedAt)job.updatedAt=patch.jobUpdatedAt;}if(patch.taskId&&patch.taskState){const task=(job.tasks||[]).find(candidate=>candidate.id===patch.taskId);if(task&&isFreshEnough(patch.taskUpdatedAt,task.updatedAt)){task['state']=patch.taskState;if(patch.taskUpdatedAt)task.updatedAt=patch.taskUpdatedAt;}}return true;}
async function refreshJobSnapshot(jobId){const known=jobs.find(job=>job.id===jobId);if(!known)return;try{const params=new URLSearchParams({id:known.id,repo:known.repository,pr:String(known.prNumber||0)});const latest=await loadJSON(RELAY_PREFIX+'/api/job?'+params);upsertFreshJob(latest);renderAll();}catch{/* The current stream and next manual refresh remain available. */}}
function upsertFreshJob(incoming){if(!incoming)return;const index=jobs.findIndex(job=>jobSelectionKey(job)===jobSelectionKey(incoming));if(index<0){jobs.push(incoming);return;}if(isFreshEnough(incoming.updatedAt,jobs[index].updatedAt))jobs[index]={...incoming,prNumber:Number(incoming.prNumber||0)>0?incoming.prNumber:jobs[index].prNumber};}
const stream=new EventSource(RELAY_PREFIX+'/events');
stream.onmessage=message=>{const payload=parseMessage(message);if(payload?.job){upsertFreshJob(payload.job);renderAll();void drawRuntimeSummary();}};
stream.addEventListener('relay',message=>{const payload=parseMessage(message);if(payload?.job)upsertFreshJob(payload.job);else if(payload?.statePatch)applyStatePatch(payload.statePatch);if(payload?.statePatch)void refreshJobSnapshot(payload.statePatch.jobId);if(payload?.event)addEvent(payload.event);renderAll();void drawRuntimeSummary();});
if(location.hash==='#/usage')showView('usage');else if(graphFromHash())showView('graphs');else if(location.hash==='#/execution-router-rules')showView('rules');else if(location.hash==='#/troubleshooter-qa')showView('qa');else showView('jobs');void refresh(false);
setInterval(()=>{if(location.hash==='#/usage')void drawUsage();},30000);
setInterval(()=>void refreshVersion(),30000);
async function refreshSelected(){const job=selected();if(!job){await refresh();return;}selectedJobRefresh.disabled=true;try{const params=new URLSearchParams({id:job.id,repo:job.repository,pr:String(job.prNumber)});const updated=await loadJSON(RELAY_PREFIX+'/api/job?'+params.toString());const index=jobs.findIndex(candidate=>jobSelectionKey(candidate)===jobSelectionKey(job));if(index>=0)jobs[index]=updated;else jobs.push(updated);selectedJob=jobSelectionKey(updated);rememberSelection();renderAll();}catch(error){jobsFeedback.textContent='Selected job refresh failed: '+error.message;}finally{selectedJobRefresh.disabled=false;}}
