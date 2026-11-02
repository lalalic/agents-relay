import {createServer} from 'node:net';
import {join} from 'node:path';

/** Isolated daemon-API fixture: never accesses the user's real WebHelm socket. */
export async function fakeWebHelmDaemon(root,{onPlatformRun}={}){
  const requests=[];
  const socket=join(root,'webhelm.sock');
  let seq=0;
  const server=createServer(connection=>{
    let data='';
    connection.setEncoding('utf8');
    connection.on('data',chunk=>{
      data+=chunk;
      const end=data.indexOf('\n');
      if(end<0)return;
      let request;
      try{request=JSON.parse(data.slice(0,end));}catch(e){connection.end(JSON.stringify({error:e.message})+'\n');return;}
      requests.push(request);
      const id=request.session_id;
      let response;
      if(request.op==='workspace-create')response={name:request.name,poolSize:request.pool_size,initialized:true};
      else if(request.op==='start')response={session_id:'test-session-'+(++seq),workspace:request.workspace,workspace_supported:true};
      else if(request.op==='stop')response={session_id:id,returned_to_idle:true};
      else if(request.op==='heartbeat')response={session_id:id,alive:true,last_used_at:Date.now()};
      else if(request.op==='exec')response={session_id:id,ok:true,stdout:'{}'};
      else if(request.op==='platform-run'){
        const reply=onPlatformRun?.(request) || {
          status:'submitted',mode:request.action,thread_id:'6add12f0-ca3c-83e8-9457-0a6619057823',
          thread_url:request.platform==='z'?'https://chat.z.ai/c/6add12f0-ca3c-83e8-9457-0a6619057823':'https://chatgpt.com/c/6add12f0-ca3c-83e8-9457-0a6619057823',
          verified_by:'matching-user-turn',
        };
        response={result:{ok:true,stdout:JSON.stringify(reply)}};
      }else response={error:'Unexpected mock daemon op: '+request.op};
      connection.end(JSON.stringify(response)+'\n');
    });
  });
  await new Promise((resolve,reject)=>server.listen(socket,resolve).once('error',reject));
  const previous=process.env.WEBHELM_SOCKET;
  process.env.WEBHELM_SOCKET=socket;
  return {requests, close:async()=>{
    if(previous===undefined)delete process.env.WEBHELM_SOCKET;
    else process.env.WEBHELM_SOCKET=previous;
    await new Promise(resolve=>server.close(resolve));
  }};
}
