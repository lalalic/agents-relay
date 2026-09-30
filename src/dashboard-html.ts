import { createRequire } from 'node:module';

const packageVersion = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
export const dashboardVersion = packageVersion;

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
    .version { margin-left:auto; color:var(--muted); font-size:.72rem; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; white-space:nowrap; }
    .runtime-summary { display:flex; gap:.4rem; align-items:center; flex-wrap:wrap; margin-top:.55rem; }
    .runtime-stat { padding:.18rem .45rem; border:1px solid var(--border); border-radius:999px; background:var(--surface2); color:var(--muted); font-size:.72rem; white-space:nowrap; }
    .runtime-stat strong { color:var(--text); }
    h1 { margin:0; font-size:1.08rem; letter-spacing:-.02em; }
    .tagline,.subtle { color:var(--muted); font-size:.78rem; }
    .warning-banner { margin:.65rem 0 0; padding:.5rem .65rem; border:1px solid #e6bf62; border-radius:.4rem; background:#fff4d6; color:#6f4b00; font-size:.78rem; font-weight:700; }
    .tagline { margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    nav[role="tablist"] { display:flex; gap:.3rem; margin-top:.65rem; }
    nav button { border:0; border-radius:.35rem; background:transparent; color:var(--muted); padding:.38rem .68rem; font:inherit; font-weight:700; cursor:pointer; }
    nav button[aria-selected="true"] { background:var(--accent); color:#fff; }
    button:focus-visible,a:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    main { max-width:1500px; margin:auto; padding:1rem; display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:1rem; align-items:start; }
    .panel { min-width:0; background:var(--surface); border:1px solid var(--border); border-radius:.55rem; box-shadow:var(--shadow); }
    .panel-head { display:flex; align-items:center; justify-content:space-between; gap:.6rem; padding:.65rem .75rem; border-bottom:1px solid var(--border); }
    .panel-head h2,.panel-head h3 { margin:0; color:var(--muted); font-size:.75rem; letter-spacing:.07em; text-transform:uppercase; min-width:0; }\n    #workspace-heading { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }\n    #selected-job-title { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .panel-actions { display:flex; align-items:center; gap:.45rem; }
    .job-filters { display:flex; gap:.35rem; align-items:center; flex-wrap:wrap; }
    .job-filter { max-width:145px; border:1px solid var(--border); border-radius:.35rem; background:var(--surface); color:var(--text); padding:.27rem .4rem; font:inherit; font-size:.72rem; }
    .job-search { width:95px; max-width:14vw; border:1px solid var(--border); border-radius:.35rem; background:var(--surface); color:var(--text); padding:.27rem .45rem; font:inherit; font-size:.72rem; }
    .quick-filter { border:1px solid var(--border); border-radius:.35rem; background:var(--surface); color:var(--muted); padding:.27rem .42rem; font:inherit; font-size:.7rem; font-weight:750; cursor:pointer; }
    .quick-filter[aria-pressed="true"] { border-color:var(--accent); background:var(--accent2); color:var(--accent); }
    .refresh-button { border:1px solid var(--border); border-radius:.35rem; background:var(--surface); color:var(--muted); padding:.28rem .55rem; font:inherit; font-size:.72rem; font-weight:700; cursor:pointer; }
    .refresh-button:disabled { cursor:default; opacity:.55; }
    .mobile-only { display:none; }
    .panel-body { padding:.75rem; overflow:auto; max-height:calc(100vh - 11.5rem); }
    #jobs-workspace > .panel:first-child .panel-body { overflow:visible; max-height:none; }
    .jobs-panel { grid-row:1/span 2; }
    .workspace { display:grid; gap:1rem; }
    .job-list,.tree,.event-list { list-style:none; margin:0; padding:0; }
    .job-list { display:grid; gap:.35rem; }
    .job-row { display:grid; gap:.2rem; padding:.35rem .45rem; border:1px solid transparent; border-radius:.4rem; cursor:pointer; }
    .job-row[aria-current="true"] { border-color:var(--accent); background:var(--accent2); }
    .job-row.complete-unmerged { border-color:#d69a1b; background:#fff8df; }
    .job-row.complete-unmerged[aria-current="true"] { border-color:#b77900; background:#fff0bd; }
    .job-content { min-width:0; display:grid; gap:.2rem; }
    .job-button { min-width:0; display:block; padding:.12rem 0; border:0; background:transparent; color:inherit; text-align:left; font:inherit; cursor:pointer; }
    .job-title { font-weight:750; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .job-last-line { display:flex; align-items:center; justify-content:space-between; gap:.5rem; min-width:0; }
    .job-last-line .subtle:first-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .job-last-line .subtle:last-child { flex:none; white-space:nowrap; }
    .job-primary { display:flex; align-items:center; justify-content:space-between; gap:.45rem; min-width:0; }
    .job-status-line { display:flex; align-items:center; gap:.3rem; min-width:0; white-space:nowrap; }
    .job-status-line .badge { flex:0 0 auto; }
    .status-pill,.badge { display:inline-flex; align-items:center; border-radius:999px; padding:.06rem .42rem; min-height:1.35rem; font-size:.68rem; font-weight:800; }
    .status-pill.ok,.badge.ACTIVE,.badge.RUNNING,.badge.SUCCEEDED,.badge.COMPLETED,.badge.MERGED { background:#e5f3e9; color:var(--ok); }
    .status-pill.warn,.badge.BLOCKED,.badge.DRAFT,.badge.QUEUED,.badge.WAITING,.badge.OPEN { background:#fff1d2; color:var(--warn); }
    .status-pill.bad,.badge.FAILED { background:#ffe8e8; color:var(--bad); }
    .status-pill.neutral,.badge.IDLE,.badge.UNBLOCKED,.badge.CANCELLED { background:#edf0f4; color:var(--muted); }
    .badge.DRAFT { background:#eef2ff; color:#3f51b5; }
    .badge.MERGE_PENDING { background:#ffe3a3; color:#7a4a00; }
    .job-summary,.detail-groups { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.55rem; }
    .detail-group { min-width:0; padding:.5rem; background:var(--surface2); border:1px solid var(--border); border-radius:.4rem; }
    .detail-label { margin:0; color:var(--muted); font-size:.66rem; text-transform:uppercase; letter-spacing:.04em; }
    .detail-value { margin:.12rem 0 0; font-weight:650; overflow-wrap:anywhere; }
    .section-title { margin:.8rem 0 .35rem; color:var(--muted); font-size:.72rem; letter-spacing:.05em; text-transform:uppercase; }
    ul.tree { display:grid; gap:.25rem; min-width:0; max-width:100%; }
    ul.tree li { min-width:0; max-width:100%; }
    ul.tree ul { width:calc(100% - .6rem); min-width:0; max-width:calc(100% - .6rem); list-style:none; margin:.2rem 0 .1rem .6rem; padding-left:.6rem; border-left:1px solid var(--border); }
    .task-line { display:flex; align-items:center; gap:.2rem; min-width:0; }
    .task-fold { flex:0 0 auto; width:1.35rem; padding:.32rem 0; border:0; background:transparent; color:var(--muted); font:inherit; cursor:pointer; }
    .task-row { width:100%; max-width:100%; overflow:hidden; flex:1 1 0; display:flex; align-items:center; gap:.4rem; min-width:0; padding:.32rem .38rem; border:0; border-radius:.35rem; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; }
    .task-row[aria-current="true"] { background:var(--accent2); }
    .task-row .badge { flex:0 0 auto; }
    .task-id { min-width:0; max-width:100%; flex:1 1 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font: .77rem ui-monospace,SFMono-Regular,Menlo,monospace; }
    .task-actions { display:flex; justify-content:flex-end; gap:.25rem; margin-bottom:.5rem; }
    .task-link { color:var(--accent); font-weight:700; }
    .agent-graph { display:grid; gap:.45rem; margin-top:.55rem; padding:.55rem; border:1px solid var(--border); border-radius:.4rem; background:var(--surface2); overflow:auto; }
    .agent-wave { display:flex; align-items:center; gap:.4rem; min-width:max-content; }
    .agent-node { padding:.32rem .48rem; border:1px solid var(--border); border-radius:.35rem; background:var(--surface); font:.73rem ui-monospace,SFMono-Regular,Menlo,monospace; }
    .agent-arrow { color:var(--muted); font-weight:800; }
    .agent-graph-source { margin:.1rem 0 0; padding:.45rem; border-radius:.35rem; background:var(--surface); color:var(--muted); font:.7rem/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre; overflow:auto; }
    .event-list { display:grid; gap:.45rem; }
    .event-item { padding-bottom:.4rem; border-bottom:1px solid var(--border); }
    .event-meta { display:flex; flex-wrap:wrap; gap:.4rem; color:var(--muted); font-size:.68rem; }
    .event-kind { color:var(--accent); font-weight:800; }
    .event-message { margin:.12rem 0 0; overflow-wrap:anywhere; }
    #usage-view,#rules-view,#shortcuts-view,#worker-rules-view { grid-column:1 / -1; }
    .rules-editor { display:grid; gap:.65rem; }
    .rules-help { margin:0; color:var(--muted); font-size:.8rem; }
    .rules-textarea { width:100%; min-height:55vh; resize:vertical; border:1px solid var(--border); border-radius:.45rem; background:var(--surface2); color:var(--text); padding:.8rem; font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .rules-footer { display:flex; align-items:center; justify-content:space-between; gap:.75rem; flex-wrap:wrap; }
    .rules-save { border:1px solid var(--accent); border-radius:.35rem; background:var(--accent); color:#fff; padding:.38rem .8rem; font:inherit; font-weight:750; cursor:pointer; }
    .rules-save:disabled { opacity:.55; cursor:default; }
    .usage-providers { display:grid; gap:.55rem; }
    .usage-provider { display:grid; grid-template-columns:minmax(130px,180px) minmax(0,1fr); gap:1rem; align-items:center; padding:.7rem .8rem; border:1px solid var(--border); border-radius:.45rem; background:var(--surface2); }
    .usage-provider h3 { margin:0; font-size:.86rem; }
    .usage-bars { display:grid; gap:1rem; }
    .usage-row { display:grid; gap:.35rem; }
    .usage-label { display:flex; justify-content:space-between; gap:1rem; font-weight:700; }
    .usage-track { height:.72rem; overflow:hidden; border:1px solid var(--border); border-radius:999px; background:var(--surface2); }
    .usage-fill { height:100%; width:0; border-radius:inherit; background:var(--accent); transition:width .2s ease; }
    .usage-details { border-top:1px solid var(--border); padding-top:.45rem; }
    .usage-details summary { cursor:pointer; color:var(--muted); font-size:.72rem; font-weight:700; }
    .usage-details-body { display:grid; gap:.3rem; margin-top:.4rem; overflow-wrap:anywhere; }
    .empty,.error-state { padding:.85rem; border:1px dashed var(--border); border-radius:.4rem; color:var(--muted); }
    .error-state,.error-text { color:var(--bad); }
    .skeleton { height:3.2rem; border-radius:.4rem; background:linear-gradient(90deg,#edf0f4,#fafbfc,#edf0f4); animation:pulse 1.2s infinite; }
    @keyframes pulse { 50% { opacity:.55; } }
    @media (max-width:1050px) { main { grid-template-columns:1fr; } .jobs-panel { grid-row:auto; } .panel-body { max-height:24rem; } #jobs-workspace > .panel:first-child .panel-body { max-height:none; } }
    @media (max-width:650px) {
      header { padding:.65rem .7rem; }
      nav[role="tablist"] { overflow-x:auto; padding-bottom:.1rem; }
      nav button { flex:0 0 auto; white-space:nowrap; }
      main { padding:.5rem; gap:.65rem; }
      body[data-mobile-jobs-view="list"] #jobs-workspace { display:none; }
      body[data-mobile-jobs-view="detail"] #jobs-view { display:none; }
      .mobile-only { display:inline-flex; }
      #jobs-view .panel-head { display:grid; align-items:start; }
      #jobs-view .panel-actions { width:100%; flex-wrap:wrap; }
      .runtime-summary { display:none; }
      #jobs-view .job-filters { width:auto; }
      #jobs-view .job-search,
      #jobs-view #quick-status,
      #jobs-view #quick-autonomous,
      #jobs-view #quick-draft { display:none; }
      #jobs-view .panel-body { max-height:none; }
      #jobs-workspace { gap:.65rem; }
      #jobs-workspace .panel-body { max-height:none; }
      #usage-view .panel-head { padding:.6rem .7rem .35rem; }
      #usage-view .panel-head .subtle { display:none; }
      #usage-view .panel-body { padding:.45rem .5rem .65rem; max-height:none; }
      #usage-view .usage-providers { gap:.45rem; }
      #usage-view .usage-provider {
        grid-template-columns:1fr;
        gap:.55rem;
        padding:.65rem .7rem;
        border-radius:.55rem;
        background:var(--surface);
      }
      #usage-view .usage-provider h3 { font-size:.78rem; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
      #usage-view .usage-bars { gap:.7rem; }
      #usage-view .usage-row { gap:.25rem; }
      #usage-view .usage-label { align-items:baseline; gap:.5rem; font-size:.78rem; }
      #usage-view .usage-label span:last-child { font-size:1.05rem; font-weight:800; color:var(--text); }
      #usage-view .usage-track { height:.48rem; border:0; background:var(--border); }
      #usage-view .usage-row .subtle { font-size:.68rem; line-height:1.25; }
      #usage-view .usage-provider > .detail-value { font-size:1.2rem; font-weight:800; }
      #usage-view .usage-details { padding-top:.35rem; }
      #usage-view .usage-details-body { font-size:.68rem; }
      .job-summary,.detail-groups { grid-template-columns:1fr; }
      .panel-head { padding:.55rem .6rem; }
      .panel-body { padding:.6rem; }
      .tagline { display:none; }
    }
    @media (prefers-reduced-motion:reduce) { .skeleton { animation:none; } .usage-fill { transition:none; } }
  </style>
</head>
<body>
<header>
  <div class="brand"><h1>Agents Relay Console</h1><p class="tagline">Durable PR state is authoritative; events are observability.</p><span class="version">v${dashboardVersion}</span></div>
  <div id="runtime-summary" class="runtime-summary" aria-label="Runtime summary"></div>
  <div id="rate-limit-warning" class="warning-banner" role="status" hidden></div>
  <nav role="tablist" aria-label="Console views">
    <button id="jobs-tab" type="button" role="tab" aria-selected="true" aria-controls="jobs-view">Jobs</button>
    <button id="usage-tab" type="button" role="tab" aria-selected="false" aria-controls="usage-view">Usage</button>
    <button id="rules-tab" type="button" role="tab" aria-selected="false" aria-controls="rules-view">Execution Rules</button>
    <button id="shortcuts-tab" type="button" role="tab" aria-selected="false" aria-controls="shortcuts-view">Shortcuts</button>
  </nav>
</header>
<main>
  <section id="jobs-view" role="tabpanel" aria-labelledby="jobs-tab" class="panel jobs-panel">
    <div class="panel-head"><h2>Jobs</h2><div class="panel-actions"><div class="job-filters"><input id="job-search" class="job-search" type="search" placeholder="Search title or PR #" aria-label="Search jobs by title or PR number"><select id="quick-status" class="job-filter" aria-label="Filter jobs by derived status"><option value="">STATUS</option></select><button id="quick-autonomous" class="quick-filter" type="button" aria-pressed="false">AUTONOMOUS</button><button id="quick-draft" class="quick-filter" type="button" aria-pressed="false">DRAFT</button><select id="repo-filter" class="job-filter" aria-label="Filter jobs by repository"><option value="">All repos</option></select></div><button id="jobs-refresh" class="refresh-button" type="button">Refresh</button></div></div>
    <div class="panel-body" aria-live="polite"><ul id="job-list" class="job-list"><li class="skeleton" aria-hidden="true"></li></ul></div>
  </section>
  <div class="workspace" id="jobs-workspace">
    <section class="panel" aria-labelledby="workspace-heading">
      <div class="panel-head"><button id="mobile-jobs-back" class="refresh-button mobile-only" type="button">← Jobs</button><h2 id="workspace-heading"><span id="selected-job-title" class="subtle"></span></h2><div class="panel-actions"><button id="selected-job-refresh" class="refresh-button" type="button">Refresh</button><span id="connection" class="status-pill neutral" aria-live="polite" aria-label="Connecting"></span></div></div>
      <div class="panel-body">
        <div id="job-detail"><div class="skeleton"></div></div>
        <h3 class="section-title">Task hierarchy</h3>
        <ul id="task-tree" class="tree"><li class="skeleton"></li></ul>
        <h3 class="section-title">Task detail</h3>
        <div id="task-detail"><p class="empty">Select a task to inspect execution details.</p></div>
      </div>
    </section>
    <section class="panel" id="events-panel" aria-labelledby="events-heading">
      <div class="panel-head"><h2 id="events-heading">Events</h2><div class="panel-actions"><button id="events-all-tasks" class="refresh-button" type="button">All tasks</button><span id="events-scope" class="subtle">Job-wide · newest first · 60 max</span></div></div>
      <div class="panel-body"><ol id="event-feed" class="event-list"><li class="empty">Waiting for events.</li></ol></div>
    </section>
  </div>
  <section id="usage-view" role="tabpanel" aria-labelledby="usage-tab" hidden>
    <div class="panel">
      <div class="panel-head"><h2 id="usage-heading">Usage</h2><span id="usage-meta" class="subtle"></span></div>
      <div class="panel-body" id="usage-root" aria-live="polite"><div class="skeleton"></div></div>
    </div>
  </section>
  <section id="rules-view" role="tabpanel" aria-labelledby="rules-tab" hidden>
    <div class="panel">
      <div class="panel-head"><h2>Execution Router Rules</h2><span id="rules-meta" class="subtle"></span></div>
      <div class="panel-body">
        <div class="rules-editor">
          <p class="rules-help">Free-text soft policy loaded by the Execution Router for every worker+model routing decision. Impossible routes remain excluded by code; Codex remains the deterministic fallback if decision fails.</p>
          <textarea id="rules-text" class="rules-textarea" spellcheck="true" aria-label="Execution router rules" placeholder="Example: Prefer ZAI glm-5.3-flash high while quota is available. Use ChatGPT for research when appropriate. Codex is fallback only."></textarea>
          <div class="rules-footer"><span id="rules-status" class="subtle" aria-live="polite"></span><button id="rules-save" class="rules-save" type="button">Save rules</button></div>
        </div>
      </div>
    </div>
  </section>
  <section id="shortcuts-view" role="tabpanel" aria-labelledby="shortcuts-tab" hidden>
    <div class="panel">
      <div class="panel-head"><h2>ChatGPT Shortcuts</h2><span class="subtle">One per line · %1 = current repo/pr</span></div>
      <div class="panel-body">
        <div class="rules-editor">
          <p class="rules-help">Format: &lt;name&gt;: &lt;prompt&gt;. Use %1 where the current Job reference should appear.</p>
          <textarea id="shortcuts-text" class="rules-textarea" spellcheck="true" aria-label="ChatGPT shortcuts"></textarea>
          <div class="rules-footer"><span id="shortcuts-status" class="subtle" aria-live="polite"></span><button id="shortcuts-save" class="rules-save" type="button">Save shortcuts</button></div>
        </div>
      </div>
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
const DASHBOARD_VERSION=${JSON.stringify(dashboardVersion)};
const jobsTab=document.querySelector('#jobs-tab');
const usageTab=document.querySelector('#usage-tab');
const rulesTab=document.querySelector('#rules-tab');
const shortcutsTab=document.querySelector('#shortcuts-tab');
const jobsView=document.querySelector('#jobs-view');
const usageView=document.querySelector('#usage-view');
const rulesView=document.querySelector('#rules-view');
const shortcutsView=document.querySelector('#shortcuts-view');
const jobsWorkspace=document.querySelector('#jobs-workspace');
const jobList=document.querySelector('#job-list');
const jobsRefresh=document.querySelector('#jobs-refresh');
const jobSearch=document.querySelector('#job-search');
const repoFilter=document.querySelector('#repo-filter');
const quickStatus=document.querySelector('#quick-status');
const quickAutonomous=document.querySelector('#quick-autonomous');
const quickDraft=document.querySelector('#quick-draft');
const selectedJobRefresh=document.querySelector('#selected-job-refresh');
const mobileJobsBack=document.querySelector('#mobile-jobs-back');
const mobileJobs=window.matchMedia('(max-width:650px)');
const jobDetail=document.querySelector('#job-detail');
const taskTree=document.querySelector('#task-tree');
const taskDetailRoot=document.querySelector('#task-detail');
const eventFeed=document.querySelector('#event-feed');
const eventsAllTasks=document.querySelector('#events-all-tasks');
const eventsScope=document.querySelector('#events-scope');
const connection=document.querySelector('#connection');
const selectedJobTitle=document.querySelector('#selected-job-title');
const usageRoot=document.querySelector('#usage-root');
const usageMeta=document.querySelector('#usage-meta');
const rulesText=document.querySelector('#rules-text');
const rulesMeta=document.querySelector('#rules-meta');
const rulesStatus=document.querySelector('#rules-status');
const rulesSave=document.querySelector('#rules-save');
const shortcutsText=document.querySelector('#shortcuts-text');
const shortcutsStatus=document.querySelector('#shortcuts-status');
const shortcutsSave=document.querySelector('#shortcuts-save');
const rateLimitWarning=document.querySelector('#rate-limit-warning');
const runtimeSummary=document.querySelector('#runtime-summary');
let jobs=[];
let selectedJob=sessionStorage.getItem('agents-relay:selected-job');
let selectedTaskId=sessionStorage.getItem('agents-relay:selected-task');
let selectedRepo=sessionStorage.getItem('agents-relay:repo-filter')||'';
let quickMode=sessionStorage.getItem('agents-relay:quick-filter')||'jobs';
let selectedRuntimeStatus=sessionStorage.getItem('agents-relay:runtime-status-filter')||'';
let searchQuery=sessionStorage.getItem('agents-relay:job-search')||'';
let eventTaskId=selectedTaskId;
const collapsedTasks=new Set();
const expandedTasks=new Set();
const displayedEventIds=new Set();

function value(input){return input===null||input===undefined||input===''?'—':String(input);}
function text(input){return document.createTextNode(value(input));}
function element(name,className,child){const node=document.createElement(name);if(className)node.className=className;if(child)node.append(child);return node;}
function field(label,input){const box=element('div','detail-group');box.append(element('p','detail-label',text(label)),element('p','detail-value',text(input)));return box;}
function markdownField(label,input){const box=element('div','detail-group');box.append(element('p','detail-label',text(label)),markdownValue(input));return box;}
function rememberSelection(){if(selectedJob)sessionStorage.setItem('agents-relay:selected-job',selectedJob);else sessionStorage.removeItem('agents-relay:selected-job');if(selectedTaskId)sessionStorage.setItem('agents-relay:selected-task',selectedTaskId);else sessionStorage.removeItem('agents-relay:selected-task');}
function syncMobileJobsView(){const detail=mobileJobs.matches&&Boolean(selectedJob)&&location.hash.startsWith('#/jobs/');document.body.dataset.mobileJobsView=detail?'detail':'list';}
function selected(){return jobs.find(job=>job.id===selectedJob)||jobs[0]||null;}
function counts(tasks){const out={};for(const task of Array.isArray(tasks)?tasks:[])out[task.state]=(out[task.state]||0)+1;return out;}
function compactCounts(input){const order=['RUNNING','BLOCKED','UNBLOCKED','FAILED','QUEUED','DRAFT','SUCCEEDED','CANCELLED'];return order.filter(state=>input[state]).map(state=>input[state]+' '+state).join(', ')||'No tasks';}
function relativeTime(timestamp){if(!timestamp)return '—';const parsed=Date.parse(timestamp);if(!Number.isFinite(parsed))return value(timestamp);const seconds=Math.max(0,Math.round((Date.now()-parsed)/1000));if(seconds<60)return 'just now';if(seconds<3600)return Math.floor(seconds/60)+'m ago';if(seconds<86400)return Math.floor(seconds/3600)+'h ago';return Math.floor(seconds/86400)+'d ago';}
function cadence(job){const schedule=job?.schedule;if(!schedule?.cron)return '—';const cron=String(schedule.cron).trim();const timezone=value(schedule.timezone||'UTC');const fields=cron.split(/\\s+/);let label=cron;if(fields.length===5){const [minute,hour,day,month,weekday]=fields;if(day==='*'&&month==='*'&&weekday==='*'){const everyMinute=minute.match(/^\\*\\/(\\d+)$/);if(everyMinute&&hour==='*')label='Every '+everyMinute[1]+' min';else if(minute==='0'&&hour==='*')label='Hourly';else if(/^\\d+$/.test(minute)&&/^\\d+$/.test(hour)){const hh=String(Number(hour)).padStart(2,'0');const mm=String(Number(minute)).padStart(2,'0');label='Daily '+hh+':'+mm;}}}return label+' · '+cron+' · '+timezone;}
function safePrUrl(repository,prNumber){if(typeof repository!=='string'||!Number.isInteger(prNumber)||prNumber<=0)return null;const parts=repository.split('/');if(parts.length!==2)return null;const [owner,repo]=parts;if(!owner||!repo||owner==='.'||owner==='..'||repo==='.'||repo==='..')return null;if(!/^[A-Za-z0-9-]+$/.test(owner)||!/^[A-Za-z0-9._-]+$/.test(repo))return null;return 'https://github.com/'+owner+'/'+repo+'/pull/'+prNumber;}
function safeCommitUrl(repository,sha){if(typeof repository!=='string'||typeof sha!=='string'||!/^[0-9a-f]{7,64}$/i.test(sha))return null;const parts=repository.split('/');if(parts.length!==2||!parts[0]||!parts[1])return null;return 'https://github.com/'+parts[0]+'/'+parts[1]+'/commit/'+sha;}
function commitField(label,job,sha){const box=element('div','detail-group');box.append(element('p','detail-label',text(label)));const line=element('p','detail-value');const url=safeCommitUrl(job?.repository,sha);if(url){const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=sha.slice(0,7);line.append(link);}else line.append(text(sha||'—'));box.append(line);return box;}
function prField(job){const box=element('div','detail-group');box.append(element('p','detail-label',text('GitHub PR')));const line=element('p','detail-value');const url=safePrUrl(job.repository,job.prNumber);if(url){const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='PR #'+job.prNumber;line.append(link);}else line.append(text('unavailable'));box.append(line);return box;}
function chatField(task){const box=element('div','detail-group');box.append(element('p','detail-label',text('Chat')));const line=element('p','detail-value');if(task.adapter==='chatgpt'&&typeof task.threadId==='string'&&task.threadId){const link=document.createElement('a');link.href='https://chatgpt.com/c/'+encodeURIComponent(task.threadId);link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open chat';line.append(link);}else line.append(text('—'));box.append(line);return box;}
function taskCommentField(task){const box=element('div','detail-group');box.append(element('p','detail-label',text('PR comment')));const line=element('p','detail-value');if(typeof task.taskUrl==='string'&&task.taskUrl.startsWith('https://github.com/')){const link=document.createElement('a');link.className='task-link';link.href=task.taskUrl;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open task comment';line.append(link);}else line.append(text('—'));box.append(line);return box;}
function parseAgentGraphSource(source){if(typeof source!=='string'||!source.trim())return null;const agents=new Map(),edges=[];for(const raw of source.split(/\\r?\\n/)){const line=raw.trim();if(!line||line.startsWith('%%')||line.startsWith('flowchart '))continue;let match=line.match(/^([A-Za-z_][A-Za-z0-9_.-]*)(?:\\[agent:([A-Za-z_][A-Za-z0-9_.-]*)\\])?\\s*-->\\s*([A-Za-z_][A-Za-z0-9_.-]*)(?:\\[agent:([A-Za-z_][A-Za-z0-9_.-]*)\\])?$/);if(match){agents.set(match[1],match[2]||agents.get(match[1])||match[1]);agents.set(match[3],match[4]||agents.get(match[3])||match[3]);edges.push([match[1],match[3]]);continue;}match=line.match(/^([A-Za-z_][A-Za-z0-9_.-]*)\\[agent:([A-Za-z_][A-Za-z0-9_.-]*)\\]$/);if(match){agents.set(match[1],match[2]);continue;}return null;}const incoming=new Map([...agents.keys()].map(id=>[id,0]));for(const [,to] of edges)incoming.set(to,(incoming.get(to)||0)+1);const remaining=new Map(incoming),waves=[];let ready=[...remaining].filter(([,degree])=>degree===0).map(([id])=>id).sort();while(ready.length){waves.push(ready);const next=[];for(const id of ready)for(const [from,to] of edges)if(from===id){const degree=(remaining.get(to)||0)-1;remaining.set(to,degree);if(degree===0)next.push(to);}ready=[...new Set(next)].sort();}return {agents,waves};}
function agentGraphField(task){if(typeof task.agentGraph!=='string'||!task.agentGraph.trim())return null;const box=element('div','detail-group');box.style.gridColumn='1 / -1';box.append(element('p','detail-label',text('Task agent graph')));const graph=element('div','agent-graph');const parsed=parseAgentGraphSource(task.agentGraph);if(parsed&&parsed.waves.length){parsed.waves.forEach((wave,index)=>{const row=element('div','agent-wave');if(index>0)row.append(element('span','agent-arrow',text('↓')));for(const id of wave)row.append(element('span','agent-node',text(id+' · '+(parsed.agents.get(id)||id))));graph.append(row);});}const source=document.createElement('pre');source.className='agent-graph-source';source.textContent=task.agentGraph;graph.append(source);box.append(graph);return box;}
function clearEvents(){displayedEventIds.clear();eventFeed.replaceChildren(element('li','empty',text('Waiting for events.')));}
async function loadEventHistory(){if(!selectedJob){clearEvents();return;}const params=new URLSearchParams({job:selectedJob,limit:String(MAX_EVENTS)});if(eventTaskId)params.set('task',eventTaskId);try{const history=await loadJSON('/api/events?'+params.toString());clearEvents();for(const event of Array.isArray(history)?history.slice().reverse():[])addEvent(event);}catch{clearEvents();}}
function copySelectedJobIdentity(id){const job=jobs.find(candidate=>candidate.id===id);if(!job||!navigator.clipboard?.writeText)return;void navigator.clipboard.writeText(repoName(job.repository)+'/pr#'+job.prNumber).catch(()=>{});}
function selectJob(id){selectedJob=id;selectedTaskId=null;eventTaskId=null;rememberSelection();clearEvents();location.hash=id?'#/jobs/'+encodeURIComponent(id):'#/jobs';copySelectedJobIdentity(id);renderAll();void loadEventHistory();}
function matchesQuickFilter(job){if(quickMode==='autonomous')return job.executionMode==='autonomous';if(quickMode==='draft')return job.draft||job.state==='DRAFT';if(quickMode==='status')return !!selectedRuntimeStatus&&(job.runtimeStatus||'IDLE')===selectedRuntimeStatus;return true;}
function matchesSearch(job){const query=searchQuery.trim().toLowerCase();if(!query)return true;const pr=String(job.prNumber||'');const normalized=query.replace(/^pr\s*#?/,'').replace(/^#/,'');return String(job.title||job.id||'').toLowerCase().includes(query)||pr.includes(normalized);}
function filteredJobs(){return jobs.filter(job=>(!selectedRepo||job.repository===selectedRepo)&&matchesQuickFilter(job)&&matchesSearch(job));}
function setQuickMode(mode,status=''){quickMode=mode;selectedRuntimeStatus=mode==='status'?status:'';sessionStorage.setItem('agents-relay:quick-filter',quickMode);if(selectedRuntimeStatus)sessionStorage.setItem('agents-relay:runtime-status-filter',selectedRuntimeStatus);else sessionStorage.removeItem('agents-relay:runtime-status-filter');syncFilters();renderJobList();}
function toggleQuickMode(mode){setQuickMode(quickMode===mode?'jobs':mode);}
function syncFilters(){
  const repos=[...new Set(jobs.map(job=>job.repository).filter(Boolean))].sort();
  const previousRepo=selectedRepo;
  repoFilter.replaceChildren(new Option('All repos',''),...repos.map(repo=>new Option(repo,repo)));
  selectedRepo=repos.includes(previousRepo)?previousRepo:'';
  repoFilter.value=selectedRepo;
  const statuses=[...new Set(jobs.map(job=>job.runtimeStatus||'IDLE'))].sort();
  const previousStatus=selectedRuntimeStatus;
  quickStatus.replaceChildren(new Option('STATUS',''),...statuses.map(status=>new Option(status,status)));
  selectedRuntimeStatus=statuses.includes(previousStatus)?previousStatus:'';
  if(quickMode==='status'&&!selectedRuntimeStatus)quickMode='jobs';
  quickStatus.value=quickMode==='status'?selectedRuntimeStatus:'';
  quickAutonomous.setAttribute('aria-pressed',String(quickMode==='autonomous'));
  quickDraft.setAttribute('aria-pressed',String(quickMode==='draft'));
  jobSearch.value=searchQuery;
}
function repoName(repository){if(typeof repository!=='string'||!repository)return 'unknown-repo';const parts=repository.split('/').filter(Boolean);return parts.at(-1)||repository;}

const CHAT_SHORTCUTS_KEY='agents-relay:chatgpt-shortcuts';
const DEFAULT_CHAT_SHORTCUTS=[
  'Why blocked?: %1: why is it blocked? Find the root cause and move it forward.',
  'Move forward: %1: check the current state and move it forward.',
  'What is wrong?: %1: check the current state and explain what is wrong.'
].join('\\n');
function chatShortcutText(){return localStorage.getItem(CHAT_SHORTCUTS_KEY)||DEFAULT_CHAT_SHORTCUTS;}
function parseChatShortcuts(source){return String(source||'').split(/\\r?\\n/).map(line=>line.trim()).filter(Boolean).map(line=>{const split=line.indexOf(':');return split>0?{name:line.slice(0,split).trim(),prompt:line.slice(split+1).trim()}:null;}).filter(item=>item&&item.name&&item.prompt);}
function jobChatRef(job){return repoName(job?.repository)+'/pr#'+value(job?.prNumber);}
function chatShortcutUrl(prompt){return 'https://chatgpt.com/?prompt='+encodeURIComponent(prompt);}
function chatShortcutField(job){const box=element('div','detail-group');box.append(element('p','detail-label',text('ChatGPT shortcut')));const select=document.createElement('select');select.className='job-filter job-chat-shortcut-select';select.setAttribute('aria-label','ChatGPT shortcut');select.append(new Option('',''));for(const item of parseChatShortcuts(chatShortcutText()))select.append(new Option(item.name,item.prompt));select.value='';select.addEventListener('change',()=>{if(!select.value)return;const prompt=select.value.replaceAll('%1',jobChatRef(job));window.open(chatShortcutUrl(prompt),'_blank','noopener');select.value='';});box.append(select);return box;}
function renderJobList(){jobList.replaceChildren();const visible=filteredJobs();if(!jobs.length){jobList.append(element('li','empty',text('No durable jobs discovered.')));return;}if(!visible.length){jobList.append(element('li','empty',text('No jobs match the selected repo.')));return;}for(const job of visible){const row=element('div','job-row'+(isCompleteUnmerged(job)?' complete-unmerged':''));row.setAttribute('aria-current',String(job.id===selectedJob));row.addEventListener('click',()=>selectJob(job.id));const content=element('div','job-content');const select=document.createElement('button');select.type='button';select.className='job-button';select.setAttribute('aria-current',String(job.id===selectedJob));select.title=job.title||job.id;select.addEventListener('click',event=>{event.stopPropagation();selectJob(job.id);});select.append(element('span','job-title',text(repoName(job.repository)+'/PR#'+value(job.prNumber)+': '+value(job.title||job.id))));const states=element('span','job-status-line');states.append(element('span','badge '+value(job.state),text(value(job.state))),element('span','badge '+value(job.runtimeStatus||'IDLE'),text(value(job.runtimeStatus||'IDLE'))));if(job.executionMode==='autonomous')states.append(element('span','badge flag-autonomous',text('AUTONOMOUS')));if(job.reviewEnabled!==false&&job.githubState!=='MERGED')states.append(element('span','badge flag-review',text('REVIEW REQUIRED')));if(job.githubState==='MERGED'&&job.publication?.version)states.append(element('span','badge SUCCEEDED',text('v'+job.publication.version)));if(isCompleteUnmerged(job))states.append(element('span','badge MERGE_PENDING',text('MERGE PENDING')));const primary=element('div','job-primary');primary.append(states);const lastLine=element('div','job-last-line');lastLine.append(element('span','subtle',text(compactCounts(counts(job.tasks)))),element('span','subtle',text(relativeTime(job.updatedAt))));content.append(select,primary,lastLine);row.append(content);jobList.append(element('li','',row));}}
function taskTagDisplay(job,task){const display=task.tag&&job?.tag?.values?.[task.tag];return typeof display==='string'&&display?display:null;}
function taskSubtreeComplete(task,children){return ['SUCCEEDED','CANCELLED'].includes(task.state)&&(children.get(task.id)||[]).every(child=>taskSubtreeComplete(child,children));}
function taskNode(task,children,depth){const li=element('li');const nested=children.get(task.id)||[];const line=element('div','task-line');if(nested.length){const key=(selectedJob||'')+':'+task.id;const collapsed=collapsedTasks.has(key)||(!expandedTasks.has(key)&&taskSubtreeComplete(task,children));const fold=document.createElement('button');fold.type='button';fold.className='task-fold';fold.setAttribute('aria-expanded',String(!collapsed));fold.setAttribute('aria-label',(collapsed?'Expand ':'Collapse ')+task.id);fold.textContent=collapsed?'▸':'▾';line.append(fold);const ul=element('ul','tree');ul.hidden=collapsed;for(const child of nested)ul.append(taskNode(child,children,depth+1));fold.addEventListener('click',()=>{const next=!ul.hidden;ul.hidden=next;fold.setAttribute('aria-expanded',String(!next));fold.setAttribute('aria-label',(next?'Expand ':'Collapse ')+task.id);fold.textContent=next?'▸':'▾';if(next){collapsedTasks.add(key);expandedTasks.delete(key);}else{collapsedTasks.delete(key);expandedTasks.add(key);}});li.append(line,ul);}else li.append(line);const row=document.createElement('button');row.type='button';row.className='task-row';row.setAttribute('aria-current',String(task.id===selectedTaskId));row.title=task.id;row.addEventListener('click',()=>{const deselect=selectedTaskId===task.id;selectedTaskId=deselect?null:task.id;eventTaskId=deselect?null:task.id;rememberSelection();clearEvents();renderAll();void loadEventHistory();});const id=element('span','task-id',text(task.id));id.style.paddingLeft=Math.min(depth,4)*6+'px';row.append(id,element('span','badge '+value(task.state),text(task.state)));const tag=taskTagDisplay(selected(),task);if(tag){const badge=element('span','task-tag',text(tag));badge.title=(selected()?.tag?.description||'Task tag')+': '+task.tag;row.append(badge);}line.append(row);return li;}
function buildTree(tasks){taskTree.replaceChildren();if(!Array.isArray(tasks)||!tasks.length){taskTree.append(element('li','empty',text('No tasks in durable state.')));return;}const work=tasks.filter(task=>task.kind!=='planner');if(!work.length){taskTree.append(element('li','empty',text('No work tasks in durable state.')));return;}const known=new Set(work.map(task=>task.id));const children=new Map();const roots=[];for(const task of work){if(!task.parentTaskId||!known.has(task.parentTaskId))roots.push(task);else{const siblings=children.get(task.parentTaskId)||[];siblings.push(task);children.set(task.parentTaskId,siblings);}}for(const task of roots)taskTree.append(taskNode(task,children,0));}
function attemptBudget(task){const attempt=Number(task?.attempt)||0;const max=Number(task?.maxAttempts)||0;if(max>=3&&max%3===0){const effectiveMax=Math.max(max,Math.ceil(attempt/3)*3);return attempt+' / 3×'+(effectiveMax/3);}return attempt+' / '+max;}
const JOB_STATES=['DRAFT','ACTIVE','COMPLETED','CANCELLED'];
async function setJobState(job,state,select){if(!job||state===job.state)return;select.disabled=true;try{const response=await fetch('/api/job-state?id='+encodeURIComponent(job.id)+'&state='+encodeURIComponent(state),{method:'POST'});if(!response.ok)throw new Error(response.status+' '+response.statusText);const updated=await response.json();const index=jobs.findIndex(candidate=>candidate.id===job.id);if(index>=0)jobs[index]=updated;else jobs.push(updated);renderAll();void loadEventHistory();}catch(error){select.title='Set job lifecycle state: '+error.message;select.value=job.state;}finally{select.disabled=false;}}
function jobStateField(job){const box=element('div','detail-group');box.append(element('p','detail-label',text('Lifecycle state')));const select=document.createElement('select');select.className='job-filter job-state-select';select.setAttribute('aria-label','Job lifecycle state');for(const state of JOB_STATES)select.append(new Option(state,state));select.value=job.state;select.addEventListener('change',()=>void setJobState(job,select.value,select));box.append(select);return box;}
const TASK_STATES=['DRAFT','QUEUED','RUNNING','BLOCKED','UNBLOCKED','SUCCEEDED','FAILED','CANCELLED'];
async function setTaskState(task,state,select){const job=selected();if(!job||state===task.state)return;select.disabled=true;try{const response=await fetch('/api/task-state?id='+encodeURIComponent(job.id)+'&task='+encodeURIComponent(task.id)+'&state='+encodeURIComponent(state),{method:'POST'});if(!response.ok)throw new Error(response.status+' '+response.statusText);const updated=await response.json();const index=jobs.findIndex(candidate=>candidate.id===job.id);if(index>=0)jobs[index]=updated;else jobs.push(updated);renderAll();void loadEventHistory();}catch(error){select.title='Set task state: '+error.message;select.value=task.state;}finally{select.disabled=false;}}
function taskStateField(task){const box=element('div','detail-group');box.append(element('p','detail-label',text('State')));const select=document.createElement('select');select.className='job-filter task-state-select';select.setAttribute('aria-label','Task state');for(const state of TASK_STATES){const option=new Option(state,state);if(state==='UNBLOCKED'&&task.state!=='UNBLOCKED')option.disabled=true;select.append(option);}select.value=task.state;select.addEventListener('change',()=>void setTaskState(task,select.value,select));box.append(select);return box;}
function manualOverrideField(task){const rows=Array.isArray(task.manualStateOverrides)?task.manualStateOverrides:[];const last=rows.at(-1);return field('Manual override',last?last.from+' → '+last.to+' · '+relativeTime(last.at):'—');}
function renderTaskDetail(task){taskDetailRoot.replaceChildren();if(!task){taskDetailRoot.append(element('p','empty',text('Select a task to inspect execution details.')));return;}const routing=task.routing||{};const groups=element('div','detail-groups');groups.append(field('Task',task.id),field('Kind',task.kind||'work'),taskStateField(task),manualOverrideField(task),field('Planning decision',task.planningDecisionId||'—'),field('Planning source',task.planningSource||'—'),field('Planning round',task.planningRound===undefined?'—':String(task.planningRound)),field('Project / agent',value(task.projectName)+' / '+value(task.agentName)),field('Parent task',task.parentTaskId||'root'),field('Adapter',task.adapter),field('Provider / model',value(routing.provider)+' / '+value(routing.model)),field('Reasoning / profile',value(routing.reasoning||routing.profile)),field('Attempt',attemptBudget(task)),field('Dependencies',Array.isArray(task.dependencies)&&task.dependencies.length?task.dependencies.join(', '):'none'),taskCommentField(task),chatField(task));const job=selected();if(task.reviewHeadSha&&job)groups.append(commitField('HEAD commit',job,task.reviewHeadSha));const graph=agentGraphField(task);if(graph)groups.append(graph);if(task.plannerResult)groups.append(field('Objective status',task.plannerResult.objective_status),markdownField('Assessment',task.plannerResult.assessment));if(task.error)groups.append(field('Error',task.error));taskDetailRoot.append(groups);}
function reviewStatus(job){const review=job?.review;if(!review)return 'Not started';if(review.outcome==='approved'&&review.headSha===job.headSha)return 'MERGE READY · approved';const stale=Array.isArray(job?.tasks)&&job.tasks.some(task=>task.agentName==='reviewer'&&task.reviewHeadSha&&job.headSha&&task.reviewHeadSha!==job.headSha);if(stale)return 'STALE · awaiting review';return String(review.outcome||'pending').replace('_',' ').toUpperCase();}
function renderSelectedJob(){jobDetail.replaceChildren();const job=selected();if(!job){selectedJobTitle.textContent='';jobDetail.append(element('div','empty',text('No durable jobs discovered.')));buildTree([]);renderTaskDetail(null);return;}selectedJobTitle.textContent=value(job.title||job.id);if(job.id!==selectedJob){selectedJob=job.id;selectedTaskId=null;eventTaskId=null;clearEvents();rememberSelection();}const summary=element('div','job-summary');summary.append(field('PR state',job.githubState||'UNKNOWN'),jobStateField(job),field('Runtime status',job.runtimeStatus||'IDLE'),field('Execution mode',job.executionMode||'fixed'),field('Cadence',cadence(job)),field('Review',reviewStatus(job)),commitField('Review head SHA',job,job.review?.headSha||job.headSha||''),prField(job),field('Repository',job.repository||'—'),field('Last activity',relativeTime(job.updatedAt)),field('Task states',compactCounts(job.tasks)),chatShortcutField(job));jobDetail.append(summary);const selectedTask=(job.tasks||[]).find(task=>task.id===selectedTaskId)||null;if(selectedTaskId&&!selectedTask){selectedTaskId=null;eventTaskId=null;clearEvents();rememberSelection();}buildTree(job.tasks||[]);renderTaskDetail(selectedTask);renderEventScope();}
function renderAll(){jobs.sort(compareJobs);syncFilters();renderJobList();renderSelectedJob();syncMobileJobsView();}
function isCompleteUnmerged(job){return job.runtimeStatus==='MERGE_PENDING';}
function isTerminalJob(job){return ['COMPLETED','CANCELLED'].includes(job.state)||['MERGED','CLOSED'].includes(job.githubState);}
function jobGroup(job){if(isTerminalJob(job))return 3;if(job.executionMode==='autonomous')return 1;if(job.draft||job.state==='DRAFT')return 2;return 0;}
function compareJobs(a,b){const groupDelta=jobGroup(a)-jobGroup(b);if(groupDelta)return groupDelta;const mergePendingDelta=Number(isCompleteUnmerged(b))-Number(isCompleteUnmerged(a));return mergePendingDelta||String(b.updatedAt).localeCompare(String(a.updatedAt));}
async function loadJSON(url){const response=await fetch(url);if(!response.ok)throw new Error(response.status+' '+response.statusText);return response.json();}
async function refreshVersion(){try{const live=await loadJSON('/api/version');if(live?.version&&live.version!==DASHBOARD_VERSION)location.reload();}catch{}}
function renderRateLimitStatus(status){
  if(!status?.limited){rateLimitWarning.hidden=true;rateLimitWarning.textContent='';return;}
  const until=status.cooldownUntil?new Date(status.cooldownUntil):null;
  const suffix=until&&!Number.isNaN(until.getTime())?' Live GitHub refresh will retry after '+until.toLocaleTimeString()+'.':' Live GitHub refresh is temporarily paused.';
  rateLimitWarning.textContent='GitHub API rate limit reached. Showing cached job data.'+suffix;
  rateLimitWarning.hidden=false;
}
function runtimePill(label,value){const pill=element('span','runtime-stat');pill.append(document.createTextNode(label+' '),element('strong','',text(value)));return pill;}
async function drawRuntimeSummary(){try{const summary=await loadJSON('/api/runtime-summary');runtimeSummary.replaceChildren(runtimePill('Active Jobs',summary.activeJobs||0),runtimePill('Running Tasks',summary.runningTasks||0),runtimePill('ChatGPT',summary.workers?.chatgpt||0),runtimePill('Codex',summary.workers?.codex||0));for(const item of Array.isArray(summary.models)?summary.models:[])runtimeSummary.append(runtimePill(item.model,item.count));}catch{runtimeSummary.replaceChildren();}}
async function refreshStatus(){try{renderRateLimitStatus(await loadJSON('/api/status'));}catch{renderRateLimitStatus(null);}}
async function refresh(force=false){jobsRefresh.disabled=true;jobsRefresh.textContent='Refreshing…';try{const discovered=await loadJSON('/api/jobs'+(force?'?refresh=1':''));jobs=Array.isArray(discovered)?discovered:[];void drawRuntimeSummary();jobs.sort(compareJobs);if(selectedJob&&!jobs.some(job=>job.id===selectedJob)){selectedJob=null;selectedTaskId=null;}if(!selectedJob){const match=location.hash.match(/^#\\/jobs\\/(.+)$/);const fromHash=match?decodeURIComponent(match[1]):null;selectedJob=jobs.some(job=>job.id===fromHash)?fromHash:(jobs[0]?.id||null);}rememberSelection();renderAll();void loadEventHistory();connection.textContent='';connection.setAttribute('aria-label','Live durable state connected');connection.className='status-pill ok';}catch(error){connection.textContent='';connection.setAttribute('aria-label','Durable state unavailable');connection.className='status-pill bad';jobList.replaceChildren(element('li','error-state',text('Could not load jobs: '+error.message)));}finally{jobsRefresh.disabled=false;jobsRefresh.textContent='Refresh';}}
function renderEventScope(){const task=eventTaskId&&selected()?.tasks?.find(candidate=>candidate.id===eventTaskId);eventsAllTasks.disabled=!task;eventsAllTasks.setAttribute('aria-pressed',String(!task));eventsScope.textContent=task?'Task '+task.id+' · newest first · 60 max':'Job-wide · newest first · 60 max';}
function eventLabel(type){return ({'task.process.launched':'Process launched','task.started':'Worker started','task.process.exited':'Sync process exited','task.process.async_exited':'Async process exited','task.completed':'Worker completed','task.failed':'Worker failed','task.blocked':'Worker blocked','review.started':'Review started','review.approved':'Review approved','review.changes_required':'Review changes required','review.blocked':'Review blocked'})[type]||type||'Event';}
function addEvent(event,level){if(!event||selectedJob&&event.job_id&&event.job_id!==selectedJob||eventTaskId&&event.task_id!==eventTaskId)return;if(event.event_id&&displayedEventIds.has(event.event_id))return;if(event.event_id)displayedEventIds.add(event.event_id);const item=element('li','event-item');const meta=element('div','event-meta');meta.append(element('span','event-kind',text(eventLabel(event.type))),element('span','event-type',text(event.type||'event')),element('span','',text(relativeTime(event.timestamp))),element('span','',text('task: '+value(event.task_id))));item.append(meta);const message=element('p','event-message',text(event.message||'Event received'));if(level==='error'||event.level==='error')message.classList.add('error-text');item.append(message);eventFeed.querySelector('.empty')?.remove();eventFeed.prepend(item);while(eventFeed.children.length>MAX_EVENTS)eventFeed.lastElementChild?.remove();}
function resetText(windowData){if(!Number.isFinite(windowData.resetsAt))return '';const at=new Date(windowData.resetsAt*1000);const minutes=Math.max(0,Math.ceil((at.getTime()-Date.now())/60000));const relative=minutes<60?minutes+'m':minutes<1440?Math.floor(minutes/60)+'h '+minutes%60+'m':Math.floor(minutes/1440)+'d '+Math.floor((minutes%1440)/60)+'h';return 'Resets '+at.toLocaleString()+' · in '+relative;}
function usageBar(label,windowData){const percent=Math.max(0,Math.min(100,100-windowData.usedPercent));const row=element('div','usage-row');const heading=element('div','usage-label');heading.append(element('span','',text(label)),element('span','',text(Math.round(percent)+'%')));const track=element('div','usage-track');track.setAttribute('role','progressbar');track.setAttribute('aria-label',label+' available');track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');track.setAttribute('aria-valuenow',String(percent));const fill=element('div','usage-fill');fill.style.width=percent+'%';track.append(fill);row.append(heading,track);const reset=resetText(windowData);if(reset)row.append(element('div','subtle',text(reset)));return row;}
function usageProvider(provider){const card=element('section','usage-provider');card.append(element('h3','',text(provider.label)));const usage=provider.usage||{};if(!usage.available||!usage.fiveHour||!usage.weekly){card.append(element('p','empty',text(usage.reason||'Account usage telemetry is unavailable.')));return card;}const bars=element('div','usage-bars');bars.append(usageBar('5-hour remaining',usage.fiveHour),usageBar('Weekly remaining',usage.weekly));card.append(bars);return card;}
function formatCredit(value,currency){if(value===null||value===undefined||!Number.isFinite(Number(value)))return '—';const number=Number(value);if(currency==='USD')return '$'+number.toFixed(2);if(currency==='CNY')return '¥'+number.toFixed(2);return number.toFixed(2)+' '+currency;}
function creditProvider(provider){const row=element('section','usage-provider');row.append(element('h3','',text(provider.label)));const credits=provider.credits||{};if(!credits.available||!Array.isArray(credits.balances)||!credits.balances.length){row.append(element('p','empty',text(credits.reason||'Credit balance is unavailable.')));return row;}const balance=credits.balances[0];row.append(element('div','detail-value',text(formatCredit(balance.remaining,balance.currency))));return row;}
function shortReset(reset){if(!Number.isFinite(reset))return '';const at=new Date(reset*1000);const minutes=Math.max(0,Math.ceil((at.getTime()-Date.now())/60000));const relative=minutes<60?minutes+'m':minutes<1440?Math.floor(minutes/60)+'h '+minutes%60+'m':Math.floor(minutes/1440)+'d '+Math.floor((minutes%1440)/60)+'h';return 'Reset '+relative;}
function githubBucket(label,bucket){const row=element('div','usage-row');const heading=element('div','usage-label');heading.append(element('span','',text(label)),element('span','',text(bucket.remaining+' / '+bucket.limit)));const percent=bucket.limit>0?Math.max(0,Math.min(100,100*bucket.remaining/bucket.limit)):0;const track=element('div','usage-track');track.setAttribute('role','progressbar');track.setAttribute('aria-label',label+' remaining');track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');track.setAttribute('aria-valuenow',String(Math.round(percent)));const fill=element('div','usage-fill');fill.style.width=percent+'%';track.append(fill);row.append(heading,track);const reset=shortReset(bucket.reset);if(reset){const hint=element('div','subtle',text(reset));hint.title=new Date(bucket.reset*1000).toLocaleString();row.append(hint);}return row;}
function githubCounterLine(label,values){const entries=Object.entries(values||{}).sort((a,b)=>Number(b[1])-Number(a[1])).slice(0,8);return entries.length?element('div','subtle',text(label+' · '+entries.map(([key,count])=>key+' '+count).join(' · '))):null;}
function githubObserved(label,observed){
  if(!observed)return null;
  const state=observed.throttled?'Throttled':observed.available===true?'Available':observed.available===false?'Unavailable':'Unknown';
  const parts=[label+' observed',state];
  if(observed.status!==null)parts.push('status '+observed.status);
  if(observed.remaining!==null)parts.push('remaining '+observed.remaining);
  if(observed.headersCaptured&&observed.reset!==null)parts.push(shortReset(observed.reset));
  if(observed.retryAfterSeconds!==null)parts.push('retry '+observed.retryAfterSeconds+'s');
  const row=element('div',observed.throttled?'usage-row error-state':'usage-row subtle');
  row.textContent=parts.filter(Boolean).join(' · ');
  if(observed.reason)row.title=observed.reason;
  return row;
}
function githubDiagnostics(status){const body=element('div','usage-details-body');if(status?.calls)body.append(element('div','subtle',text('Calls · GraphQL '+(status.calls.graphql||0)+' · REST '+(status.calls.rest||0)+' · quota '+(status.calls.rateLimit||0))));const operations=githubCounterLine('GraphQL operations',status?.graphql?.operations);if(operations)body.append(operations);const contexts=githubCounterLine('GraphQL contexts',status?.graphql?.contexts);if(contexts)body.append(contexts);if(status?.readPaths){body.append(element('div','subtle',text('Reads · scans '+(status.readPaths.workspaceScans||0)+' · PR '+(status.readPaths.prRefreshes||0)+' · coalesced '+(status.readPaths.prRefreshCoalesced||0))));const triggers=githubCounterLine('Refresh triggers',status.readPaths.prRefreshesByTrigger);if(triggers)body.append(triggers);const coalesced=githubCounterLine('Coalesced',status.readPaths.prRefreshCoalescedByTrigger);if(coalesced)body.append(coalesced);}if(!body.children.length)return null;const details=element('details','usage-details');details.append(element('summary','',text('Diagnostics')),body);return details;}
function githubUsageCard(snapshot,status){
  const card=element('section','usage-provider');
  card.append(element('h3','',text('GitHub API')));
  const resources=snapshot?.resources||{};
  const bars=element('div','usage-bars');
  bars.append(element('div','usage-label',text('Primary quota (/rate_limit)')));
  if(resources.core)bars.append(githubBucket('REST',resources.core));
  if(resources.graphql)bars.append(githubBucket('GraphQL',resources.graphql));
  if(resources.search)bars.append(githubBucket('Search',resources.search));
  if(!bars.children.length)bars.append(element('p','empty',text('Quota unavailable')));
  const observed=status?.runtimeRateUsage?.resources||{};
  for(const row of [githubObserved('REST',observed.core),githubObserved('GraphQL',observed.graphql),githubObserved('Search',observed.search)])if(row)bars.append(row);
  if(status?.runtimeRateUsage?.rejection){
    const rejection=status.runtimeRateUsage.rejection;
    const cooldown=rejection.cooldownUntil?' · cooldown '+new Date(rejection.cooldownUntil).toLocaleTimeString():'';
    bars.append(element('div','error-state',text('Throttled · '+(rejection.kind==='unknown'?'rate limit':rejection.kind)+' limit'+cooldown)));
  }
  if(status?.limited){
    const until=status.cooldownUntil?' until '+new Date(status.cooldownUntil).toLocaleTimeString():'';
    bars.append(element('div','error-state',text('Cooldown active'+until)));
  }
  const diagnostics=githubDiagnostics(status);
  if(diagnostics)bars.append(diagnostics);
  card.append(bars);
  return card;
}
async function drawUsage(){try{const overview=await loadJSON('/api/usage');usageRoot.replaceChildren();usageMeta.textContent='Real account telemetry when available';const providers=Array.isArray(overview.providers)?overview.providers:[];const credits=Array.isArray(overview.credits)?overview.credits:[];const grid=element('div','usage-providers');if(overview.github||overview.githubStatus)grid.append(githubUsageCard(overview.github,overview.githubStatus));for(const provider of providers)grid.append(usageProvider(provider));for(const provider of credits)grid.append(creditProvider(provider));if(!grid.children.length){usageRoot.append(element('p','empty',text('Usage telemetry is unavailable.')));return;}usageRoot.append(grid);}catch(error){usageMeta.textContent='Unavailable';usageRoot.replaceChildren(element('p','error-state',text('Usage unavailable: '+error.message)));}}
async function drawRules(){rulesStatus.textContent='';try{const rules=await loadJSON('/api/execution-router-rules');rulesText.value=typeof rules.text==='string'?rules.text:'';rulesMeta.textContent=rules.hash&&rules.hash!=='none'?'Loaded · '+rules.hash.slice(0,12):'No custom rules saved';}catch(error){rulesMeta.textContent='Unavailable';rulesStatus.textContent='Could not load rules: '+error.message;}}
async function saveRules(){rulesSave.disabled=true;rulesStatus.textContent='Saving…';try{const response=await fetch('/api/execution-router-rules',{method:'PUT',headers:{'content-type':'text/plain; charset=utf-8'},body:rulesText.value});if(!response.ok)throw new Error(response.status+' '+await response.text());const rules=await response.json();rulesMeta.textContent='Saved · '+rules.hash.slice(0,12);rulesStatus.textContent='Saved. New routing decisions will load these rules.';}catch(error){rulesStatus.textContent='Save failed: '+error.message;}finally{rulesSave.disabled=false;}}
async function drawShortcuts(){shortcutsStatus.textContent='';shortcutsText.value=chatShortcutText();}
function saveShortcuts(){const value=shortcutsText.value.trim();if(value)localStorage.setItem(CHAT_SHORTCUTS_KEY,value);else localStorage.removeItem(CHAT_SHORTCUTS_KEY);shortcutsText.value=chatShortcutText();shortcutsStatus.textContent='Saved.';}
function showView(view){const isJobs=view==='jobs';const isUsage=view==='usage';const isRules=view==='rules';const isShortcuts=view==='shortcuts';jobsView.hidden=!isJobs;jobsWorkspace.hidden=!isJobs;usageView.hidden=!isUsage;rulesView.hidden=!isRules;shortcutsView.hidden=!isShortcuts;jobsTab.setAttribute('aria-selected',String(isJobs));usageTab.setAttribute('aria-selected',String(isUsage));rulesTab.setAttribute('aria-selected',String(isRules));shortcutsTab.setAttribute('aria-selected',String(isShortcuts));if(isJobs)void refresh();else if(isUsage)void drawUsage();else if(isRules)void drawRules();else void drawShortcuts();}
jobsTab.addEventListener('click',()=>{location.hash=selectedJob?'#/jobs/'+encodeURIComponent(selectedJob):'#/jobs';showView('jobs');});
jobsRefresh.addEventListener('click',()=>void refresh(true));
eventsAllTasks.addEventListener('click',()=>{eventTaskId=null;clearEvents();renderEventScope();void loadEventHistory();});
repoFilter.addEventListener('change',()=>{selectedRepo=repoFilter.value;sessionStorage.setItem('agents-relay:repo-filter',selectedRepo);renderJobList();});
jobSearch.addEventListener('input',()=>{searchQuery=jobSearch.value;sessionStorage.setItem('agents-relay:job-search',searchQuery);renderJobList();});
quickAutonomous.addEventListener('click',()=>toggleQuickMode('autonomous'));
quickDraft.addEventListener('click',()=>toggleQuickMode('draft'));
quickStatus.addEventListener('change',()=>setQuickMode(quickStatus.value?'status':'jobs',quickStatus.value));
selectedJobRefresh.addEventListener('click',()=>void refreshSelected());
mobileJobsBack.addEventListener('click',()=>{location.hash='#/jobs';syncMobileJobsView();window.scrollTo({top:0,behavior:'instant'});});
mobileJobs.addEventListener('change',syncMobileJobsView);
window.addEventListener('hashchange',syncMobileJobsView);
usageTab.addEventListener('click',()=>{location.hash='#/usage';showView('usage');});
rulesTab.addEventListener('click',()=>{location.hash='#/execution-router-rules';showView('rules');});
shortcutsTab.addEventListener('click',()=>{location.hash='#/shortcuts';showView('shortcuts');});
rulesSave.addEventListener('click',()=>void saveRules());
shortcutsSave.addEventListener('click',saveShortcuts);
window.addEventListener('keydown',event=>{if(event.key==='Tab'&&event.altKey){event.preventDefault();const next=location.hash==='#/usage'?'rules':location.hash==='#/execution-router-rules'?'jobs':'usage';location.hash=next==='usage'?'#/usage':next==='rules'?'#/execution-router-rules':(selectedJob?'#/jobs/'+encodeURIComponent(selectedJob):'#/jobs');showView(next);}});
function parseMessage(message){try{return JSON.parse(message.data);}catch{return null;}}
const stream=new EventSource('/events');
stream.onopen=()=>{connection.textContent='';connection.setAttribute('aria-label','Event stream connected');connection.className='status-pill ok';};
stream.onerror=()=>{connection.textContent='';connection.setAttribute('aria-label','Event stream reconnecting');connection.className='status-pill warn';};
stream.onmessage=message=>{const payload=parseMessage(message);if(payload?.job){const index=jobs.findIndex(job=>job.id===payload.job.id);if(index>=0)jobs[index]=payload.job;else jobs.push(payload.job);renderAll();void drawRuntimeSummary();}};
stream.addEventListener('relay',message=>{const payload=parseMessage(message);if(payload?.job){const index=jobs.findIndex(job=>job.id===payload.job.id);if(index>=0)jobs[index]=payload.job;else jobs.push(payload.job);}if(payload?.event)addEvent(payload.event);renderAll();void drawRuntimeSummary();});
if(location.hash==='#/usage')showView('usage');else if(location.hash==='#/execution-router-rules')showView('rules');else if(location.hash==='#/shortcuts')showView('shortcuts');else showView('jobs');
setInterval(()=>{if(location.hash!=='#/usage'&&location.hash!=='#/execution-router-rules'&&location.hash!=='#/shortcuts')void refresh();},300000);
setInterval(()=>{if(location.hash==='#/usage')void drawUsage();},30000);
setInterval(()=>void refreshVersion(),30000);
async function refreshSelected(){if(!selectedJob){await refresh();return;}selectedJobRefresh.disabled=true;selectedJobRefresh.textContent='Refreshing…';try{const updated=await loadJSON('/api/job?id='+encodeURIComponent(selectedJob));const index=jobs.findIndex(job=>job.id===selectedJob);if(index>=0)jobs[index]=updated;else jobs.push(updated);rememberSelection();renderAll();connection.textContent='';connection.setAttribute('aria-label','Live durable state connected');connection.className='status-pill ok';}catch(error){connection.textContent='';connection.setAttribute('aria-label','Durable state unavailable');connection.className='status-pill bad';}finally{selectedJobRefresh.disabled=false;selectedJobRefresh.textContent='Refresh';}}
</script>
</body>
</html>`;
