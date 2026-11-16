import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dashboardHtml} from '../../dist/dashboard-html.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const deployed=readFileSync(resolve(root,'rust/assets/rust-live-dashboard.html'),'utf8');
const safety='select.disabled=true;select.title=\'Read-only Rust Dashboard: change state through Relay CLI\';';
const expected=dashboardHtml
  .replace('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js',
    '/assets/mermaid-lite.js')
  .replace('select.value=job.state;select.addEventListener',
    'select.value=job.state;'+safety+'select.addEventListener')
  .replace('select.value=task.state;select.addEventListener',
    'select.value=task.state;'+safety+'select.addEventListener');
assert.ok(deployed===expected,
  'Rust UI differs from Node original beyond local graph renderer and two fail-closed state selectors');
for(const id of ['jobs-tab','usage-tab','rules-tab','qa-tab','graphs-tab']){
  assert.ok(deployed.includes('id="'+id+'"'),'Missing original '+id);
}
console.log('ORIGINAL_DASHBOARD_HTML_CSS_JS_PARITY_PASS; 5 original tabs retained');
