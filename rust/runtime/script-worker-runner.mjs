// Trusted native Rust Script Worker subprocess bridge. This is a Worker,
// NOT a second Relay daemon or workflow authority. Rust owns the process
// group, leases, Graph events and SQLite terminal state.
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {isAbsolute} from 'node:path';

const abort = new AbortController();
process.on('SIGTERM', () => abort.abort(Error('Script Worker cancelled')));
process.on('SIGINT', () => abort.abort(Error('Script Worker interrupted')));
const result = async () => {
  let raw = '';
  for await (const part of process.stdin) {
    raw += part.toString('utf8');
    if (raw.length > 8*1024*1024) throw Error('Script input exceeded 8MB');
  }
  const request = JSON.parse(raw);
  if (!request || typeof request !== 'object' || !isAbsolute(request.script)
      || !request.input || typeof request.input !== 'object'
      || Array.isArray(request.input)) throw Error('Invalid trusted Script Worker request');
  // Top-level module logs also remain outside the stdout JSON protocol.
  console.log = (...values) => console.error(...values);
  const module = await import(pathToFileURL(request.script).href);
  if (typeof module.run !== 'function') throw Error('Agent Shortcut must export run(context)');
  const runCommand = async (argv, cwd) => {
    if (!Array.isArray(argv) || argv.length === 0
        || argv.some(value => typeof value !== 'string' || value.length === 0)
        || typeof cwd !== 'string' || !isAbsolute(cwd)) {
      throw Error('Script command requires an argv vector and an absolute cwd');
    }
    if (abort.signal.aborted) throw abort.signal.reason;
    const child = spawn(argv[0], argv.slice(1), {cwd, stdio:['ignore','pipe','pipe'],signal:abort.signal});
    const chunks = [[], []];
    for (const [i, stream] of [child.stdout, child.stderr].entries()) {
      stream.on('data', value => {
        chunks[i].push(value);
        const size = chunks[i].reduce((n, part) => n + part.length, 0);
        if (size > 1024*1024) child.kill('SIGTERM');
      });
    }
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => resolve(signal ? -1 : (status ?? -1)));
    });
    return {stdout:Buffer.concat(chunks[0]).toString('utf8'),
      stderr:Buffer.concat(chunks[1]).toString('utf8'),code};
  };
  const output = await module.run({input:request.input,signal:abort.signal,runCommand});
  if (abort.signal.aborted) throw abort.signal.reason;
  if (output === undefined) throw Error('Script Worker returned undefined');
  return {ok:true,result:output};
};
try {
  process.stdout.write(JSON.stringify(await result())+'\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error)})+'\n');
  process.exitCode=1;
}
