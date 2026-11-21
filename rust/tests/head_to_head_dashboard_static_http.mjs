// Actual Node serveDashboard HTTP vs Rust static-response PWA contract.
// Loopback server and isolated in-memory fixture; no live daemon/provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {serveDashboard} from '../../dist/dashboard.js';
import {dashboardVersion} from '../../dist/dashboard-html.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const ver=dashboardVersion;
const routes=[
 ['GET','/'],['GET','/dashboard-config.js'],
 ['POST','/dashboard-config.js'],['GET','/dashboard-config.js?v='+ver],
 ['GET','/api/version'],['POST','/api/version'],
 ['GET','/api/version?v='+ver],['GET','/api/version?bad=1'],
 ['GET','/dashboard.js'],['GET','/dashboard.js?v='+ver],
 ['GET','/dashboard.css'],['GET','/dashboard.css?v='+ver],
 ['GET','/vendor/markdown-it.min.js'],
 ['GET','/vendor/markdown-it.min.js?v='+ver],
 ['GET','/pwa.js'],['GET','/pwa.js?v='+ver],
 ['GET','/service-worker.js'],['GET','/service-worker.js?v='+ver],
 ['GET','/manifest.webmanifest'],['GET','/manifest.webmanifest?v='+ver],
 ['GET','/icons/icon-180.png'],['GET','/icons/icon-192.png'],
 ['GET','/icons/icon-512.png'],
 ['GET','/dashboard.js?v=old'],['GET','/dashboard.js?v='],
 ['GET','/dashboard.js?v='+ver+'&x=1'],
 ['GET','/dashboard.js?v='+ver+'&v='+ver],
 ['GET','/dashboard.js?%76='+ver],
 ['GET','/dashboard.css?q=1'],['GET','/service-worker.js?q=1'],
 ['POST','/dashboard.js'],['DELETE','/manifest.webmanifest'],
 ['GET','/asset/../../vendor/markdown-it.min.js'],
 ['GET','/dashboard-config.js?v=old'],
 ['GET','/index.html'],['GET','/favicon.ico'],
 ['GET','/icons/icon-512.png?unknown=true'],
 ['GET','/prefix/../dashboard.js'],
 ['GET','/%2e/dashboard.js'],
 ['GET','/prefix/%2e%2e/dashboard.js'],
 ['GET','/manifest.webmanifest?'],
 ['GET','/dashboard.js?'],
 ['GET','/dashboard.js#readme'],
 ['GET','/dashboard.js?v='+ver+'#hash'],
 ['GET','/dashboard.css?v='+ver+'#version-fragment'],
 ['GET','/dashboard.js?v='+encodeURIComponent(ver)],
 ['GET','/dashboard.js?v='+ver+'&'],
 ['GET','/dashboard.js?x=1&v='+ver],
 ['GET','/dashboard.js?v='+ver+';x=1'],
 ['GET','/nested/../../icons/icon-180.png'],
 ['GET','/icons/../pwa.js?v='+ver],
 ['GET','/dashboard-config.js#hash'],
 ['GET','/api/version#hash'],
 ['POST','/api/version?'],
 ['GET','/not-real/../service-worker.js']
];
function request(port,method,path){
 return new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,method,path,
   headers:{Host:'localhost'}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));
   res.on('error',reject);
   res.on('end',()=>{
    const body=Buffer.concat(chunks);
    const status=res.statusCode;
    resolve({
     status,
     contentType:status===200?res.headers['content-type']??null:null,
     cacheControl:status===200?res.headers['cache-control']??null:null,
     digest:status===200?createHash('sha256').update(body).digest('hex'):null
    });
   });
  });req.on('error',reject);req.end();
 });
}
test('real original Node HTTP/PWA asset allowlist vs native Rust static contract',async()=>{
 const job={id:'fixture-only',repository:'local-fixture',prNumber:0,
  title:'No runtime',state:'DRAFT',tasks:[],plans:[]};
 const store={load:async()=>job};
 const server=serveDashboard(store,0,undefined,300000,'fixture-only');
 try{
  if(!server.listening)await once(server,'listening');
  const port=server.address().port;
  const original=[];
  for(const [method,path] of routes)original.push(await request(port,method,path));
  const rust=spawnSync(bin,[],{cwd:root,encoding:'utf8',timeout:30000,
   input:JSON.stringify({op:'dashboardStaticPublic',
    requests:routes.map(([method,path])=>({method,target:path}))})+'\n'});
  assert.equal(rust.status,0,rust.stderr);
  const response=JSON.parse(rust.stdout.trim());
  assert.equal(response.ok,true,JSON.stringify(response));
  for(let i=0;i<routes.length;i++){
   assert.deepEqual(response.value[i],original[i],routes[i].join(' ')+' #'+i);
  }
  console.log('Verified '+routes.length+' original Node HTTP vs native Rust static responses');
 }finally{
  await new Promise(resolve=>server.close(resolve));
 }
});
