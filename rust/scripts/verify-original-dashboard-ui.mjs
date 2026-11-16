import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dashboardHtml} from '../../dist/dashboard-html.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const served=readFileSync(resolve(root,'rust/assets/rust-live-dashboard.html'),'utf8');
assert.equal(served,dashboardHtml,
  'Rust Dashboard must reuse Node Dashboard HTML/CSS/JS byte-for-byte, with no injected adapter, UI edits, or substitutes');
console.log('ORIGINAL_DASHBOARD_CLIENT_BYTE_PARITY_PASS');
