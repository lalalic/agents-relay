import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {releaseEvent, endpoint, publishVerified} from './report-publication.mjs';
const sha='a'.repeat(40);
test('native and npm envelopes and failed publication; no invented Job',()=>{
  const native=releaseEvent({packageName:'agents-relay',version:'2.0.267',sha});
  assert.deepEqual(native,{type:'package.published',source:'release/agents-relay/'+sha,data:{package:'agents-relay',sha,registry:'native',version:'2.0.267'}});
  const npm=releaseEvent({packageName:'markcut',version:'3.2.16',sha,registry:'npm',repository:'lalalic/markcut',artifact:'@lalalic/markcut'});
  assert.equal(npm.data.artifact,'@lalalic/markcut');
  assert.equal(npm.data.jobId,undefined);
  assert.equal(releaseEvent({packageName:'agents-relay',sha,stage:'native activation'}).type,'package.publish_failed');
  assert.throws(()=>releaseEvent({packageName:'markcut',version:'3.2.16',sha,registry:'npm'}));
  assert.throws(()=>releaseEvent({packageName:'markcut',version:'3.2.16',sha,repository:'other/webhelm'}));
  assert.throws(()=>endpoint('http://example.invalid','token'));
  assert.throws(()=>endpoint('https://example.invalid'));
  assert.throws(()=>endpoint('https://user:pass@example.invalid','token'));
  assert.equal(endpoint('https://example.invalid','token'),'https://example.invalid');
});
test('actual HTTP publication and durable readback, duplicates and conflicting metadata',async t=>{
  const rows=[];let posts=0;
  const server=createServer(async(req,res)=>{
    const u=new URL(req.url,'http://localhost');res.setHeader('content-type','application/json');
    if(req.method==='GET'&&u.pathname==='/events'){assert.equal(u.searchParams.get('source'),'release/fixture/'+sha);res.end(JSON.stringify({order:'desc',events:rows.filter(row=>row.event.source.id===u.searchParams.get('source')&&row.event.type===u.searchParams.get('type'))}));return;}
    let raw='';for await(const chunk of req)raw+=chunk;
    const input=JSON.parse(raw);posts++;
    assert.equal(input.event_id,'release:'+input.data.package+':'+input.data.sha+':'+input.type);
    const event={...input,source:{id:input.source}};
    rows.push({cursor:posts,event});
    res.end(JSON.stringify({published:true,event}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const api='http://127.0.0.1:'+server.address().port;
  const event=releaseEvent({packageName:'fixture',sha,version:'1.0.0'});
  assert.equal((await publishVerified(api,event)).cursor,1);
  assert.equal((await publishVerified(api,event)).cursor,1);
  assert.equal(posts,1);
  await assert.rejects(publishVerified(api,releaseEvent({packageName:'fixture',sha,version:'1.0.1'})),/different metadata/);
  assert.equal(posts,1);
  assert.equal((await publishVerified(api,releaseEvent({packageName:'fixture',sha,version:'1.0.0',stage:'native activation'}))).cursor,2);
});
