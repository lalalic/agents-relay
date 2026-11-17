// Differential fixture for Node src/dashboard-style.ts: runtime JS template-string bytes must match the Rust dashboard HTML resource.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {dashboardStyles} from '../../dist/dashboard-style.js';
function hash(value){return createHash('sha256').update(value).digest('hex')}
test('dashboardStyles HTML/CSS is byte-for-byte equivalent to Node at runtime',()=>{
 const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{encoding:'utf8'});
 assert.equal(build.status,0,build.stderr);
 const rust=spawnSync('rust/target/debug/relay-rust2-parity',[],{input:JSON.stringify({op:'dashboardStyles'})+'\n',encoding:'utf8',maxBuffer:3*1024*1024});
 assert.equal(rust.status,0,rust.stderr);
 const payload=JSON.parse(rust.stdout);
 assert.equal(payload.ok,true);
 assert.equal(payload.value,dashboardStyles);
 assert.equal(hash(payload.value),hash(dashboardStyles));
 assert.equal(Buffer.byteLength(payload.value),Buffer.byteLength(dashboardStyles));
 assert(payload.value.includes('<style>'));
 assert(payload.value.includes('</style>'));
 console.log(`Verified ${Buffer.byteLength(dashboardStyles)} exact dashboard stylesheet bytes, SHA-256 ${hash(dashboardStyles)}`);
});
