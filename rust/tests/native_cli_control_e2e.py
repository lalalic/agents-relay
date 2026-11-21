#!/usr/bin/env python3
"""Real installed Rust CLI → isolated daemon → Graph/SQLite E2E.

Uses disposable Git root, SQLite store and OS-assigned loopback port.
No live WebHelm, Codex CLI, operator EventBus, or production files.
Requires prior: cargo build --manifest-path rust/Cargo.toml
  --bin agents-relay-rust --bin agents-relayd-rust
"""
import json,socket,subprocess,tempfile,time,shutil,pathlib

base=pathlib.Path(__file__).resolve().parents[2]
binary=base/'rust/target/debug/agents-relay-rust'; daemon=base/'rust/target/debug/agents-relayd-rust'
root=pathlib.Path(tempfile.mkdtemp(prefix='rust2-cli-agents-e2e-'));(root/'stores').mkdir()
project=root/'fixture';project.mkdir()
subprocess.run(['git','init','-q','-b','main'],cwd=project,check=True)
sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
log=(root/'daemon.log').open('w')
p=subprocess.Popen([str(daemon),'--isolated-write-store-dir',str(root/'stores'),'--workspace-root',str(root),'--repo','fixture','--port',str(port),'--interval','2000'],cwd=base,stdout=subprocess.DEVNULL,stderr=log)
def cli(args,ok=True):
 proc=subprocess.run([str(binary),*args,'--port',str(port)],cwd=base,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=15)
 print('CLI',args[:4],'RC',proc.returncode,'OUT',proc.stdout[:250].replace('\n',' '),'ERR',proc.stderr[:220].replace('\n',' '))
 if ok and proc.returncode:raise RuntimeError(proc.stderr)
 if not ok and proc.returncode==0:raise RuntimeError('expected error, got success')
 return json.loads(proc.stdout) if proc.returncode==0 else None
try:
 ready=False
 for i in range(200):
  try:
   socket.create_connection(('127.0.0.1',port),timeout=.15).close();ready=True;break
  except OSError:
   if p.poll() is not None:break
   time.sleep(.06)
 if not ready:raise RuntimeError('daemon failed: '+(root/'daemon.log').read_text()[-1500:])
 job=cli(['job','create','--repo','fixture','--project-root',str(project),'--objective','Fixture-only agent registration','--no-review','--no-auto-merge'])
 id=job.get('id') or job.get('job')
 print('CREATED',id,job.get('state'),job.get('repository'))
 assert id and job['repository']=='fixture'
 status=cli(['status'])
 print('SUMMARY',list(status)[:7])
 registration=cli(['agent-register','--id',id,'--name','fixture-planner','--responsibility','Fixture only','--role','planner','--endpoint','fixture-endpoint','--agent-id','fixture-agent-123','--capabilities','plan,review'])
 assert registration['id']=='fixture-agent-123'
 found=cli(['agent-discover','--id',id,'--capabilities','plan','--availability','available'])
 print('DISCOVERY_COUNT',len(found))
 assert 'fixture-agent-123' in json.dumps(found), 'registration not in durable discovery'
 cli(['agent-register','--id',id,'--name','fixture-planner'],ok=False)
 task=cli(['task','create','--repo','fixture','--id',id,
  '--title','Fixture task','--agent','developer','--adapter','chatgpt',
  '--input','Test the canonical Graph','--output','file',
  '--output-path',str(project/'artifact.txt'),'--draft'])
 task_id=task.get('createdTaskId')
 print('CREATED_TASK',task_id,task.get('state'))
 assert task_id, 'Task ID not persisted'
 operation=cli(['workflow','action','--action','task.cancel',
  '--repo','fixture','--id',id,'--task-id',str(task_id)])
 job_after=cli(['job','show','--repo','fixture','--id',id])
 current=next(t for t in job_after['tasks'] if t['id']==str(task_id))
 print('TASK_AFTER_GRAPH_ACTION',current['state'])
 assert current['state']=='CANCELLED'
 print('CLI_AGENT_AND_WORKFLOW_REAL_E2E_PASS')
finally:
 p.terminate()
 try:p.wait(timeout=4)
 except subprocess.TimeoutExpired:p.kill();p.wait(timeout=4)
 log.close()
 print('DAEMON_END', (root/'daemon.log').read_text()[-1100:])
 shutil.rmtree(root)
