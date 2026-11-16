import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dashboardHtml} from '../../dist/dashboard-html.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const served=readFileSync(resolve(root,'rust/assets/rust-live-dashboard.html'),'utf8');
const revision=/const WORKFLOW_SOURCE_REF="[0-9a-f]{40}";/g;
const normalizeRevision=html=>{
  assert.equal([...html.matchAll(revision)].length,1,'Expected exactly one build revision stamp');
  return html.replace(revision,'const WORKFLOW_SOURCE_REF="<build-revision>";');
};
assert.equal(normalizeRevision(served),normalizeRevision(dashboardHtml),
  'Rust must serve the original Node Dashboard HTML/CSS/JS, with no client changes, injected adapter, or substituted renderer. Only the build commit stamp may differ.');
console.log('ORIGINAL_DASHBOARD_CLIENT_PARITY_PASS; only source revision stamp differs');
