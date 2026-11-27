# Code Intelligence behavioral evals

Goal: find sufficient verified source evidence with minimal discovery overhead.
`cases.json` covers tool selection, role boundaries, stale/cross-worktree indexes,
missing tools, incomplete results, benchmark honesty, technical-plan readiness,
map reuse, proportionate planning, bounded diff re-review, structural searches, and independent review beyond the map. Each scenario is a dry
run: load the Skill plus the specified Agent, ask for a JSON object with the
listed expectation keys, compare values deterministically, and do not execute
real Job actions. Separately benchmark real source work with matched objective,
model, reasoning, target revision and acceptance results. Record index costs,
source-read bytes, tool calls, input/output tokens and elapsed time. These cases
are specifications, not passing model eval results.
