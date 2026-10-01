import type { WorkflowEffectName } from './contracts.js';
import { classifyFailure, observability } from '../observability.js';

export type WorkflowEffectContext = {
  jobId: string;
  taskId?: string;
  transitionKey: string;
  data?: Record<string, unknown>;
};

export type WorkflowEffectOutcome = {
  effect: WorkflowEffectName;
  key: string;
  status: 'completed' | 'failed' | 'deduplicated';
  error?: string;
};

export interface WorkflowEffectReceiptStore {
  has(key: string): Promise<boolean>;
  markCompleted(key: string): Promise<void>;
}

export class MemoryWorkflowEffectReceiptStore implements WorkflowEffectReceiptStore {
  private readonly completed = new Set<string>();
  async has(key: string): Promise<boolean> { return this.completed.has(key); }
  async markCompleted(key: string): Promise<void> { this.completed.add(key); }
}

export abstract class WorkflowEffectHandler {
  constructor(readonly name: WorkflowEffectName) {}
  idempotencyKey(context: WorkflowEffectContext): string {
    return `${this.name}:${context.jobId}:${context.taskId ?? 'job'}:${context.transitionKey}`;
  }
  abstract execute(context: WorkflowEffectContext): Promise<void>;
}

export class CallbackWorkflowEffectHandler extends WorkflowEffectHandler {
  constructor(
    name: WorkflowEffectName,
    private readonly callback: (context: WorkflowEffectContext) => void | Promise<void>,
    private readonly key?: (context: WorkflowEffectContext) => string,
  ) { super(name); }

  override idempotencyKey(context: WorkflowEffectContext): string {
    return this.key?.(context) ?? super.idempotencyKey(context);
  }

  async execute(context: WorkflowEffectContext): Promise<void> { await this.callback(context); }
}

export class WorkflowEffectExecutor {
  private readonly handlers = new Map<WorkflowEffectName, WorkflowEffectHandler>();

  constructor(
    handlers: readonly WorkflowEffectHandler[] = [],
    private readonly receipts: WorkflowEffectReceiptStore = new MemoryWorkflowEffectReceiptStore(),
  ) {
    for (const handler of handlers) this.register(handler);
  }

  register(handler: WorkflowEffectHandler): void {
    if (this.handlers.has(handler.name)) throw new Error(`Workflow effect handler already registered: ${handler.name}`);
    this.handlers.set(handler.name, handler);
  }

  async execute(
    effects: readonly WorkflowEffectName[],
    context: WorkflowEffectContext,
    onOutcome?: (outcome: WorkflowEffectOutcome) => void | Promise<void>,
  ): Promise<WorkflowEffectOutcome[]> {
    const outcomes: WorkflowEffectOutcome[] = [];
    for (const effect of effects) {
      const handler = this.handlers.get(effect);
      if (!handler) throw new Error(`No workflow effect handler registered for ${effect}`);
      const key = handler.idempotencyKey(context);
      if (await this.receipts.has(key)) {
        const outcome: WorkflowEffectOutcome = { effect, key, status: 'deduplicated' };
        outcomes.push(outcome);
        this.recordEffect(context, outcome);
        await onOutcome?.(outcome);
        continue;
      }
      try {
        await handler.execute(context);
        await this.receipts.markCompleted(key);
        const outcome: WorkflowEffectOutcome = { effect, key, status: 'completed' };
        outcomes.push(outcome);
        this.recordEffect(context, outcome);
        await onOutcome?.(outcome);
      } catch (error) {
        const outcome: WorkflowEffectOutcome = {
          effect,
          key,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
        outcomes.push(outcome);
        this.recordEffect(context, outcome, error);
        await onOutcome?.(outcome);
      }
    }
    return outcomes;
  }

  private recordEffect(
    context: WorkflowEffectContext,
    outcome: WorkflowEffectOutcome,
    error?: unknown,
  ): void {
    observability().record({
      stage: 'transition',
      event: outcome.status === 'failed' ? 'workflow.effect.failed' : 'workflow.effect',
      level: outcome.status === 'failed' ? 'error' : 'info',
      outcome: outcome.status === 'deduplicated' ? 'deduplicated' : outcome.status === 'failed' ? 'failed' : 'succeeded',
      message: outcome.status === 'failed'
        ? `Effect ${outcome.effect} failed: ${outcome.error ?? 'unknown error'}`
        : `Effect ${outcome.effect} ${outcome.status}`,
      correlation: { jobId: context.jobId, taskId: context.taskId },
      transition: { graph: 'workflow.effect', from: null, to: null, actions: [outcome.effect] },
      data: {
        effect: outcome.effect,
        idempotencyKey: outcome.key,
        transitionKey: context.transitionKey,
        ...(error ? { classification: classifyFailure(error).classification } : {}),
      },
    });
  }
}
