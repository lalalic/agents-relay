/** Conceptual dashboard-only overview; workflow/*.mmd remains the transition authority. */
export const workflowPresentation = {
  entrySource: [
'flowchart LR',
'objective["START: Job Objective"] --> planner["Planner"] --> worker["Worker"] --> reviewer["Reviewer"] --> merge["Merge / Delivery"] --> achieved["Objective Achieved"] --> completed["Job Completed"]',
'reviewer -->|Changes Required| fix["Fix Task"] --> worker',
'planner -->|Failed| troubleshooter["Troubleshooter"]',
'worker -->|Failed| troubleshooter',
'reviewer -->|Failed| troubleshooter',
'merge -->|Failed| troubleshooter',
'troubleshooter --> resolution["Resolution"]',
'resolution -->|Recovered| planner',
'resolution -->|Recovered| worker',
'resolution -->|Recovered| reviewer',
'resolution -->|Recovered| merge',
'resolution -->|Needs human action| escalator["Escalator workflow"] -->|Resolved| resolution',
'classDef failure fill:#ffe4e4,stroke:#be3030,color:#7c1818',
'class troubleshooter,resolution,escalator failure',
'linkStyle 8,9,10,11,12,13,14,15,16,17,18 stroke:#be3030,stroke-width:2px'
].join('\n'),
  navigation: {objective:['job-lifecycle'],planner:['planner-orchestration','planner-trigger'],worker:['task-lifecycle'],reviewer:['review-lifecycle'],merge:['job-lifecycle'],achieved:['job-lifecycle'],completed:['job-lifecycle'],fix:['review-lifecycle','task-lifecycle'],troubleshooter:['troubleshooter','task-resolution'],resolution:['blocker-resolution','task-resolution','authoritative-unblock'],escalator:['escalation']}
} as const;
