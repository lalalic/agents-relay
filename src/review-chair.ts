import type { ResolvedAgent } from './execution-context.js';
import type { ReviewTarget, ReviewTaskMetadata, Task } from './types.js';

export type ReviewDimension = { name: string; description?: string; priority?: number };
export type ReviewPanelMember = {
  agent: string;
  dimension: string;
  reason: string;
};
export type ReviewCandidate = {
  agent: string;
  dimensions: readonly string[];
  description?: string;
};
export type ReviewFinding = {
  id?: string;
  reviewer: string;
  dimension: string;
  verdict: 'pass' | 'concern' | 'fail' | 'blocked';
  summary: string;
  severity?: 'P0' | 'P1' | 'P2' | 'P3';
  location?: string;
  recommendation?: string;
  evidence?: string;
  attributions?: Array<{ reviewer: string; dimension: string; findingId?: string }>;
};
export type SpecialistReview = {
  reviewer: string;
  dimension: string;
  target: ReviewTarget;
  verdict: 'pass' | 'concern' | 'fail' | 'blocked';
  findings: ReviewFinding[];
};
export type RevisionAction = {
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  action: string;
  findingIds: string[];
  rationale: string;
};
export type ReviewSynthesis = {
  target: ReviewTarget;
  panel: ReviewPanelMember[];
  findings: ReviewFinding[];
  conflicts: Array<{ findingIds: string[]; resolution: string }>;
  actions: RevisionAction[];
  unresolved: ReviewFinding[];
  needsAdditionalSpecialist: boolean;
  missingDimensions: string[];
};
export type ReviewChairExecutionPlan = {
  target: ReviewTarget;
  panel: ReviewPanelMember[];
  specialistTasks: ReviewTaskMetadata[];
};

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`Review ${field} must be a non-empty string`);
  return value.trim();
}

function target(value: unknown): ReviewTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Review target must be an object');
  const record = value as Record<string, unknown>;
  return { artifact: text(record.artifact, 'target.artifact'), version: text(record.version, 'target.version') };
}

function severity(value: unknown): ReviewFinding['severity'] {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !/^P[0-3]$/.test(value)) throw new Error('Review finding severity must be P0, P1, P2, or P3');
  return value as ReviewFinding['severity'];
}

export function parseReviewFinding(value: unknown, index = 0): ReviewFinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Review finding ${index} must be an object`);
  const record = value as Record<string, unknown>;
  const verdict = record.verdict;
  if (verdict !== 'pass' && verdict !== 'concern' && verdict !== 'fail' && verdict !== 'blocked') throw new Error(`Review finding ${index}.verdict is invalid`);
  return {
    id: record.id === undefined ? undefined : text(record.id, `finding ${index}.id`),
    reviewer: text(record.reviewer, `finding ${index}.reviewer`),
    dimension: text(record.dimension, `finding ${index}.dimension`),
    verdict,
    summary: text(record.summary, `finding ${index}.summary`),
    severity: severity(record.severity),
    location: record.location === undefined ? undefined : text(record.location, `finding ${index}.location`),
    recommendation: record.recommendation === undefined ? undefined : text(record.recommendation, `finding ${index}.recommendation`),
    evidence: record.evidence === undefined ? undefined : text(record.evidence, `finding ${index}.evidence`),
  };
}

export function parseSpecialistReview(value: unknown): SpecialistReview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Specialist review must be an object');
  const record = value as Record<string, unknown>;
  const verdict = record.verdict;
  if (verdict !== 'pass' && verdict !== 'concern' && verdict !== 'fail' && verdict !== 'blocked') throw new Error('Specialist review verdict is invalid');
  if (!Array.isArray(record.findings)) throw new Error('Specialist review findings must be an array');
  const parsedTarget = target(record.target);
  const findings = record.findings.map((item, index) => parseReviewFinding(item, index));
  for (const finding of findings) {
    if (finding.reviewer !== text(record.reviewer, 'reviewer') || finding.dimension !== text(record.dimension, 'dimension')) {
      throw new Error('Specialist review findings must preserve reviewer and dimension attribution');
    }
  }
  return { reviewer: text(record.reviewer, 'reviewer'), dimension: text(record.dimension, 'dimension'), target: parsedTarget, verdict, findings };
}

function candidateFromAgent(agent: ResolvedAgent): ReviewCandidate {
  return { agent: agent.name, dimensions: [...agent.capabilities], description: agent.description };
}

/** Selects roles from the resolved visible catalog; it never selects workers or models. */
export function selectReviewPanel(candidates: readonly (ReviewCandidate | ResolvedAgent)[], dimensions: readonly ReviewDimension[], max = 5): ReviewPanelMember[] {
  if (!Number.isInteger(max) || max < 1) throw new Error('Review panel max must be a positive integer');
  const normalized = candidates.map(candidate => 'name' in candidate ? candidateFromAgent(candidate) : candidate);
  const selected: ReviewPanelMember[] = [];
  const usedAgents = new Set<string>();
  for (const dimension of [...dimensions].map((item, index) => ({ item, index })).sort((a, b) => (a.item.priority ?? 99) - (b.item.priority ?? 99) || a.index - b.index).map(item => item.item)) {
    const match = normalized
      .filter(candidate => !usedAgents.has(candidate.agent))
      .map(candidate => ({ candidate, score: candidate.dimensions.some(item => item.toLowerCase() === dimension.name.toLowerCase()) ? 0 : 1 }))
      .sort((a, b) => a.score - b.score)[0];
    if (!match || match.score > 0) continue;
    selected.push({ agent: match.candidate.agent, dimension: dimension.name, reason: `Visible agent capability matches the ${dimension.name} review dimension${match.candidate.description ? `: ${match.candidate.description}` : ''}.` });
    usedAgents.add(match.candidate.agent);
    if (selected.length >= max) break;
  }
  return selected;
}

export function specialistReviewTaskMetadata(targetValue: ReviewTarget, member: ReviewPanelMember, round = 1): ReviewTaskMetadata {
  return { role: 'specialist', target: { ...targetValue }, dimension: member.dimension, selectionReason: member.reason, round };
}

export function createSpecialistReviewTasks(tasks: readonly Task[], targetValue: ReviewTarget, panel: readonly ReviewPanelMember[], round = 1): ReviewTaskMetadata[] {
  const existing = new Set(tasks.filter(task => task.review?.role === 'specialist').map(task => `${task.review?.target.artifact}@${task.review?.target.version}:${task.review?.dimension}:${task.agentName ?? ''}`));
  return panel
    .filter(member => !existing.has(`${targetValue.artifact}@${targetValue.version}:${member.dimension}:${member.agent}`))
    .map(member => specialistReviewTaskMetadata(targetValue, member, round));
}

/** Builds the durable-task inputs used by the live Review Chair worker path. */
export function createReviewChairExecutionPlan(agents: readonly ResolvedAgent[], targetValue: ReviewTarget, max = 5): ReviewChairExecutionPlan {
  const dimensions = [...new Set(agents.flatMap(agent => agent.capabilities))]
    .map(name => ({ name }))
    .filter(dimension => dimension.name !== 'model');
  const panel = selectReviewPanel(agents, dimensions, max);
  return { target: { ...targetValue }, panel, specialistTasks: createSpecialistReviewTasks([], targetValue, panel) };
}

function findingKey(finding: ReviewFinding): string { return `${finding.location ?? ''}|${finding.summary.toLowerCase().replace(/\s+/g, ' ').trim()}`; }
function priority(finding: ReviewFinding): 'P0' | 'P1' | 'P2' | 'P3' { return finding.severity ?? (finding.verdict === 'blocked' ? 'P0' : finding.verdict === 'fail' ? 'P1' : 'P2'); }

/** Deterministically merges independent specialist output into one executor-facing plan. */
export function synthesizeReview(targetValue: ReviewTarget, panel: readonly ReviewPanelMember[], reviews: readonly SpecialistReview[]): ReviewSynthesis {
  const mismatched = reviews.find(review => review.target.artifact !== targetValue.artifact || review.target.version !== targetValue.version);
  if (mismatched) throw new Error(`Specialist review ${mismatched.reviewer} targets ${mismatched.target.artifact}@${mismatched.target.version}, expected ${targetValue.artifact}@${targetValue.version}`);
  const byKey = new Map<string, ReviewFinding[]>();
  for (const review of reviews) for (const finding of review.findings) {
    const key = findingKey(finding);
    const group = byKey.get(key) ?? [];
    group.push(finding);
    byKey.set(key, group);
  }
  const usedIds = new Set<string>();
  const mergedGroups = [...byKey.values()].map((group, index) => {
    const preferredId = group[0].id ?? `finding-${index + 1}`;
    let id = preferredId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${preferredId}-${suffix++}`;
    usedIds.add(id);
    return { group, id };
  });
  const findings = mergedGroups.map(({ group, id }) => ({
    ...group[0],
    id,
    attributions: group.map(item => ({ reviewer: item.reviewer, dimension: item.dimension, ...(item.id ? { findingId: item.id } : {}) })),
  }));
  const conflicts = mergedGroups.filter(({ group }) => new Set(group.map(item => item.verdict)).size > 1).map(({ group, id }) => ({ findingIds: [id], resolution: `Prioritize the more severe disposition and preserve all specialist attribution: ${group.map(item => `${item.reviewer}=${item.verdict}`).join(', ')}.` }));
  const actions = findings.filter(finding => finding.verdict !== 'pass').map(finding => ({ priority: priority(finding), action: finding.recommendation ?? `Address: ${finding.summary}`, findingIds: [finding.id ?? findingKey(finding)], rationale: finding.evidence ?? `Raised by ${finding.reviewer} for ${finding.dimension}.` })).sort((a, b) => a.priority.localeCompare(b.priority) || a.action.localeCompare(b.action));
  const covered = new Set(reviews.map(review => review.dimension));
  const missingDimensions = panel.map(member => member.dimension).filter(dimension => !covered.has(dimension));
  const unresolved = findings.filter(finding => finding.verdict === 'blocked');
  return { target: { ...targetValue }, panel: panel.map(member => ({ ...member })), findings, conflicts, actions, unresolved, needsAdditionalSpecialist: missingDimensions.length > 0, missingDimensions };
}

function findingsIndex(group: readonly ReviewFinding[]): string { return group.map(item => item.reviewer).sort().join('-').toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'unknown'; }
