#!/usr/bin/env python3
"""Installed native CLI serve single-process E2E, isolated Git/SQLite.
No live daemon, network service, browser, credential or operator EventBus."""
import json, socket, subprocess, tempfile, time, pathlib, shutil, urllib.request
base=pathlib.Path(__file__).resolve().parents[2]
cli=base/'rust/target/debug/agents-relay-rust'
root=pathlib.Path(tempfile.mkdtemp(prefix='rust2-cli-serve-'))
(root/'stores').mkdir()
project=root/'fixture';project.mkdir()
subprocess.run(['git','init','-q','-b','main'],cwd=project,check=True)
listener=socket.socket();listener.bind(('127.0.0.1',0))
port=listener.getsockname()[1];listener.close()
log=(root/'daemon.log').open('w')
serve=subprocess.Popen([str(cli),'serve','--isolated-write-store-dir',str(root/'stores'),
 '--workspace-root',str(root),'--repo','fixture','--port',str(port),
 '--interval','3000'],cwd=base,stdout=subprocess.DEVNULL,stderr=log)
try:
 ready=False
 for _ in range(160):
  if serve.poll() is not None:break
  try:
   req=urllib.request.urlopen('http://127.0.0.1:'+str(port)+'/api/version',timeout=.18)
   version=json.load(req)
   assert isinstance(version['version'],str)
   ready=True;break
  except Exception:time.sleep(.04)
 if not ready:raise RuntimeError('Native CLI serve did not boot its daemon: '+
  (root/'daemon.log').read_text()[-1500:])
 assert serve.poll() is None,'native CLI serve returned without owning daemon'
 status=json.load(urllib.request.urlopen(
  'http://127.0.0.1:'+str(port)+'/api/status',timeout=2))
 assert status['productionReady'] is False
 assert status['runtime']=='native-rust'
 raw=socket.create_connection(('127.0.0.1',port),timeout=3)
 raw.settimeout(4)
 raw.sendall(b'GET /events HTTP/1.1\r\nHost: localhost\r\n\r\n')
 received=b''
 while b': connected\n\n' not in received:
  received+=raw.recv(4096)
 assert received.startswith(b'HTTP/1.1 200 OK')
 assert b'Content-Type: text/event-stream' in received
 raw.close()
 print('CLI_SERVE_NATIVE_SINGLE_PID_E2E_PASS',
  json.dumps({'pid':serve.pid,'version':version['version'],
    'runtime':status['runtime'],'productionReady':status['productionReady'],
    'sseConnected':True}))
finally:
 serve.terminate()
 try:serve.wait(timeout=5)
 except subprocess.TimeoutExpired:serve.kill();serve.wait(timeout=5)
 log.close()
 # Same original CLI PID must be terminated (it exec'd daemon in place).
 try:
  socket.create_connection(('127.0.0.1',port),timeout=.25).close()
  raise AssertionError('Orphaned daemon listener after CLI serve termination')
 except ConnectionRefusedError:pass
 shutil.rmtree(root)
