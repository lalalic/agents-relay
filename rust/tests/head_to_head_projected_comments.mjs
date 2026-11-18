// Node ProjectedDurableStore.comments uses the real GitHubStore comments()
// transport. Rust must delegate to its GitHubStore, with identical caching,
// pagination and fail-closed semantics; fake GraphQL only, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {GitHubStore} from '../../dist/store-github.js';
import {ProjectedDurableStore} from '../../dist/projected-store.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const comment=(i)=>({id:i,nodeId:'comment-id-'+i,url:'https://example.invalid/remarks/'+i,
 body:'User comment '+i,updatedAt:'2026-11-17T22:00:00.000Z',authorLogin:'trusted'});
const node=(i)=>({id:'comment-id-'+i,databaseId:i,url:'https://example.invalid/remarks/'+i,
 body:'User comment '+i,updatedAt:'2026-11-17T22:00:00.000Z',author:{login:'trusted'}});
const page=(ids,more=false,cursor=null)=>({repository:{pullRequest:{comments:{
 nodes:ids.map(node),pageInfo:{hasNextPage:more,endCursor:cursor}}}}});
const cases=[
 {repository:'owner/repo',pages:[page([])],readCount:2},
 {repository:'owner/repo',pages:[page([1,2,3])],readCount:3},
 {repository:'owner/repo',pages:[page([4],true,'next'),page([5,6])],readCount:2},
 {repository:'owner/repo',pages:[page([7],true,'next'),page([8],true,'third'),page([9])],readCount:2},
 {repository:'owner/repo',pages:[],readCount:1,
  seed:{prNode:{},comments:[comment(10),comment(11)]}},
 {repository:'owner/repo',pages:[],readCount:3,
  seed:{prNode:{},comments:[]}},
 {repository:'invalid',pages:[page([12])],readCount:2},
 {repository:'owner/repo',pages:[{}],readCount:2},
 {repository:'owner/repo',pages:[],readCount:2},
];
async function nodeResult(item){
 const db=new SQLiteRelayStore(':memory:');
 let calls=0;
 const client={graphql:async(_query,_vars)=>{
  const i=calls++;if(i>=item.pages.length)throw Error('GraphQL fixture exhausted');
  return item.pages[i];
 },request:async()=>{throw Error('Unexpected REST write');}};
 const github=new GitHubStore(client,item.repository,item.prNumber??1,new Set(),item.seed??null);
 const projected=new ProjectedDurableStore(db,github,null);
 const outcomes=[];
 try{
  for(let i=0;i<(item.readCount??1);i++){
   try{outcomes.push({ok:true,value:await projected.comments()});}
   catch(e){outcomes.push({ok:false,error:e.message});}
  }
  return {outcomes,calls};
 }finally{db.close();}
}
test('projected comments delegate to the real GitHubStore with correct pages and cache',async()=>{
 const expected=[];for(const item of cases)expected.push(await nodeResult(item));
 const run=spawnSync(binary,[],{cwd:root,encoding:'utf8',maxBuffer:5*1024*1024,timeout:120000,
  input:cases.map(item=>JSON.stringify({...item,op:'projectedGithubComments'})).join('\n')+'\n'});
 assert.equal(run.status,0,run.stderr||run.error?.message);
 const outputs=run.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(outputs.length,cases.length);
 const failures=[];
 for(let i=0;i<cases.length;i++){
  try{assert.deepEqual(outputs[i],{ok:true,value:expected[i]});}
  catch{failures.push({i,node:expected[i],rust:outputs[i]});}
 }
 assert.deepEqual(failures.slice(0,5),[],`${failures.length} GitHub provider parity mismatches`);
 console.log(`Verified ${cases.length} real Node/Rust ProjectedDurableStore.comments scenarios (no network)`);
});
