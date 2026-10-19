# Dashboard Workflow Browser (design view)

Open Dashboard **Workflow** or use `#/graphs/entry`. The Entry Mermaid diagram is a presentation-only overview, **not** an executable workflow. Actual transitions remain in `workflow/*.mmd`, loaded read-only from `/api/graphs`; no lifecycle decision is made by the Dashboard.

The Entry path is Job Objective → Planner → Worker → Reviewer → Merge/Delivery → Objective Achieved → Job Completed. Review `Changes Required → Fix Task` is a normal iteration. Failure/recovery paths are red and may involve the Troubleshooter and Escalator **workflow** (not an agent). The diagram is conceptual; it must not be treated as a complete transition specification.

Click an Entry node to see a canonical subgraph. Select Event, Guard, Action, or State nodes and event buttons to inspect read-only references to the canonical graph, contracts, implementation, and tests. References are derived from the checked-in files; missing matches are shown as absent, not invented. Alternatively use the graph list and the exposed target links. `#/graphs/<graph-id>` is a shareable link. Back/Forward and Entry buttons navigate design views. The SVG renderer uses Mermaid strict mode and a restrictive markup filter. When the CDN renderer is unavailable, Mermaid source remains visible.

Canonical reference contracts: `skills/agents-relay/contracts/event-contract.md` and `skills/agents-relay/contracts/task-recovery-flows.md`. Those references must be reconciled against executable workflow files during a separate policy audit; the UI does not correct policy conflicts. Execution view and exhaustive contract/graph policy-conflict reconciliation are not delivered. A standalone Browser Workspace E2E script lives at `test/workflow-dashboard-browser-e2e.py`; its isolated test-server results on 2026-10-19 were 32/32. Evidence screenshots and JSON were saved on the Mac at `/tmp/agents-relay-workflow-browser/`. This was not a live Dashboard deployment. No production SQLite Job data is modified by this feature.

Validation: `npm run build` then `node --import ./test/test-store-env.mjs --test test/dashboard.test.js`.

Security scope: rendered Mermaid SVG is recreated using an explicit SVG element/attribute whitelist. Inline event handlers, styles, foreignObject, use, external URLs and malformed SVG are not imported. The browser E2E sends six adversarial SVG payloads; this is a bounded regression suite, not proof of comprehensive XSS immunity.
