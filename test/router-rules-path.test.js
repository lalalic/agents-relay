import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { executionRouterRulesPath } from '../dist/routing-policy.js';
import { configureExecutionRouterRulesPath, daemonHelp } from '../dist/relayd.js';

test('Router Rules default path is stable under the user home directory', () => {
  const old = process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES;
  delete process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES;
  try {
    assert.equal(executionRouterRulesPath(), join(homedir(), '.agents-relay', 'execution-router-rules.md'));
  } finally {
    if (old === undefined) delete process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES; else process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES = old;
  }
});

test('Router Rules path precedence is explicit CLI path over env over default', () => {
  const old = process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES;
  process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES = '/tmp/from-env.md';
  try {
    assert.equal(executionRouterRulesPath('/tmp/from-cli.md'), '/tmp/from-cli.md');
    assert.equal(executionRouterRulesPath(), '/tmp/from-env.md');
  } finally {
    if (old === undefined) delete process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES; else process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES = old;
  }
});

test('agents-relayd exposes the Router Rules CLI option', () => {
  assert.match(daemonHelp, /--execution-router-rules PATH/);
  assert.match(daemonHelp, /~\/.agents-relay\/execution-router-rules\.md/);
});

test('agents-relayd CLI rules path overrides an existing env value', () => {
  const old = process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES;
  process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES = '/tmp/from-env.md';
  try {
    assert.equal(configureExecutionRouterRulesPath(['--execution-router-rules', '/tmp/from-cli.md']), '/tmp/from-cli.md');
    assert.equal(process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES, '/tmp/from-cli.md');
  } finally {
    if (old === undefined) delete process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES; else process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES = old;
  }
});
