# Dashboard Workflow Browser (design view)

Open Dashboard **Workflow** or use `#/graphs/entry`. The Entry Mermaid diagram is a presentation-only overview, **not** an executable workflow. Actual transitions remain in `workflow/*.mmd`, loaded read-only from `/api/graphs`; no lifecycle decision is made by the Dashboard.

The Entry path is Job Objective → Planner → Worker → Reviewer → Merge/Delivery → Objective Achieved → Job Completed. Review `Changes Required → Fix Task` is a normal iteration. Failure/recovery paths are red and may involve the Troubleshooter and Escalator **workflow** (not an agent). The diagram is conceptual; it must not be treated as a complete transition specification.

Click an Entry node to see a canonical subgraph. Select Event, Guard, Action, or State nodes and event buttons to inspect read-only references to the canonical graph, contracts, implementation, and tests. References are derived from the checked-in files; missing matches are shown as absent, not invented. Alternatively use the graph list and the exposed target links. `#/graphs/<graph-id>` is a shareable link. Back/Forward and Entry buttons navigate design views. The SVG renderer uses Mermaid strict mode and a restrictive markup filter. When the CDN renderer is unavailable, Mermaid source remains visible.

Canonical reference contracts: `skills/agents-relay/contracts/event-contract.md` and `skills/agents-relay/contracts/task-recovery-flows.md`. Those references must be reconciled against executable workflow files during a separate policy audit; the UI does not correct policy conflicts. Execution view and exhaustive contract/graph policy-conflict reconciliation are not delivered. A standalone Browser Workspace E2E script lives at `test/workflow-dashboard-browser-e2e.py`; its isolated test-server results on 2026-10-19 were 32/32. Evidence screenshots and JSON were saved on the Mac at `/tmp/agents-relay-workflow-browser/`. This was not a live Dashboard deployment. No production SQLite Job data is modified by this feature.

Validation: `npm run build` then `node --import ./test/test-store-env.mjs --test test/dashboard.test.js`.

Security scope: rendered Mermaid SVG is recreated using an explicit SVG element/attribute whitelist. Inline event handlers, styles, foreignObject, use, external URLs and malformed SVG are not imported. The browser E2E sends six adversarial SVG payloads; this is a bounded regression suite, not proof of comprehensive XSS immunity.

## Review E2E evidence (2026-10-19)

- `docs/evidence/dashboard-workflow-review/evidence.json`: 32 browser checks, including direct graph URL, Back/Forward, keyboard activation, mobile viewport, renderer fallback, and adversarial SVG inputs. Run again using `test/workflow-dashboard-browser-e2e.py` with the isolated Dashboard bound to port 18983 (not the live service).
- Screenshots: `entry.png`, `planner.png`, `escalation.png`, `mobile.png` in the evidence directory. Entry has visible text labels, red failure/recovery paths, and a neutral Changes Required → Fix Task cycle.
- Symbol references are two classes: exact validated graph tokens and *text-search suggestions* for source, tests and contracts. Missing contract evidence remains empty rather than fabricating a line number. Links use the configured `AGENTS_RELAY_WORKFLOW_SOURCE_REF` (defaults to the review branch), not `main`. Confirm ref when running from a different branch.
- This is a read-only design view, not a deployment or acceptance approval. Event labels and symbols originate from authoritative `.mmd` files; workflow transition policy is not changed.

## Fourth review: immutable source refs and browser navigation

- GitHub source links now use the running checkout's **full Git HEAD SHA**, not a mutable branch name. `AGENTS_RELAY_WORKFLOW_SOURCE_REF` is accepted only when it is a 40-digit hexadecimal commit. Without a valid checkout SHA or override, source links are disabled, rather than linked to a guessed revision. Deployers must provide a matching immutable revision for packaged `dist` installations lacking Git metadata.
- Graph Back/Forward uses browser history with a session-scoped graph path array and `workflowIndex` in history state. Direct Entry or deep-link entry initializes index 0. Reentering from another tab resets graph-specific history; browser Back/Forward restores visited graphs without consulting unrelated browser history.
- Graph `.mmd` symbol tokens are checked exactly. Source/contract/test matches are explicitly labelled **text-search suggestions**, not verified call-site contracts or test coverage. Missing symbol references are reported as absent; do not interpret them as proof of mapping.
- Targeted Browser Workspace regression: `test/workflow-dashboard-history-e2e.py`. Evidence `docs/evidence/dashboard-workflow-fourth-review/evidence.json` contains 14 checks; `action-detail.png` shows evidence labels and links. Existing 32-check visual/E2E suite remains in `test/workflow-dashboard-browser-e2e.py`.
