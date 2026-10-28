export const dashboardStyles = `  <style>
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
    .job-filter[multiple] { height:5.6rem; }
    .jobs-pagination { display:flex; gap:.3rem; align-items:center; }
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
    .status-pill.neutral,.badge.IDLE,.badge.CANCELLED { background:#edf0f4; color:var(--muted); }
    .badge.DRAFT { background:#eef2ff; color:#3f51b5; }
    .badge.MERGE_PENDING { background:#ffe3a3; color:#7a4a00; }
    .details-dialog { width:min(850px,calc(100vw - 2rem)); max-height:85vh; overflow:auto; border:1px solid var(--border); border-radius:.6rem; background:var(--surface); color:var(--text); box-shadow:0 18px 55px #0004; padding:1rem; } .details-dialog::backdrop { background:#17202b99; } .details-dialog-head { display:flex; justify-content:space-between; align-items:center; gap:1rem; position:sticky; top:-1rem; background:var(--surface); padding:.5rem 0; } .details-dialog pre { white-space:pre-wrap; overflow-wrap:anywhere; background:var(--surface2); padding:.7rem; border-radius:.4rem; } .details-dialog h3 { font-size:.8rem; margin:1rem 0 .3rem; }
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
    .event-item { padding:.34rem .42rem .42rem; border-left:3px solid transparent; border-bottom:1px solid var(--border); border-radius:.28rem; }
    .event-item.event-error { border-left-color:var(--bad); background:#fff4f4; }
    .event-item.event-error .event-kind,.event-item.event-error .event-message { color:var(--bad); }
    .event-item.event-warn { border-left-color:var(--warn); background:#fff9eb; }
    .event-item.event-warn .event-kind { color:var(--warn); }
    .event-meta { display:flex; flex-wrap:wrap; gap:.4rem; color:var(--muted); font-size:.68rem; }
    .event-kind { color:var(--accent); font-weight:800; }
    .event-message { margin:.12rem 0 0; overflow-wrap:anywhere; }
    #usage-view,#graphs-view,#rules-view,#shortcuts-view,#worker-rules-view { grid-column:1 / -1; }
    .graphs-browser { display:grid; grid-template-columns:minmax(190px,260px) minmax(0,1fr); gap:.75rem; min-height:60vh; }
    .graph-list { display:grid; align-content:start; gap:.35rem; }
    .graph-button { width:100%; display:grid; gap:.08rem; padding:.48rem .55rem; border:1px solid var(--border); border-radius:.4rem; background:var(--surface2); color:var(--text); text-align:left; font:inherit; cursor:pointer; }
    .graph-button[aria-current="true"] { border-color:var(--accent); background:var(--accent2); }
    .graph-button strong { font-size:.78rem; }
    .graph-button span { color:var(--muted); font:.66rem ui-monospace,SFMono-Regular,Menlo,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .graph-preview { min-width:0; display:grid; align-content:start; gap:.55rem; }
    .graph-preview-head { display:flex; justify-content:space-between; gap:.7rem; align-items:baseline; flex-wrap:wrap; }
    .graph-preview-head h3 { margin:0; font-size:.95rem; }
    .graph-canvas { min-height:24rem; display:grid; place-items:center; overflow:auto; padding:1rem; border:1px solid var(--border); border-radius:.45rem; background:var(--surface2); }
    .graph-canvas svg { max-width:none; height:auto; }
    .graph-canvas svg rect.background { display:none; }
    .graph-canvas svg .edgeLabel rect, .graph-canvas svg .edgeLabel .labelBkg, .graph-canvas svg .edgeLabel .background { fill:transparent !important; opacity:0 !important; }
    .graph-navigation { display:flex; flex-wrap:wrap; align-items:center; gap:.5rem; margin-bottom:.7rem; }
    .graph-canvas .node.drillable { cursor:pointer; }
    .graph-canvas .node.drillable text, .graph-canvas .node.drillable tspan { fill:#2367b1; }
    .graph-dialog { width:96vw; height:94vh; max-width:none; max-height:none; padding:.7rem; border:1px solid var(--border); border-radius:.5rem; background:var(--surface); color:var(--text); }
    .graph-dialog::backdrop { background:#17202b99; }
    .graph-dialog-header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:.7rem; padding:.3rem .5rem; }
    .graph-dialog-viewport { height:calc(94vh - 5rem); overflow:auto; cursor:grab; background:var(--surface2); border:1px solid var(--border); border-radius:.4rem; }
    .graph-dialog-viewport:active { cursor:grabbing; }
    .graph-dialog-viewport .graph-canvas { display:block; width:max-content; min-width:100%; min-height:100%; overflow:visible; }
    .graph-canvas .node text { pointer-events:none; }
    .graph-source { margin:0; max-height:22rem; overflow:auto; padding:.7rem; border:1px solid var(--border); border-radius:.4rem; background:var(--surface2); color:var(--muted); font:.72rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre; }
    .graph-source-details summary { cursor:pointer; color:var(--muted); font-size:.74rem; font-weight:700; }
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
      #jobs-view #status-filter { display:none; }
      #jobs-view .panel-body { max-height:none; }
      #jobs-workspace { gap:.65rem; }
      #jobs-workspace .panel-body { max-height:none; }
      #usage-view .panel-head { padding:.6rem .7rem .35rem; }
      #usage-view .panel-head .subtle { display:none; }
      .graphs-browser { grid-template-columns:1fr; min-height:0; }
      .graph-list { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .graph-canvas { min-height:18rem; }
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
      .details-dialog { width:min(850px,calc(100vw - 2rem)); max-height:85vh; overflow:auto; border:1px solid var(--border); border-radius:.6rem; background:var(--surface); color:var(--text); box-shadow:0 18px 55px #0004; padding:1rem; } .details-dialog::backdrop { background:#17202b99; } .details-dialog-head { display:flex; justify-content:space-between; align-items:center; gap:1rem; position:sticky; top:-1rem; background:var(--surface); padding:.5rem 0; } .details-dialog pre { white-space:pre-wrap; overflow-wrap:anywhere; background:var(--surface2); padding:.7rem; border-radius:.4rem; } .details-dialog h3 { font-size:.8rem; margin:1rem 0 .3rem; }
    .job-summary,.detail-groups { grid-template-columns:1fr; }
      .panel-head { padding:.55rem .6rem; }
      .panel-body { padding:.6rem; }
      .tagline { display:none; }
    }
    @media (prefers-reduced-motion:reduce) { .skeleton { animation:none; } .usage-fill { transition:none; } }
  .router-rules-workspace{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start;min-width:0}.router-rules-pane{min-width:0;max-width:100%;overflow:hidden}.rules-editor .rules-textarea{min-height:420px}.audit-log{display:flex;flex-direction:column;gap:8px;max-height:500px;overflow:auto;min-width:0}.audit-entry{border:1px solid var(--border);border-radius:10px;padding:10px;background:var(--surface)}.audit-entry-head{display:flex;justify-content:space-between;gap:8px;align-items:center}.audit-entry pre{white-space:pre-wrap;word-break:break-word;margin:8px 0 0;font-size:11px}.router-test-panel{margin-top:16px;border-top:1px solid var(--border);padding-top:12px}.router-test-results{margin-top:8px;display:flex;flex-direction:column;gap:6px;max-height:480px;overflow:auto;min-width:0}.router-test-results pre{white-space:pre;overflow:auto;max-width:100%;font-size:11px;line-height:1.45;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px}.router-test-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;padding:7px 0;border-bottom:1px solid var(--border)}@media(max-width:900px){.router-rules-workspace{grid-template-columns:1fr}.router-rules-pane{max-height:none}.router-test-results{max-height:420px}}@media(max-width:650px){#rules-view .panel-head .subtle{display:none}#rules-view .panel-body{max-height:none;overflow:visible;padding:.6rem}#rules-view .router-rules-workspace{gap:.9rem}#rules-view .rules-help{font-size:.74rem;line-height:1.4}#rules-view .rules-textarea{min-height:52vh;padding:.65rem;font-size:12px}#rules-view .rules-footer{align-items:stretch}#rules-view .rules-footer>.subtle{width:100%}#rules-view .rules-footer>div{width:100%;display:grid;grid-template-columns:1fr 1fr;gap:.5rem}#rules-view .rules-save{min-height:44px;width:100%;padding:.55rem .7rem}#rules-view .router-rules-pane>.panel-head{padding:.55rem 0}#rules-view .audit-log{max-height:none}#rules-view .audit-entry-head{align-items:flex-start}#rules-view .audit-entry-head .subtle{display:block;flex:0 0 auto}#rules-view .router-test-panel{min-width:0;max-width:100%;overflow:hidden}#rules-view .router-test-results{max-height:none;width:100%;max-width:100%;overflow-x:hidden}#rules-view .router-test-results>*{min-width:0;max-width:100%}#rules-view .router-test-results pre{width:100%;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font-size:11px;padding:.65rem}#rules-view .router-test-row{grid-template-columns:1fr}}
</style>`;
