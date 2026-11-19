import { resolveExecutionContext, type ExecutionRole } from './execution-context.js';
import { arg } from './cli-support.js';
import { usage } from './cli-help.js';

export async function runContextCommand(action: string, args: string[]): Promise<void> {
  if (action !== 'resolve') throw new Error(usage);
  const projectPath = arg(args, '--project-path');
  if (!projectPath) throw new Error('context resolve requires --project-path');
  const roleValue = arg(args, '--role', 'orchestrator');
  const roles: ExecutionRole[] = ['orchestrator', 'planner', 'reviewer', 'worker', 'nested-worker'];
  if (!roles.includes(roleValue as ExecutionRole)) throw new Error('--role must be orchestrator, planner, reviewer, worker, or nested-worker');
  const context = await resolveExecutionContext(projectPath, roleValue as ExecutionRole, {
    workspaceRoot: arg(args, '--workspace-root') || undefined,
    globalRoot: arg(args, '--global-root') || undefined,
    explicitSkills: arg(args, '--skills').split(',').filter(Boolean),
    explicitAgents: arg(args, '--agents').split(',').filter(Boolean),
  });
  console.log(JSON.stringify(context, null, 2));
}
