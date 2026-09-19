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
  <title>Agents Relay</title>
  <style>
    :root { color-scheme: light dark; --border: #d8dee7; --muted: #5f6a78; --ok: #176b2c; --bad: #a33; --warn: #915802; --accent: #20557c; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 1.5rem; background: #fbfcfe; color: #182430; font: 15px/1.45 system-ui, sans-serif; }
    main, section { max-width: 1180px; margin-inline: auto; }
    h1, h2 { color: var(--accent); margin-bottom: .35rem; }
    h1 { font-size: 1.55rem; }
    h2 { font-size: 1.15rem; margin-top: 1.8rem; }
    .subtle { color: var(--muted); margin-top: 0; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .6rem; margin: 1rem 0; }
    .metric, .task { background: white; border: 1px solid var(--border); border-radius: .45rem; padding: .75rem; }
    .metric-label { font-size: .78rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 0; }
    .metric-value { font-size: 1.2rem; font-weight: 650; margin: .2rem 0 0; overflow-wrap: anywhere; }
    .status, .badge { display: inline-block; border-radius: 999px; padding: .1rem .45rem; font-weight: 650; font-size: .8rem; }
    .status.RUNNING, .badge.RUNNING { color: var(--accent); background: #e7f0f9; }
    .status.BLOCKED, .badge.BLOCKED { color: var(--warn); background: #fff2d6; }
    .status.FAILED, .badge.FAILED { color: var(--bad); background: #ffe9e9; }
    .status.SUCCEEDED, .badge.SUCCEEDED { color: var(--ok); background: #e6f5ea; }
    .indicators { margin: .25rem 0 0; color: var(--muted); }
    .indicators strong { color: inherit; }
    ul.tree { list-style: none; padding: 0; margin: .65rem 0; }
    ul.tree ul { border-left: 2px solid var(--border); margin: .35rem 0 .35rem .5rem; padding-left: 1rem; list-style: none; }
    .task + .task { margin-top: .65rem; }
    .task h3 { margin: 0; font-size: 1rem; display: flex; flex-wrap: wrap; gap: .45rem; align-items: center; }
    .task h3 code { background: #eef2f7; border-radius: .25rem; padding: .05rem .3rem; }
    .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(215px, 1fr)); gap: .4rem 1rem; margin-top: .5rem; }
    .fields div { min-width: 0; }
    .field-label { color: var(--muted); font-size: .78rem; text-transform: uppercase; }
    .field-value { margin: 0; overflow-wrap: anywhere; }
    .error-text { color: var(--bad); }
    #events { max-height: 17rem; overflow: auto; padding: 0 0 0 1.25rem; }
    #events li { padding: .3rem 0; border-bottom: 1px solid var(--border); }
    #events .kind { display: inline-block; min-width: 8.5rem; font-weight: 650; color: var(--accent); }
    #events .connection-ok { color: var(--ok); }
    #events .connection-error { color: var(--bad); }
    .usage-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; align-items: start; }
    .source { background: white; border: 1px solid var(--border); border-radius: .45rem; padding: .75rem; min-width: 0; }
    .source h3 { margin: 0 0 .35rem; font-size: 1rem; }
    .usage-counts { display: grid; grid-template-columns: repeat(auto-fit, minmax(105px, 1fr)); gap: .5rem; margin: .65rem 0; }
    .usage-count { background: #f4f7fa; border-radius: .35rem; padding: .45rem; }
    .usage-count strong { display: block; overflow-wrap: anywhere; }
    .unavailable { color: var(--warn); }
    .table-scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: .88rem; }
    th, td { border-bottom: 1px solid var(--border); padding: .38rem .45rem; text-align: right; }
    th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align: left; }
    th { color: var(--muted); font-size: .74rem; text-transform: uppercase; }
    td { overflow-wrap: anywhere; }
    .empty { color: var(--muted); font-style: italic; }
    @media (max-width: 760px) { body { padding: 1rem; } .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 900px) { .usage-grid { grid-template-columns: minmax(0, 1fr); } }
  </style>
</head>
<body>
  <main>
    <h1>Agents Relay</h1>
    <p class="subtle">Durable PR state is authoritative; live events are observability signals.</p>
    <p id="connection" aria-live="polite">Connecting…</p>

    <section aria-labelledby="summary-heading">
      <h2 id="summary-heading">Job summary</h2>
      <div class="summary" id="summary" aria-live="polite"></div>
    </section>

    <section aria-labelledby="jobs-heading">
      <h2 id="jobs-heading">Managed PRs / jobs</h2>
      <p class="subtle">GitHub PR state and durable Agents Relay state are shown side by side.</p>
      <div class="table-scroll"><table><thead><tr><th>PR</th><th>Job</th><th>GitHub</th><th>Durable</th><th>Tasks</th><th>Updated</th></tr></thead><tbody id="jobs"></tbody></table></div>
    </section>

    <section aria-labelledby="tasks-heading">
      <h2 id="tasks-heading">Task hierarchy</h2>
      <ul class="tree" id="tasks"></ul>
    </section>

    <section aria-labelledby="usage-heading">
      <h2 id="usage-heading">Usage</h2>
      <p class="subtle">Actual recorded requests and tokens in the recent local telemetry window. Quota and remaining balance are shown explicitly when unsupported.</p>
      <div class="usage-grid" id="usage" aria-live="polite"></div>
    </section>

    <section aria-labelledby="events-heading">
      <h2 id="events-heading">Recent events</h2>
      <p class="subtle">Shows selected, start, milestone, completion, and connection signals. Newest first; bounded to 60 entries.</p>
      <ol id="events" aria-live="polite"></ol>
    </section>
  </main>
  <script>
    'use strict';
    const MAX_EVENTS = 60;
    const EVENT_KINDS = ['model.selected', 'task.started', 'task.milestone', 'task.completed', 'connection'];
    const summary = document.querySelector('#summary');
    const taskRoot = document.querySelector('#tasks');
    const eventFeed = document.querySelector('#events');
    const connection = document.querySelector('#connection');
    const usageRoot = document.querySelector('#usage');
    const jobsRoot = document.querySelector('#jobs');
    let lastEventAt = '—';

    function value(v) { return v === null || v === undefined || v === '' ? '—' : String(v); }
    function githubPrUrl(repository, prNumber) {
      if (typeof repository !== 'string' || !Number.isInteger(prNumber) || prNumber <= 0) return null;
      const parts = repository.split('/');
      if (parts.length !== 2) return null;
      const owner = parts[0];
      const repo = parts[1];
      if (!owner || !repo || owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
      if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
      return 'https://github.com/' + owner + '/' + repo + '/pull/' + prNumber;
    }
    function text(valueForText) { return document.createTextNode(value(valueForText)); }
    function element(name, className, child) {
      const node = document.createElement(name);
      if (className) node.className = className;
      if (child) node.append(child);
      return node;
    }
    function metric(label, valueForMetric) {
      const box = element('div', 'metric');
      box.append(element('p', 'metric-label', text(label)));
      box.append(element('p', 'metric-value', text(valueForMetric)));
      return box;
    }
    function prMetric(job) {
      const box = element('div', 'metric');
      box.append(element('p', 'metric-label', text('GitHub PR')));
      const valueNode = element('p', 'metric-value');
      const url = githubPrUrl(job.repository, job.prNumber);
      if (url) {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'GitHub PR';
        valueNode.append(link);
      } else {
        valueNode.append(text('unavailable'));
      }
      box.append(valueNode);
      return box;
    }
    function countByState(tasks) {
      const counts = {};
      for (const task of tasks) counts[task.state] = (counts[task.state] || 0) + 1;
      return counts;
    }
    function countText(counts, state) { return counts[state] ? String(counts[state]) : '0'; }
    function field(label, valueForField) {
      const box = element('div');
      box.append(element('div', 'field-label', text(label)));
      box.append(element('p', 'field-value', text(valueForField)));
      return box;
    }
    function drawSummary(job) {
      const tasks = Array.isArray(job.tasks) ? job.tasks : [];
      const counts = countByState(tasks);
      const indicators = [];
      if (counts.RUNNING) indicators.push(counts.RUNNING + ' running');
      if (counts.BLOCKED) indicators.push(counts.BLOCKED + ' blocked');
      if (counts.FAILED) indicators.push(counts.FAILED + ' failed');
      summary.replaceChildren(
        metric('State', value(job.state)),
        prMetric(job),
        metric('Tasks', String(tasks.length)),
        metric('By task state', ['QUEUED', 'READY', 'RUNNING', 'WAITING', 'BLOCKED', 'SUCCEEDED', 'FAILED', 'CANCELLED'].map(state => state + ' ' + countText(counts, state)).join(' · ')),
        metric('Last activity', value(job.updatedAt))
      );
      const indicator = element('p', 'indicators', text(indicators.length ? 'Attention: ' + indicators.join(', ') : 'No running, blocked, or failed tasks.'));
      summary.append(indicator);
      summary.append(metric('Last refresh', value(lastRefreshAt)));
      summary.append(metric('Last event', value(lastEventAt)));
    }
    function taskNode(task, children, depth) {
      const node = element('li');
      const card = element('article', 'task');
      const title = element('h3');
      title.append(text((depth > 0 ? '↳ ' : '') + value(task.id)));
      title.append(element('span', 'badge ' + value(task.state), text(value(task.state))));
      card.append(title);
      card.append(field('Input', task.input));
      const fields = element('div', 'fields');
      const routing = task.routing || {};
      fields.append(field('Project', task.projectName || 'none'));
      fields.append(field('Agent', task.agentName || 'none'));
      fields.append(field('Parent task', task.parentTaskId || 'root'));
      fields.append(field('Worker adapter', task.adapter));
      fields.append(field('Provider / model / reasoning', value(routing.provider) + ' / ' + value(routing.model) + ' / ' + value(routing.reasoning || routing.profile)));
      fields.append(field('Execution / thread', value(task.executionId) + ' / ' + value(task.threadId)));
      fields.append(field('Attempt', value(task.attempt) + ' of ' + value(task.maxAttempts)));
      fields.append(field('Dependencies', (Array.isArray(task.dependencies) && task.dependencies.length ? task.dependencies.join(', ') : 'none')));
      fields.append(field('Lease owner / expiry', value(task.leaseOwner) + ' / ' + value(task.leaseExpiresAt)));
      if (task.result) fields.append(field('Result', task.result.summary + (task.result.artifacts && task.result.artifacts.length ? ' · artifacts: ' + task.result.artifacts.join(', ') : '')));
      if (task.error) {
        const resultField = field('Error', task.error);
        resultField.querySelector('.field-value').classList.add('error-text');
        fields.append(resultField);
      }
      card.append(fields);
      node.append(card);
      const descendants = children.get(task.id) || [];
      if (descendants.length) {
        const branch = element('ul', 'tree');
        for (const child of descendants) branch.append(taskNode(child, children, depth + 1));
        node.append(branch);
      }
      return node;
    }
    function drawJobs(items) {
      jobsRoot.replaceChildren();
      if (!Array.isArray(items) || !items.length) {
        const row = jobsRoot.insertRow(); const cell = row.insertCell(); cell.colSpan = 6; cell.className = 'empty'; cell.append(text('No managed jobs found.')); return;
      }
      for (const item of items) {
        const job = item.job || {}; const row = jobsRoot.insertRow();
        const prCell = row.insertCell(); const url = githubPrUrl(job.repository, job.prNumber);
        if (url) { const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '#' + value(job.prNumber); prCell.append(link); } else prCell.append(text(job.prNumber));
        row.insertCell().append(text(job.id));
        row.insertCell().append(text(item.githubState));
        row.insertCell().append(text(job.state));
        row.insertCell().append(text(Array.isArray(job.tasks) ? job.tasks.length : 0));
        row.insertCell().append(text(job.updatedAt));
      }
    }
    function drawTasks(job) {
      const tasks = Array.isArray(job.tasks) ? job.tasks : [];
      const known = new Set(tasks.map(task => task.id));
      const children = new Map();
      const roots = [];
      for (const task of tasks) {
        if (!task.parentTaskId || !known.has(task.parentTaskId)) roots.push(task);
        else {
          const siblings = children.get(task.parentTaskId) || [];
          siblings.push(task);
          children.set(task.parentTaskId, siblings);
        }
      }
      taskRoot.replaceChildren();
      if (!roots.length) { taskRoot.append(element('li', 'empty', text('No tasks in durable PR state.'))); return; }
      for (const task of roots) taskRoot.append(taskNode(task, children, 0));
    }
    function number(valueForNumber) { return typeof valueForNumber === 'number' && Number.isFinite(valueForNumber) ? valueForNumber.toLocaleString() : '0'; }
    function tokenCounts(tokens) {
      const labels = [['Input', tokens.input], ['Cached input', tokens.cachedInput], ['Cache write', tokens.cacheWriteInput], ['Output', tokens.output], ['Reasoning', tokens.reasoning], ['Total', tokens.total]];
      const box = element('div', 'usage-counts');
      for (const [label, valueForCount] of labels) {
        const item = element('div', 'usage-count');
        item.append(element('span', 'field-label', text(label)));
        item.append(element('strong', '', text(number(valueForCount))));
        box.append(item);
      }
      return box;
    }
    function modelTable(models) {
      const wrapper = element('div', 'table-scroll');
      const table = document.createElement('table');
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const label of ['Provider', 'Model', 'Requests', 'Input', 'Cached', 'Cache write', 'Output', 'Reasoning', 'Total']) {
        const heading = document.createElement('th');
        heading.append(text(label));
        headRow.append(heading);
      }
      const body = document.createElement('tbody');
      if (!models.length) {
        const row = body.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 9;
        cell.className = 'empty';
        cell.append(text('No recorded requests in window'));
      }
      for (const model of models) {
        const row = body.insertRow();
        row.insertCell().append(text(value(model.provider)));
        row.insertCell().append(text(value(model.model)));
        row.insertCell().append(text(number(model.requestCount)));
        for (const valueForCell of [model.tokens.input, model.tokens.cachedInput, model.tokens.cacheWriteInput, model.tokens.output, model.tokens.reasoning, model.tokens.total]) row.insertCell().append(text(number(valueForCell)));
      }
      head.append(headRow); table.append(head, body); wrapper.append(table);
      return wrapper;
    }
    function usageSource(source) {
      const card = element('article', 'source');
      const title = element('h3');
      title.append(text(value(source.label)));
      title.append(element('span', 'badge', text(value(source.id))));
      card.append(title, element('p', 'subtle', text(number(source.requestCount) + ' requests · ' + value(source.telemetryPath))));
      card.append(tokenCounts(source.tokens));
      card.append(element('p', 'unavailable', text('Quota / balance: unavailable — ' + value(source.quotaBalance.reason))));
      if (source.warning) card.append(element('p', 'indicators', text(value(source.warning))));
      card.append(modelTable(Array.isArray(source.models) ? source.models : []));
      return card;
    }
    function currentJobSummary(usage) {
      const card = element('article', 'source');
      card.append(element('h3', '', text('Current durable job')));
      const current = usage.currentJob || {};
      const status = current.available === false
        ? 'Unavailable — ' + value(current.reason)
        : (current.reason ? 'Partial — ' + value(current.reason) : 'Available');
      card.append(element('p', 'subtle', text(status)));
      card.append(tokenCounts(current.tokens || {}));
      card.append(modelTable((current.sessions || []).map(session => ({ provider: session.provider, model: session.model, requestCount: session.requestCount, tokens: session.tokens }))));
      return card;
    }
    function drawUsage(usage) {
      if (!usage || !Array.isArray(usage.sources)) return;
      usageRoot.replaceChildren(
        element('p', 'subtle', text(value(usage.windowStart) + ' → ' + value(usage.windowEnd) + ' · ' + number(usage.requestCount) + ' total requests'))
      );
      for (const source of usage.sources) usageRoot.append(usageSource(source));
      usageRoot.append(currentJobSummary(usage));
    }
    function eventKind(event) {
      if (!event || typeof event !== 'object') return 'connection';
      return value(event.type);
    }
    function addEvent(event, level) {
      const item = element('li');
      item.append(element('span', 'kind', text(eventKind(event))));
      item.append(text(value(event && event.timestamp) + ' · task ' + value(event && event.task_id) + ' · ' + value(event && event.message || (level === 'ok' ? 'Event stream connected' : 'Event stream reconnecting'))));
      if (level === 'ok') item.classList.add('connection-ok');
      if (level === 'error') item.classList.add('connection-error');
      lastEventAt = value(event && event.timestamp || new Date().toISOString());
      eventFeed.prepend(item);
      while (eventFeed.children.length > MAX_EVENTS) eventFeed.lastElementChild.remove();
    }
    function apply(payload) {
      const data = payload && payload.job ? payload.job : payload;
      if (data && typeof data === 'object') { drawSummary(data); drawTasks(data); }
      if (payload && payload.event) addEvent(payload.event);
    }
    async function refresh() {
      try {
        const [jobResponse, jobsResponse, usageResponse] = await Promise.all([fetch('/api/job'), fetch('/api/jobs'), fetch('/api/usage')]);
        if (!jobResponse.ok || !jobsResponse.ok || !usageResponse.ok) throw new Error('API ' + (!jobResponse.ok ? jobResponse.status : !jobsResponse.ok ? jobsResponse.status : usageResponse.status));
        apply(await jobResponse.json());
        drawJobs(await jobsResponse.json());
        drawUsage(await usageResponse.json());
        lastRefreshAt = new Date().toISOString();
        connection.textContent = 'Live · durable PR state connected';
        connection.className = 'status ok';
      } catch (error) {
        connection.textContent = 'Degraded · waiting for PR state (' + error.message + ')';
        connection.className = 'status bad';
      }
    }
    function parseMessage(message) {
      try { return JSON.parse(message.data); } catch { return null; }
    }
    const stream = new EventSource('/events');
    stream.onopen = () => { connection.textContent = 'Live · event stream connected'; connection.className = 'status ok'; addEvent({ type: 'connection', task_id: 'system', message: 'Event stream connected' }, 'ok'); };
    stream.onerror = () => { connection.textContent = 'Degraded · event stream reconnecting'; connection.className = 'status bad'; addEvent({ type: 'connection', task_id: 'system', message: 'Event stream reconnecting' }, 'error'); };
    stream.onmessage = message => { const payload = parseMessage(message); if (payload) apply(payload); };
    stream.addEventListener('relay', message => { const payload = parseMessage(message); if (payload) apply(payload); });
    let lastRefreshAt = '—';
    refresh();
    setInterval(() => { void refresh(); }, 15000);
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
  let subscribed = false;
  const snapshot = async (): Promise<{ id: string; json: string }> => {
    if (!jobId) throw new Error('Dashboard requires a durable job id');
    if (bus && !subscribed) {
      subscribed = true;
      try {
        await bus.subscribe(jobId, async event => {
          const payload = JSON.stringify({ event, job: await store.load(jobId) });
          for (const client of clients) client.write(`event: relay\ndata: ${payload}\n\n`);
        });
      } catch {
        subscribed = false;
      }
    }
    return { id: jobId, json: JSON.stringify(await store.load(jobId)) };
  };
  const usage = async (): Promise<string> => {
    if (!jobId) throw new Error('Dashboard requires a durable job id');
    const registry = usageRegistry;
    if (!registry) throw new Error('Usage telemetry is unavailable');
    return JSON.stringify(await registry.snapshot(await store.load(jobId)));
  };
  const server = createServer(async (req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(dashboardHtml);
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
    if (req.url === '/api/jobs') {
      try {
        const items = overviewProvider ? await overviewProvider() : [{ job: await store.load(jobId ?? ''), githubState: 'OPEN', mergedAt: null, closedAt: null }];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(items));
      } catch (error) {
        res.writeHead(503);
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
