import { isFinalReviewAgent } from './final-review-role.js';
import type { PlannerTaskSpec } from './planner.js';

/** One durable newly authored Task per effective Agent responsibility in each Plan.
 * Null/blank agentName is the generic implementation role. Existing plans
 * and later genuine revision rounds are not retroactively constrained.
 */
export function validatePlannerAgentRoles(specs: readonly PlannerTaskSpec[]): void {
  const owners = new Map<string, string>();
  for (const spec of specs) {
    const role = spec.agentName?.trim() || 'implementation';
    if (isFinalReviewAgent(role)) {
      throw new Error(`Task ${spec.id} must not plan job-acceptance-reviewer: Relay creates the immutable-head Final Review gate automatically`);
    }
    const previous = owners.get(role);
    if (previous) throw new Error(`Tasks ${previous} and ${spec.id} have duplicate effective Agent role ${role}; consolidate all phases into one Task owned by that Agent in this Plan round. Future rounds may reuse the role for genuine revisions.`);
    owners.set(role, spec.id);
  }
}
