// External CLI-only acceptance for the native Rust Relay daemon. Test code never
// imports Relay code, reads its SQLite files, calls its HTTP API or invents events.
// Only installed CLI processes drive/query Relay. Git/filesystem verify artifacts.
import {spawn, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'node:net';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i+1] : fallback;
};
const cliBin = resolve(option('--cli', join(source, 'rust/target/debug/agents-relay-rust')));
const daemonBin = resolve(option('--daemon', join(source, 'rust/target/debug/agents-relayd-rust')));
const keep = process.argv.includes('--keep');
// Default: minimum, quick smoke path. Explicit --full runs all twelve checks.
const full = process.argv.includes('--full');
const quickCases = new Set(['01', '05', '08']);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'agents-relay-cli-mvp-')));
const project = join(root, 'fixture');
const workspace = root;
const repo = 'fixture';
const rows = [];
const transcript = [];
const maxMs = Number(option('--timeout-ms', full ? '80000' : '25000'));
const nodeBin = process.execPath;
let port;
let daemon = null;
let daemonLog = '';
let sequence = 0;
let dagJob = null;
let basicJob = null;
const env = {...process.env, AGENTS_RELAY_SCRIPT_NODE: nodeBin};
function processCommand(exe, argv, {timeout = 20000, check = true, parse = true} = {}) {
  const out = spawnSync(exe, argv, {cwd:source, env, encoding:'utf8', timeout, maxBuffer:4*1024*1024});
  const result = {command:exe.split('/').at(-1), args:argv, code:out.status, signal:out.signal,
    stdout:out.stdout || '', stderr:out.stderr || '', error:out.error?.message};
  transcript.push(result);
  if (check && out.status !== 0) throw Error(`${result.command} ${argv.slice(0,3).join(' ')} exited ${out.status}: ${result.stderr || result.error || result.stdout}`);
  if (!parse || out.status !== 0) return result;
  try { return JSON.parse(result.stdout); }
  catch { throw Error(`CLI did not return parseable JSON: ${result.stdout.slice(0,500)}`); }
}
function git(...args) { return processCommand('git', args, {parse:false}); }
function cli(...args) { return processCommand(cliBin, [...args, '--port', String(port)]); }
function cliResult(args) { return processCommand(cliBin, [...args, '--port', String(port)], {check:false, parse:false}); }
function check(ok, why) { if (!ok) throw Error(why); }
function noTaskIds(job) { return Array.isArray(job.tasks) && job.tasks.length === 0; }
function job(id) { return cli('job', 'show', '--repo', repo, '--id', String(id)); }
function tasks(id) { const data = cli('task', 'list', '--repo', repo, '--id', String(id)); return Array.isArray(data) ? data : data.tasks; }
function create(title, more = []) {
  const result = cli('job', 'create', '--repo', repo, '--project-root', project,
    '--title', title, '--objective-file', join(project, 'objective.md'), ...more);
  const id = String(result.job ?? result.id ?? '');
  check(/^\d+$/.test(id), `create response lacks numeric Job ID: ${JSON.stringify(result)}`);
  return {id, result};
}
function taskChildren(id) { return job(id).tasks.filter(t => t.dagNode && t.agentName !== 'coordinator'); }
async function poll(label, fn, timeout = maxMs) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { last = fn(); if (last) return last; }
    catch(e) { last = e.message; }
    await delay(180);
  }
  throw Error(`Timed out polling ${label}; last=${JSON.stringify(last)?.slice(0,800)}`);
}
async function getPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const p = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return p;
}
async function startDaemon() {
  check(!daemon, 'Daemon is already running');
  daemonLog = join(root, `daemon-${++sequence}.log`);
  const {openSync, closeSync} = await import('node:fs');
  const fd = openSync(daemonLog, 'w');
  daemon = spawn(daemonBin, ['--isolated-write-store-dir', join(root,'stores'),
    '--workspace-root', workspace, '--repo', repo, '--port', String(port), '--interval', '100'],
    {cwd:source, env, stdio:['ignore', fd, fd]});
  closeSync(fd);
  try {
    await poll('daemon CLI readiness', () => {
      check(daemon.exitCode === null, `Daemon exited: ${readFileSync(daemonLog, 'utf8').slice(-2000)}`);
      const output = cliResult(['status']);
      if (output.code !== 0) return null;
      try { return JSON.parse(output.stdout); } catch { return null; }
    }, 15000);
  } catch(e) { await stopDaemon(); throw e; }
}
async function stopDaemon() {
  if (!daemon) return;
  const child = daemon; daemon = null;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(4500)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([new Promise(resolve => child.once('exit',resolve)),delay(1800)]);
  }
}
function script(name, body) {
  const agentRoot = join(project, 'agents');
  mkdirSync(join(agentRoot,'.shortcut'), {recursive:true});
  writeFileSync(join(agentRoot, `${name}.agent.md`), `---\nname: ${name}\ncapabilities: [script]\n---\n# CLI MVP ${name}\n`);
  writeFileSync(join(agentRoot, '.shortcut', `${name}.agent.mjs`), body);
}
function successScript(name, previous) {
  const target = join(project, `${name}.txt`);
  const old = previous ? join(project, `${previous}.txt`) : null;
  script(name, `import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';\nexport async function run({input}) {\n${old ? `if (!readFileSync(${JSON.stringify(old)},'utf8').includes('done')) throw Error('dependency missing');` : ''}\nwriteFileSync(${JSON.stringify(target)},'done '+input.executionId+'\\n');\nappendFileSync(${JSON.stringify(join(project, 'worker-invocations.jsonl'))},JSON.stringify({agent:${JSON.stringify(name)},executionId:input.executionId,at:Date.now()})+'\\n');\nreturn {status:'COMPLETED',output:{agent:${JSON.stringify(name)},executionId:input.executionId},artifacts:{file:${JSON.stringify(target)}}};\n}\n`);
}
function graphJob(title, graph, args = ['--no-review']) {
  const key = ++sequence;
  const graphFile = join(root, `graph-${key}.mmd`);
  const inputFile = join(root, `input-${key}.md`);
  writeFileSync(graphFile, graph);
  writeFileSync(inputFile, 'Execute only declared DAG Agent Tasks.\n');
  const created = create(title, ['--coordinator-graph-file', graphFile,
    '--coordinator-input-file', inputFile, '--coordinator-output-path', join(root, `result-${key}.json`),
    '--coordinator-project-root', project, '--coordinator-workspace-root', root, ...args]);
  const coordinator = job(created.id).tasks.find(t => t.agentGraph);
  check(coordinator?.id, `Coordinator Task missing after creation: ${JSON.stringify(job(created.id))}`);
  return {...created, taskId:String(coordinator.id)};
}
function runDag(run) { return cli('job','run','--id',run.id,'--task-id',run.taskId,'--workspace-root',root); }
async function finished(id, timeout = maxMs) {
  return poll(`Job ${id} COMPLETED`, () => {
    const state = job(id);
    if (state.state === 'COMPLETED') return state;
    if (state.state === 'CANCELLED') throw Error('Job cancelled unexpectedly');
    return null;
  }, timeout);
}
async function test(name, fn) {
  if (!full && !quickCases.has(name.slice(0, 2))) return;
  const start = Date.now();
  try {
    const detail = await fn();
    rows.push({name,status:'PASS',ms:Date.now()-start,detail:detail || null});
    console.log(`PASS    ${name}`);
  } catch(error) {
    const message = error instanceof Error ? error.message : String(error);
    const blocked = message.startsWith('BLOCKED:');
    rows.push({name,status:blocked?'BLOCKED':'FAIL',ms:Date.now()-start,error:message});
    console.log(`${blocked?'BLOCKED':'FAIL'}  ${name} ${message.slice(0,240)}`);
  }
}
function blocked(message) {throw Error('BLOCKED: '+message);}
async function main() {
  mkdirSync(join(root,'stores'), {recursive:true});
  mkdirSync(project, {recursive:true});
  git('init','-q','-b','main',project);
  git('-C',project,'config','user.name','Relay MVP Fixture');
  git('-C',project,'config','user.email','relay-mvp@invalid.test');
  writeFileSync(join(project,'objective.md'), 'Demonstrate a CLI-driven durable Agent execution with real artifacts.\n');
  git('-C',project,'add','.');
  git('-C',project,'commit','-q','-m','CLI MVP fixture');
  port = await getPort();
  await startDaemon();
  await test('01 Create-only Job', async () => {
    basicJob=create('MVP1 Create-only', ['--no-review','--no-auto-merge']);
    const value=job(basicJob.id);
    check(value.state==='DRAFT' && noTaskIds(value), 'create-only Job did not stay DRAFT with zero tasks');
    check(cli('job','list','--repo',repo).some(j=>String(j.id)===basicJob.id), 'CLI Job list is missing created Job');
    check(tasks(basicJob.id).length===0, 'CLI Task list is not empty');
    return {jobId:basicJob.id};
  });
  await test('02 Show/List Job and Tasks', async () => {
    check(basicJob?.id, 'MVP1 Job was not created');
    const value=job(basicJob.id);
    check(value.title==='MVP1 Create-only' && value.repository===repo,'CLI show lost immutable Job identity');
    check(cli('job','list','--repo',repo).some(j=>String(j.id)===basicJob.id),'CLI Job list missing created Job');
    check(tasks(basicJob.id).length===0, 'CLI Task list is not empty');
    return {jobId:basicJob.id};
  });
  await test('03 Restart and Read Back', async () => {
    check(basicJob?.id,'MVP1 Job was not created');
    await stopDaemon(); await startDaemon();
    const value=job(basicJob.id);
    check(value.state==='DRAFT' && noTaskIds(value),'Job changed across daemon restart');
    return {jobId:basicJob.id};
  });
  await test('04 Invalid ID Rejected', async () => {
    const before=cli('job','list','--repo',repo).length;
    const bad=cliResult(['job','show','--repo',repo,'--id','no-such-job-0']);
    check(bad.code!==0,'CLI returned success for missing Job');
    check(cli('job','list','--repo',repo).length===before,'Invalid lookup mutated Job inventory');
  });
  await test('05 Real Script A→B→C', async () => {
    for (const [name,pre] of [['alpha',null],['beta','alpha'],['gamma','beta']]) successScript(name,pre);
    dagJob=graphJob('MVP2 Real Script DAG', 'flowchart TD\nA[agent:alpha] --> B[agent:beta]\nB --> C[agent:gamma]\n');
    runDag(dagJob);
    const value=await finished(dagJob.id, full ? 70000 : maxMs);
    const children=value.tasks.filter(t=>t.dagNode?.parentTaskId===dagJob.taskId);
    check(children.length===3, `Expected 3 DAG children, received ${children.length}`);
    check(children.every(t=>t.state==='SUCCEEDED'),`DAG children not successful: ${children.map(t=>t.state)}`);
    for (const name of ['alpha','beta','gamma']) check(existsSync(join(project,`${name}.txt`)),`${name} artifact missing`);
    const invocations=readFileSync(join(project,'worker-invocations.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    check(invocations.map(x=>x.agent).join(',')==='alpha,beta,gamma',`Worker order/duplicates: ${JSON.stringify(invocations)}`);
    return {jobId:dagJob.id,childTaskIds:children.map(t=>t.id),invocations:invocations.length};
  });
  await test('06 Real Model Worker Execution', async () => {
    // A real provider must be configured outside the test. A Script worker
    // or synthetic EventBus receipt is never an acceptable substitution.
    blocked('No caller-supplied real Model provider fixture/credentials; do not count Script as Model E2E');
  });
  await test('07 Real Final Review + Local Merge', async () => {
    // The preceding smoke intentionally uses --no-review and --no-auto-merge.
    // Completion is not evidence of independent Reviewer approval/Git merge.
    blocked('Independent real Reviewer configuration not supplied; no fabricated Final Review or merge');
  });
  await test('08 Job COMPLETED Readback', async () => {
    check(dagJob?.id,'MVP2 DAG was not created');
    const before=job(dagJob.id);
    check(before.state==='COMPLETED','DAG Job is not COMPLETED');
    await stopDaemon();await startDaemon();
    const after=job(dagJob.id);
    check(after.state==='COMPLETED' && after.tasks.length===before.tasks.length,'Terminal state changed on restart');
    check(after.tasks.filter(t=>t.dagNode).every(t=>t.state==='SUCCEEDED'),'Completed child reran or regressed');
    return {jobId:dagJob.id};
  });
  await test('09 Failed Task CLI Retry', async () => {
    const marker=join(project,'retry-ready.txt');
    script('flaky',`import {existsSync,writeFileSync} from 'node:fs';\nexport async function run({input}){if(!existsSync(${JSON.stringify(marker)}))throw Error('Test-owned prerequisite absent');writeFileSync(${JSON.stringify(join(project,'retry-success.txt'))},input.executionId);return {status:'COMPLETED',output:{retry:true},artifacts:{}};}\n`);
    const run=graphJob('MVP3 Retry', 'flowchart TD\nF[agent:flaky]\n');runDag(run);
    const failed=await poll('failed retry candidate',()=>job(run.id).tasks.find(t=>t.agentName==='flaky'&&t.state==='FAILED'),35000);
    writeFileSync(marker,'ready');
    const before=job(run.id).tasks.find(t=>t.id===failed.id);
    cli('task','retry','--id',run.id,'--task-id',String(failed.id),'--repo',repo);
    const after=await finished(run.id,45000);
    const retried=after.tasks.find(t=>t.id===failed.id);
    check(retried?.state==='SUCCEEDED','Retry did not succeed');
    check(Number(retried.attempt)>=Number(before.attempt),'Retry attempt regressed');
    check(existsSync(join(project,'retry-success.txt')),'Retry produced no artifact');
    return {jobId:run.id,taskId:failed.id};
  });
  await test('10 CLI Pause/Resume', async () => {
    script('sleeper',`export async function run({input}) { await new Promise(r=>setTimeout(r,3000)); return {status:'COMPLETED',output:{executionId:input.executionId},artifacts:{}}; }\n`);
    const run=graphJob('MVP3 Pause Resume','flowchart TD\nS[agent:sleeper]\n');runDag(run);
    await poll('sleeper RUNNING',()=>job(run.id).tasks.find(t=>t.agentName==='sleeper'&&t.state==='RUNNING'),12000);
    cli('job','pause','--id',run.id,'--repo',repo);
    const paused=job(run.id);
    check(paused.pause && paused.state==='ACTIVE','Job pause did not persist');
    cli('job','resume','--id',run.id,'--repo',repo);
    const after=await finished(run.id,40000);
    check(after.state==='COMPLETED','Resumed Job did not complete');
    return {jobId:run.id};
  });
  await test('11 Daemon Restart Recovery', async () => {
    script('rebooter',`export async function run({input}) { await new Promise(r=>setTimeout(r,3500)); return {status:'COMPLETED',output:{executionId:input.executionId},artifacts:{}}; }\n`);
    const run=graphJob('MVP3 Restart Recovery','flowchart TD\nR[agent:rebooter]\n');runDag(run);
    await poll('rebooter RUNNING',()=>job(run.id).tasks.find(t=>t.agentName==='rebooter'&&t.state==='RUNNING'),12000);
    await stopDaemon();await startDaemon();
    const after=await finished(run.id,45000);
    check(after.tasks.find(t=>t.agentName==='rebooter')?.state==='SUCCEEDED','Restart did not recover owned worker');
    return {jobId:run.id};
  });
  await test('12 Cancel and Idempotency', async () => {
    script('cancellable',`import {writeFileSync} from 'node:fs';\nexport async function run(){await new Promise(r=>setTimeout(r,8000));writeFileSync(${JSON.stringify(join(project,'cancel-invalid.txt'))},'unexpected');return {status:'COMPLETED',output:{cancelled:false},artifacts:{}};}\n`);
    const run=graphJob('MVP3 Cancel','flowchart TD\nX[agent:cancellable]\n');runDag(run);
    await poll('cancellable RUNNING',()=>job(run.id).tasks.find(t=>t.agentName==='cancellable'&&t.state==='RUNNING'),15000);
    cli('job','cancel','--id',run.id,'--repo',repo);
    const after=job(run.id);
    check(after.state==='CANCELLED',`Cancel did not reach CANCELLED: ${after.state}`);
    const second=cliResult(['job','cancel','--id',run.id,'--repo',repo]);
    check(second.code===0 || /already|cancel|terminal|not cancellable/i.test(second.stderr), 'Repeat cancel returned unexpected error');
    await delay(900);
    check(job(run.id).state==='CANCELLED','Cancelled Job changed state');
    check(!existsSync(join(project,'cancel-invalid.txt')),'Cancelled Worker wrote a post-cancel artifact');
    return {jobId:run.id,repeatExitCode:second.code};
  });
}
try { await main(); }
catch(error) { console.error('HARNESS_SETUP_FAILURE:', error.stack || error); process.exitCode=2; }
finally {
  await stopDaemon();
  const expected = full ? 12 : quickCases.size;
  const report = {schema:'agents-relay-cli-mvp.v1',mode:full?'full':'quick',cliBin,daemonBin,root,
    results:rows,summary:{PASS:rows.filter(x=>x.status==='PASS').length,
      FAIL:rows.filter(x=>x.status==='FAIL').length,
      BLOCKED:rows.filter(x=>x.status==='BLOCKED').length,expected}};
  writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n');
  writeFileSync(join(root,'cli-transcript.json'),JSON.stringify(transcript,null,2)+'\n');
  console.log('RESULT',JSON.stringify(report.summary),'evidence:',root);
  if (report.summary.FAIL || report.summary.BLOCKED || rows.length !== expected) process.exitCode ||= 1;
  if (!keep && process.exitCode !== 1 && process.exitCode !== 2 && report.summary.PASS===expected) rmSync(root,{recursive:true,force:true});
}
