/*
 * API compatibility adapter for the original Agents Relay Dashboard UI.
 * All reads use the live Rust authority. Never answer Refresh from page-load
 * bootstrap snapshots, and never call a Node Relay API.
 */
(function () {
  'use strict';
  const bootstrap = window.__RUST_BOOTSTRAP__ || {};
  const fetchNative = window.fetch.bind(window);
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  function answer(data, status = 200) {
    return Promise.resolve(new Response(JSON.stringify(data), {
      status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    }));
  }
  function auditView(records) {
    return records.map(record => ({
      timestamp: record.at, correlation: { job_id: record.jobId, task_id: record.taskId },
      selected: { worker: { adapter: record.provider || 'unknown' }, model: record.model || '' },
      decision_evidence: { fallback: false }, gate_results: [],
      source: 'Rust durable Task record — not an interactive model decision',
    }));
  }
  function postSettings(kind, body) {
    if (!local) return answer({ error: 'Settings writes require local Neo Master browser' }, 403);
    const cached = bootstrap[kind];
    if (!cached || !cached.hash) return answer({ error: 'Reload settings before saving' }, 409);
    const next = typeof body === 'string' ? body : body.text;
    const hash = typeof body === 'string' ? cached.hash : body.hash;
    if (typeof next !== 'string' || hash !== cached.hash)
      return answer({ error: 'Settings changed; reload before saving' }, 409);
    if (next === cached.text) return answer({ text: next, hash, unchanged: true });
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/api/settings/save';
    form.enctype = 'application/x-www-form-urlencoded';
    for (const [name, value] of Object.entries({ kind, hash, text: next })) {
      const field = document.createElement('input');
      field.type = 'hidden'; field.name = name; field.value = value;
      form.append(field);
    }
    document.body.append(form);
    form.submit();
    return new Promise(() => {});
  }

  window.fetch = function (input, options) {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin) return fetchNative(input, options);
    const method = (options?.method || input?.method || 'GET').toUpperCase();
    if (method === 'GET') {
      if (url.pathname === '/api/jobs')
        return fetchNative('/api/dashboard/jobs' + url.search, options);
      if (url.pathname === '/api/job')
        return fetchNative('/api/dashboard/job' + url.search, options);
      if (url.pathname === '/api/decision-audit')
        return fetchNative(input, options).then(async response =>
          response.ok ? answer(auditView(await response.json())) : response);
    }
    if (method === 'PUT') {
      if (url.pathname === '/api/execution-router-rules') return postSettings('rules', options?.body || '');
      if (url.pathname === '/api/troubleshooter-qa') {
        try { return postSettings('qa', JSON.parse(options?.body || '{}')); }
        catch { return answer({ error: 'Invalid Q&A body' }, 400); }
      }
    }
    if (method === 'POST' && url.pathname === '/api/router-test') {
      let body;
      try { body = JSON.parse(options?.body || '{}'); }
      catch { return answer({ error: 'Invalid routing request' }, 400); }
      if (!body.jobId || !body.taskId) return answer({ error: 'Select Job and Task first' }, 400);
      const target = '/api/router-test?' + new URLSearchParams({job:String(body.jobId),task:String(body.taskId)});
      return fetchNative(target).then(async response => {
        if (!response.ok) return response;
        const stored = await response.json();
        const route = stored.routing || {};
        return answer({
          selected: { worker: stored.adapter || 'not recorded',
            model: route.model || 'not recorded', route: 'Recorded decision only (not a new routing test)' },
          routingInstruction: stored.source,
          proposedFields: { recordedRouting: stored.routing,
            workerRequirements: stored.workerRequirements, routingExclusions: stored.routingExclusions },
          fallback: false
        });
      });
    }
    return fetchNative(input, options);
  };
  function showInitialView(view) {
    // Original Dashboard bindings render normally in foreground Chrome.
    // Managed WebHelm may suspend Promise continuations for hidden Tabs.
    // Populate the ORIGINAL containers synchronously from one Rust snapshot.
    if (document.visibilityState !== 'hidden') return;
    if (view === 'usage') {
      const root = document.getElementById('usage-root');
      if (!root || !bootstrap.usage) return;
      const cards = document.createElement('div'); cards.className = 'usage-providers';
      for (const provider of bootstrap.usage.providers || []) {
        if (typeof window.usageProvider === 'function') cards.append(window.usageProvider(provider));
        else {
          const card = document.createElement('section'); card.className = 'usage-provider';
          const title = document.createElement('h3'); title.textContent = provider.label;
          const detail = document.createElement('p'); detail.className = 'empty';
          detail.textContent = provider.usage?.reason || 'Not connected';
          card.append(title, detail); cards.append(card);
        }
      }
      root.replaceChildren(cards);
      const meta = document.getElementById('usage-meta');
      if (meta) meta.textContent = 'Durable Rust execution; provider quotas not connected';
    }
    if (view === 'rules') {
      const entry = bootstrap.rules;
      if (entry && !entry.error) {
        document.getElementById('rules-text').value = entry.text;
        document.getElementById('rules-meta').textContent =
          'Loaded · ' + (entry.hash || '').slice(0, 12);
      }
      if (typeof window.renderAudit === 'function') window.renderAudit(nativeAudit());
      const audit = document.getElementById('audit-refresh');
      if (audit) audit.disabled = false;
    }
    if (view === 'qa') {
      const entry = bootstrap.qa;
      if (entry && !entry.error) {
        document.getElementById('qa-text').value = entry.text;
        document.getElementById('qa-status').textContent = 'Loaded';
        try { qaRevision = entry.hash; } catch {}
      }
    }
    if (view === 'graphs') {
      try {
        workflowGraphs = bootstrap.graphs || [];
        selectedGraphId = (location.hash.startsWith('#/graphs/')
          ? location.hash.slice('#/graphs/'.length) : 'main');
        if (selectedGraphId === 'entry') selectedGraphId = 'main';
        document.getElementById('graphs-meta').textContent =
          Math.max(0, workflowGraphs.length - 1) + ' executable workflow graphs · main is conceptual';
        if (typeof window.renderGraphList === 'function') window.renderGraphList();
        showInitialGraph();
      } catch(error) {
        document.getElementById('graphs-meta').textContent = 'Graph preview: ' + error.message;
      }
    }
  }
  function showInitialGraph() {
    const graph = (bootstrap.graphs || []).find(g => g.id === selectedGraphId);
    if (!graph) return;
    const title = document.getElementById('graph-title');
    const description = document.getElementById('graph-description');
    const path = document.getElementById('graph-path');
    const canvas = document.getElementById('graph-canvas');
    if (!canvas || !window.mermaid?.renderSync) return;
    title.textContent = graph.name;
    if (description) description.textContent = graph.description || '';
    if (path) path.textContent = graph.path;
    try {
      const result = window.mermaid.renderSync('rust-' + graph.id, graph.source);
      const svg = typeof window.sanitizeGraphSvg === 'function'
        ? window.sanitizeGraphSvg(result.svg) : new DOMParser()
          .parseFromString(result.svg, 'image/svg+xml').documentElement;
      canvas.replaceChildren(svg);
      if (typeof window.applyGraphPalette === 'function') window.applyGraphPalette(svg);
      const refs = typeof window.graphNodeDefinitions === 'function'
        ? window.graphNodeDefinitions(graph.source) : new Map();
      const links = typeof window.graphLinks === 'function'
        ? window.graphLinks(graph.source) : new Map();
      for (const node of svg.querySelectorAll('g.node')) {
        const entry = Array.from(refs.entries())
          .find(([id]) => node.id.includes('-flowchart-' + id + '-'));
        if (!entry) continue;
        const target = links.get(entry[0]);
        if (target && typeof window.interactiveNode === 'function') {
          window.interactiveNode(node, function(){
            window.navigateGraph(target);
            showInitialGraph();
          }, 'Explore ' + target);
        }
      }
    } catch(error) {
      canvas.textContent = 'Graph preview unavailable: ' + error.message;
    }
  }
  document.addEventListener('click', function(event) {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button) return;
    if (button.id === 'rules-save' || button.id === 'qa-save') {
      event.preventDefault(); event.stopImmediatePropagation();
      const kind = button.id === 'qa-save' ? 'qa' : 'rules';
      const entry = bootstrap[kind] || {};
      const body = kind === 'qa'
        ? {text:document.getElementById('qa-text').value,hash:entry.hash}
        : document.getElementById('rules-text').value;
      const status = document.getElementById(kind === 'qa'?'qa-status':'rules-status');
      if (!local) {status.textContent = 'Read only over tunnel; edit on Neo Master';return}
      if (!entry.hash) {status.textContent = 'Reload configuration before saving';return}
      if ((typeof body === 'string'?body:body.text) === entry.text) {
        status.textContent = 'Already up to date';return;
      }
      status.textContent = 'Saving…';
      void postSettings(kind,body);
    }
  }, true);
  document.addEventListener('click', function(event){
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button || document.visibilityState !== 'hidden') return;
    const tab = button.id === 'jobs-tab'?'jobs':
      button.id === 'usage-tab'?'usage':
      button.id === 'rules-tab'?'rules':
      button.id === 'qa-tab'?'qa':
      button.id === 'graphs-tab'?'graphs':null;
    if (tab) showInitialView(tab);
    if (button.classList.contains('graph-button') || button.id === 'graph-entry')
      showInitialGraph();
    if (button.id === 'audit-refresh') {
      if (typeof window.renderAudit === 'function') window.renderAudit(nativeAudit());
      button.disabled = false;
    }
    if (button.id === 'rules-test') {
      const output = document.getElementById('router-test-results');
      if (output) {
        output.replaceChildren();
        const note = document.createElement('p'); note.className = 'error-state';
        note.textContent = 'Live Router Test is not yet available in Rust. Stored Task routing is shown under Task details.';
        output.append(note);
      }
      button.disabled = false;
    }
  }, false);
  window.addEventListener('load', function () {
    const testButton = document.getElementById('rules-test');
    if (testButton) {
      testButton.textContent = 'Inspect saved routing';
      testButton.title = 'Read-only Task routing snapshot; no fresh router decision is made';
    }
    const message = new URLSearchParams(location.search).get('save');
    if (!message) return;
    const target = document.getElementById(message.includes('qa') ? 'qa-status' : 'rules-status');
    if (!target) return;
    const labels = { 'saved-qa': 'Saved to canonical Markdown file',
      'saved-rules': 'Saved to canonical routing rules',
      'conflict-qa': 'Q&A changed on disk; reload',
      'conflict-rules': 'Rules changed on disk; reload',
      'failed-qa': 'Q&A save failed', 'failed-rules': 'Rules save failed' };
    queueMicrotask(() => { target.textContent = labels[message] || ''; });
  });
})();
