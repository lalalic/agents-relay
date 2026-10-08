import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { runCliEntrypoint } from '../dist/cli-shutdown.js';

test('one-shot CLI terminal work forces bounded shutdown of lingering handles', async () => {
  const before=process.exitCode;
  try {
    const codes=[];
    await runCliEntrypoint(async () => {}, {graceMs:10,forceExit:code=>codes.push(code)});
    await new Promise(resolve=>setTimeout(resolve,35));
    assert.deepEqual(codes,[0]);
  } finally { process.exitCode=before; }
});
test('daemon CLI mode never forces a terminal process exit', async () => {
  const before=process.exitCode;
  try {
    const codes=[];
    await runCliEntrypoint(async () => {}, {serve:true,graceMs:10,forceExit:code=>codes.push(code)});
    await new Promise(resolve=>setTimeout(resolve,35));
    assert.deepEqual(codes,[]);
  } finally { process.exitCode=before; }
});
