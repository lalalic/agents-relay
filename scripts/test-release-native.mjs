import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pausedAndQuiescent,assertIdleDatabase} from './release-native.mjs';
test('pause requires explicit fencing',()=>{
  const job={id:'738',state:'ACTIVE',pause:{requestedAt:'now'},tasks:[{state:'QUEUED'}],plans:[]};
  assert(pausedAndQuiescent(job));
  for(const change of [{pause:null},{tasks:null},{plans:null},
    {tasks:[{executionId:'live'}]}, {plans:[{executionId:'live'}]}])
    assert(!pausedAndQuiescent({...job,...change}));
  // Durable pause snapshots are not active worker generations.
  assert(pausedAndQuiescent({...job,tasks:[{executionId:null,pausedExecution:{id:'pending',state:'QUEUED'}}]}));
  assert(pausedAndQuiescent({...job,plans:[{executionId:null,pausedExecutionId:'pending'}]}));
});
test('actual isolated SQLite release gate refuses active Jobs and process groups',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-release-guard-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'relay.sqlite');
  const db=new DatabaseSync(file);
  t.after(()=>db.close());
  db.exec('CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT); CREATE TABLE execution_process(pid INTEGER,pgid INTEGER,ended_at TEXT)');
  const put=j=>db.prepare('INSERT OR REPLACE INTO job_snapshot VALUES (?,?)').run(j.id,JSON.stringify(j));
  const job={id:'738',state:'ACTIVE',pause:{requestedAt:'now'},tasks:[],plans:[]};
  put(job);
  assert.throws(()=>assertIdleDatabase(file,[],()=>false),/nonterminal Jobs/);
  assert.equal(assertIdleDatabase(file,['738'],()=>false),1);
  put({...job,tasks:[{executionId:null,pausedExecution:{id:'old-task'}}],
    plans:[{executionId:null,pausedExecutionId:'old-plan'}]});
  assert.equal(assertIdleDatabase(file,['738'],()=>false),1);
  put({...job,tasks:[{executionId:'still-running',pausedExecution:{id:'old-task'}}]});
  assert.throws(()=>assertIdleDatabase(file,['738'],()=>false),/738/);
  put(job);
  put({...job,id:'739'});
  assert.throws(()=>assertIdleDatabase(file,['738'],()=>false),/739/);
  put({...job,id:'739',state:'COMPLETED'});
  assert.equal(assertIdleDatabase(file,['738'],()=>false),2);
  db.exec('INSERT INTO execution_process VALUES(1000,1001,NULL)');
  assert.throws(()=>assertIdleDatabase(file,['738'],pid=>pid===-1001),/active worker/);
  assert.equal(assertIdleDatabase(file,['738'],()=>false),2);
});

test('publish and live CLI are independently observable',async t=>{
  const {execFileSync,spawn}=await import('node:child_process');
  const {createServer}=await import('node:http');
  const {once}=await import('node:events');
  const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'relay-publish-live-')));
  t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const repo=path.join(tmp,'repo'),root=path.join(tmp,'installed'),tools=path.join(tmp,'tools');
  const origin=path.join(tmp,'origin.git'),store=path.join(tmp,'stores'),dbPath=path.join(tmp,'relay.sqlite');
  for(const p of [repo,root,tools,store,path.join(repo,'scripts'),path.join(repo,'rust')])fs.mkdirSync(p,{recursive:true});
  const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const script=(file,body)=>fs.writeFileSync(file,body,{mode:0o755});
  for(const name of ['publish-native.mjs','live-native.mjs','native-release-common.mjs','report-publication.mjs','release-native.mjs'])
    fs.copyFileSync(new URL(name,import.meta.url),path.join(repo,'scripts',name));
  for(const name of ['report-publication.test.mjs','test-release-native.mjs'])
    fs.writeFileSync(path.join(repo,'scripts',name),'// Fixture: outer test owns verification\n');
  script(path.join(repo,'scripts/test-dashboard-browser.sh'),'#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(repo,'rust/Cargo.toml'),'version = "2.0.999"\n');
  git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  git('add','.');git('commit','-m','fixture');const sha=git('rev-parse','HEAD');
  execFileSync('git',['init','--bare',origin],{stdio:'ignore'});
  git('remote','add','origin',origin);git('push','-u','origin','main');
  const previous='b'.repeat(40);
  function pkg(id,version){
    const dir=path.join(root,'versions',id);
    fs.mkdirSync(path.join(dir,'bin'),{recursive:true});fs.mkdirSync(path.join(dir,'dashboard'));
    fs.writeFileSync(path.join(dir,'SOURCE_REVISION'),id+'\n');
    script(path.join(dir,'bin/agents-relay-rust'),'#!/bin/sh\necho "agents-relay-rust '+version+'"\n');
    for(const name of ['dashboard.js','dashboard.css'])fs.writeFileSync(path.join(dir,'dashboard',name),id+name);
    return dir;
  }
  const old=pkg(previous,'2.0.998'),next=pkg(sha,'2.0.999');
  fs.symlinkSync(old,path.join(root,'live'));
  const db=new DatabaseSync(dbPath);
  db.exec('CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT); CREATE TABLE execution_process(pid INTEGER,pgid INTEGER,ended_at TEXT)');
  const put=state=>db.prepare('INSERT OR REPLACE INTO job_snapshot VALUES (?,?)').run('762',JSON.stringify({id:'762',state}));
  put('ACTIVE');db.close();
  const journal=path.join(tmp,'activation.log');
  script(path.join(tools,'npx'),'#!/bin/sh\nif [ "$2" = jlist ]; then\ncat <<JSON\n'+JSON.stringify([{name:'agents-relay/daemon',pm2_env:{pm_exec_path:path.join(tmp,'agents-relayd'),args:['--live-store-dir',store]}}])+'\nJSON\nelse echo save >> "$JOURNAL"; fi\n');
  script(path.join(tools,'serviceman'),'#!/bin/sh\necho restart >> "$JOURNAL"\nif [ -f "$JOURNAL.fail" ]; then rm "$JOURNAL.fail"; exit 1; fi\n');
  script(path.join(tools,'cargo'),'#!/bin/sh\necho "unexpected build" >&2; exit 1\n');
  let posts=0;const rows=[];
  const server=createServer(async(req,res)=>{
    const u=new URL(req.url,'http://localhost');
    res.setHeader('content-type','application/json');
    if(u.pathname==='/events'){
      if(req.method==='GET'){
        const events=rows.filter(row=>(!u.searchParams.has('source')||row.event.source.id===u.searchParams.get('source'))&&(!u.searchParams.has('type')||row.event.type===u.searchParams.get('type')));
        res.end(JSON.stringify({order:'desc',events}));return;
      }
      let raw='';for await(const part of req)raw+=part;
      const input=JSON.parse(raw),event={...input,source:{id:input.source}};
      rows.push({cursor:++posts,event});res.end(JSON.stringify({published:true,event}));return;
    }
    const current=fs.realpathSync(path.join(root,'live'));
    if(u.pathname==='/api/version')res.end(JSON.stringify({version:current===next?'2.0.999':'2.0.998',sourceRef:path.basename(current)}));
    else if(['/dashboard.js','/dashboard.css'].includes(u.pathname))res.end(fs.readFileSync(path.join(current,'dashboard',u.pathname.slice(1))));
    else {res.statusCode=404;res.end();}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const api='http://127.0.0.1:'+server.address().port;
  async function cli(name,...args){
    const child=spawn(process.execPath,[path.join(repo,'scripts',name),'--root',root,...args],{
      cwd:repo,env:{...process.env,PATH:tools+':'+process.env.PATH,JOURNAL:journal},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
    const [code]=await once(child,'close');return {code,output};
  }
  const activate=()=>cli('live-native.mjs','--sha',sha,'--api',api);
  const publish=()=>cli('publish-native.mjs','--events-api',api);
  assert.notEqual((await activate()).code,0,'unpublished package cannot go live');
  assert.equal(posts,0);assert.equal(fs.realpathSync(path.join(root,'live')),old);
  const wrong=await cli('publish-native.mjs','--sha','f'.repeat(40),'--events-api',api);
  assert.notEqual(wrong.code,0);assert.match(wrong.output,/Expected publication SHA/);assert.equal(posts,0);
  const result=await cli('publish-native.mjs','--sha',sha,'--events-api',api);assert.equal(result.code,0,result.output);
  assert.equal(posts,1);assert.equal(rows[0].event.data.sha,sha);
  assert.equal(fs.realpathSync(path.join(root,'live')),old,'publish must not switch live');
  assert(!fs.existsSync(journal),'publish must not restart');
  assert.equal((await publish()).code,0,'retry publication');assert.equal(posts,1);
  const stale=await cli('live-native.mjs','--sha',sha,'--expected-live-sha','f'.repeat(40),'--api',api);
  assert.notEqual(stale.code,0);assert.match(stale.output,/Live revision changed/);assert(!fs.existsSync(journal));
  const blocked=await activate();assert.notEqual(blocked.code,0);assert.match(blocked.output,/nonterminal Jobs/);
  assert.equal(posts,1);assert.equal(fs.realpathSync(path.join(root,'live')),old);
  const update=new DatabaseSync(dbPath);update.prepare('UPDATE job_snapshot SET json=?').run(JSON.stringify({id:'762',state:'COMPLETED'}));update.close();
  const receipt=path.join(root,'receipts',sha+'.json'),original=fs.readFileSync(receipt,'utf8');
  const tampered=JSON.parse(original);tampered.event.data.version='2.0.0';fs.writeFileSync(receipt,JSON.stringify(tampered));
  assert.match((await activate()).output,/receipt does not match/);assert(!fs.existsSync(journal));
  fs.writeFileSync(receipt,original);
  fs.writeFileSync(journal+'.fail','');
  const failed=await activate();assert.notEqual(failed.code,0);
  assert.equal(fs.realpathSync(path.join(root,'live')),old,'failed activation rolls back');
  assert.equal(posts,1,'failed live must not emit package.publish_failed');
  assert.equal(fs.readFileSync(receipt,'utf8'),original);
  assert.equal(fs.readFileSync(journal,'utf8'),'restart\nrestart\nsave\n');
  fs.unlinkSync(journal);
  const activated=await activate();assert.equal(activated.code,0,activated.output);
  assert.equal(fs.realpathSync(path.join(root,'live')),next);assert.equal(posts,1,'live must not publish');
  assert.equal(fs.readFileSync(journal,'utf8'),'restart\nsave\n');
  assert.equal((await activate()).code,0);assert.equal(fs.readFileSync(journal,'utf8'),'restart\nsave\n');
});
