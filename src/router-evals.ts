import { DecisionEngine } from './decision.js';
import { executionTaskShape } from './execution-routing.js';
import { loadExecutionRouterRules } from './routing-policy.js';

export type RouterEvalCase = {
  id: string;
  storySize: 'S' | 'M' | 'L';
  task: string;
  chatgptAvailable: boolean;
  chatgptRunning?: number;
  chatgptSlots?: number;
  expectedWorker: 'chatgpt' | 'codex';
};

export type RouterEvalResult = RouterEvalCase & {
  selectedWorker: 'chatgpt' | 'codex' | 'unknown';
  selectedRoute: string;
  pass: boolean;
  probabilities?: Record<string, number>;
};

export type RouterEvalReport = {
  passed: number;
  total: number;
  results: RouterEvalResult[];
};

export const ROUTER_EVAL_CASES: readonly RouterEvalCase[] = [
  { id: 'small-review', storySize: 'S', task: 'Review a focused PR and explain any correctness issue.', chatgptAvailable: true, expectedWorker: 'chatgpt' },
  { id: 'medium-investigation', storySize: 'M', task: 'Investigate why a Relay job is blocked and propose a focused fix.', chatgptAvailable: true, expectedWorker: 'chatgpt' },
  { id: 'small-code-fix', storySize: 'S', task: 'Apply a small configuration or one-file code fix and verify it.', chatgptAvailable: true, expectedWorker: 'chatgpt' },
  { id: 'medium-browser-operation', storySize: 'M', task: 'Use browser and MacBridge tools to inspect state and make a bounded change.', chatgptAvailable: true, expectedWorker: 'chatgpt' },
  { id: 'medium-near-capacity', storySize: 'M', task: 'Complete a normal engineering task while other ChatGPT work is active.', chatgptAvailable: true, chatgptRunning: 8, expectedWorker: 'chatgpt' },
  { id: 'large-refactor', storySize: 'L', task: 'Implement a broad multi-file repository refactor with tests.', chatgptAvailable: true, expectedWorker: 'codex' },
  { id: 'large-test-fix-loop', storySize: 'L', task: 'Run a sustained code-test-debug loop across a large change.', chatgptAvailable: true, expectedWorker: 'codex' },
  { id: 'small-one-slot-left', storySize: 'S', task: 'Perform a short reasoning and operational task.', chatgptAvailable: true, chatgptSlots: 1, expectedWorker: 'chatgpt' },
  { id: 'workspace-exhausted', storySize: 'S', task: 'Review a focused issue while Browser Workspace has no free slot.', chatgptAvailable: false, chatgptSlots: 0, expectedWorker: 'codex' },
  { id: 'large-workspace-available', storySize: 'L', task: 'Implement a large feature even though ChatGPT workspace capacity is healthy.', chatgptAvailable: true, expectedWorker: 'codex' },
];

const CODEX_ROUTE = 'codex::default:openai/gpt-5.6-sol@medium';
const CHATGPT_ROUTE = 'chatgpt/browser-worker::chatgpt/account-defaults';

function workerForRoute(route: string): 'chatgpt' | 'codex' | 'unknown' {
  if (route.startsWith('chatgpt/')) return 'chatgpt';
  if (route.startsWith('codex::')) return 'codex';
  return 'unknown';
}

export async function runRouterEvals(engine: DecisionEngine, rulesPath?: string): Promise<RouterEvalReport> {
  const rules = await loadExecutionRouterRules(rulesPath);
  const results: RouterEvalResult[] = [];
  for (const testCase of ROUTER_EVAL_CASES) {
    const taskShape = executionTaskShape({ storySize: testCase.storySize });
    const available = testCase.chatgptAvailable;
    const choices = available ? [CODEX_ROUTE, CHATGPT_ROUTE] : [CODEX_ROUTE];
    const eligibleRoutes = [
      {
        id: CODEX_ROUTE,
        worker: 'codex',
        provider: 'openai',
        model: 'gpt-5.6-sol',
        profile: null,
        reasoning: 'medium',
        code_plan: { five_hour: null, weekly: null },
      },
      ...(available ? [{
        id: CHATGPT_ROUTE,
        worker: 'chatgpt',
        provider: 'chatgpt',
        model: 'account-defaults',
        profile: null,
        reasoning: null,
        code_plan: { five_hour: null, weekly: null },
      }] : []),
    ];
    const facts = {
      context: {
        job: { id: 'router-eval', title: 'Router eval', objective: 'Evaluate worker and model route selection.' },
        task: { id: testCase.id, kind: 'work', storySize: testCase.storySize, input: testCase.task },
        task_shape: {
          story_size: taskShape.storySize,
          sustained_work: taskShape.sustainedWork,
          preferred_worker: taskShape.preferredWorker,
          reason: taskShape.reason,
        },
        reviewer: null,
      },
      user_input_rules: rules.text,
      runtime: { chatgpt_running: testCase.chatgptRunning ?? 0, preferred_chatgpt_concurrency: 10 },
      eligible_routes: eligibleRoutes,
    };
    const decision = await engine.decide(
      { facts },
      {
        type: 'choice',
        question: 'Choose one eligible complete execution route. Treat context.task_shape.preferred_worker as the default worker-fit signal; user_input_rules and concrete runtime or code-plan resource facts may override it. The choice identifies worker, provider, model, profile, and reasoning together.',
        choices,
      },
    );
    const selectedWorker = workerForRoute(decision.choice);
    results.push({
      ...testCase,
      selectedWorker,
      selectedRoute: decision.choice,
      pass: selectedWorker === testCase.expectedWorker,
      probabilities: decision.probabilities,
    });
  }
  return { passed: results.filter(item => item.pass).length, total: results.length, results };
}
