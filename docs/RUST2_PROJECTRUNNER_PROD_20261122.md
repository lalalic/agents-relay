# ProjectRunner production acceptance — 2026-11-22

## Runtime and scope

All acceptance here runs on the REAL production native Rust Relay on Neo Master, port 8787, under the existing sole agents-relay/daemon PM2 owner. No additional Node or isolated Relay daemon/store. Only already allowlisted test-only independent Neo Project Git repositories and their private per-Run nested Git roots are used. Ordinary user Jobs are not touched.

The old full E2E Checklist statuses, written before the Rust Model Provider was working, are superseded by the verified 2026-11-22 readback below.

## Four D-MVP scenarios — 4/4 REAL COMPLETED

| Scenario | Real ProjectRunner Job | Task lineage | Independent Final Review |
| --- | --- | --- | --- |
| D-MVP-1, clean Calculator | 685 COMPLETED, zero failed Tasks | Coordinator 2099; real Codex Builder 2101; independent real Codex QA 2105 | Task 2107 SUCCEEDED; verdict approved, immutable project SHA 271b469; reviewer explicitly examined Calculator Run Git artifact SHA 5a8054e |
| D-MVP-2, Calculator failure and recovery | 683 COMPLETED | Builder 2080 had an authentic rate-limit failed event; durable Troubleshooter 2084 SUCCEEDED; Builder retry and QA succeeded | Task 2090 SUCCEEDED; approved project SHA 4b64b82 |
| D-MVP-3, three source-owned Shortcut DAG nodes | 693 COMPLETED | Coordinator 2139; Script A/B/C Tasks 2140/2141/2142 all SUCCEEDED | Task 2143 SUCCEEDED; approved SHA f91af3f |
| D-MVP-4, three genuine Codex Model DAG nodes | 692 COMPLETED | Coordinator 2134; Model A/B/C Tasks 2135/2136/2137 all SUCCEEDED | Task 2138 SUCCEEDED; approved SHA ea782a3 |

For EACH Job the saved canonical private Run binding (.neo-project-run.json) identifies the same original Job ID; actual CLI Job readback has all required Tasks SUCCEEDED and Job COMPLETED. Review terminal events are exact-job/task/execution correlated and include verdict approved with SHA. No synthetic terminal event or fake Reviewer was used.

Original calculator seed ae2f833 had no index.html. ProjectRunner fixture bootstrap commit 611df72 matches the exact bytes of its AGENTS.md, README.md and job-objective.md while registering named DAGs and Agents for Neo. Each Run initializes a fresh private nested Git repository without a pre-existing calculator. Successful Job685 Builder committed the new index.html to Run Git HEAD 5a8054ee5eb364c21f5657987e8367287a2e78df. QA verified true file:// Google Chrome interactions, offline source and 320/mobile plus desktop. Final Reviewer explicitly cites both the immutable parent project SHA and that Run Git HEAD. It reached COMPLETED in 1443 seconds with no failed Task; all execution and lease fields cleared and local merge succeeded. Original html-calculator-rust-relay Git root was unchanged.

## Extra real browser checks on completed Job685

On 2026-11-22, a fresh owned WebHelm Session in managed Google Chrome opened Job685's exact private Run index.html. Actual Chrome viewport measurements: 320/320, 375/375, 430/430, and 1280/1280 CSS px document width; 19 buttons and a semantic OUTPUT; no horizontal overflow. At 375px actual pointer presses 7,+,2 then keyboard Enter displayed 9. At 430px pointer input 0.1+0.2 displayed 0.3. PNG screenshots were saved for 375 and 430. The Session was stopped in shell cleanup. Previous independent browser QA recorded 9÷3, 8×7, division by zero, clear, Backspace, negative/chained arithmetic, keyboard and focus.

Raw evidence: mvp/runs/20261122T1021-projectrunner-production/, containing Job snapshots, exact Reviewer and Worker event histories, real Run bindings, Chrome command output, and PNGs.

## Fresh live Calculator repeatability and recovery — Job713 COMPLETED

A real new neo project run on 2026-11-22 created Calculator Job713 from a no-index private Run. Coordinator2218, real Codex Builder2219, Troubleshooter2220, independent real Codex QA2221 and Final Reviewer2222 all SUCCEEDED; Job713 truly reached COMPLETED / COMPLETED, independent Review approved.

- Initial Builder wrote index.html and QA artifacts into reusable Project Git rather than canonical private Run. A real sandbox Git delivery failure triggered Troubleshooter2220, which moved the work to Run Git and committed 183f15c. The original Builder2219 retried on the SAME Task and fixed a genuine post-Equals new-digit-reset bug, committing Run Git bfc7d732edbb9e23431f223637a319743f3bdd2b. Managed Chrome independently verified the restored Calculator at 320/375/430/1280px, including decimal precision, multiplication, division, Backspace, keyboard Enter, fresh input after Equals, offline resources and visible focus. Independent QA2221 completed two rounds; Reviewer2222 approved the project SHA271b469 and Run Git SHA bfc7d73.
- Wrong-root, test-only untracked files were archived as evidence after successful recovery; original Calculator Git remained untouched. No direct SQLite mutation, fabricated reviewer verdict or Task terminal.
- Native Rust pre-patch bug was exposed: the COMPLETED Job713 Final Reviewer2222 retained historical executionId and leaseOwner metadata. That old record is intentionally NOT represented as automatically repaired or manually edited. Rust source fix ab0a5a8 clears executionId, leaseOwner and leaseExpiresAt on a genuine terminal Reviewer verdict, while preserving exact original generation for fencing. New and existing Reviewer lifecycle tests: 9/9 PASS. Only Rust PM2 owner was restarted after a WAL-consistent production SQLite backup at ~/.agents-relay/backups/rust2-20261122-pre-reviewer-lease.sqlite. API returned HTTP 200 and SQLite integrity check ok after restart.

Job713 is a genuine functional recovery PASS, not a zero-retry clean PASS.

## Declarative video-domain fix and clean live Reviewer canary — Job715 COMPLETED

The non-Vlog Shortcut test project actually requires authentic public trending-video discovery. The original project-name heuristic withheld the required research directive, and genuine production Job714 Script A FAILED. Only test-owned Job714 was cancelled after durable failure evidence; it is never counted as passed.

Neo source fix b0c58ee adds named DAG domain video|general as explicit configuration, preserving video behavior and project-specific Calculator prompts, with 38/38 scoped tests PASS. The test-only Shortcut repository declares domain video at local Git commit a5a45a5. Existing unrelated CLI packaging staging has one pre-existing failure on a rejected iphone-helm symlink; it is NOT claimed to have passed.

A NEW authentic neo project run, production Job715, then validated both the video declaration and Rust Reviewer lease fix:
- Coordinator2226 and source-owned Script A/B/C Tasks2227/2228/2229 each SUCCEEDED with exact execution-correlated Events Bus evidence. A genuinely fetched eight public reference-video records, B/C produced Run-bounded analysis/evidence. noMediaDownloaded=true, rightsDecision=NOT_ASSESSED, publicationAuthorized=false. No media publication.
- Independent real Codex Final Reviewer2230 issued approved through authentic correlated task.completed. Job715 COMPLETED / COMPLETED in 320 seconds, all five Tasks SUCCEEDED and ALL terminal executionId, leaseOwner and leaseExpiresAt fields NULL, including Reviewer2230 — direct proof that newly deployed Rust ab0a5a8 fixes the ghost lease on actual live production review.
- Parent Project immutable HEAD a5a45a5ea8abdc05ec868a203527050a856479ef and Run HEAD 6ccb6921852f56f08074bc84d7c7cd85da9fa52c were checked. SQLite PRAGMA quick_check=ok; workflow EventBus outbox 313 published, no nonpublished Job715 projection operations. No lingering test Codex OS process, sole production native Rust PM2 owner online.

Machine-checked evidence: mvp/runs/20261122T1021-projectrunner-production/job-713-final-audit.json, job-715-final-audit.json, exact Job snapshots, authentic per-Task events, private ProjectRunner bindings, original wrong-root artifact archive, real Chrome screenshot/QA evidence and SHA256 hashes.

## Source repairs

Neo ProjectRunner source, on main and pushed:
- 20ed95c: domain-specific discovery prompts, preserving video-domain behavior; no more generic viral-video sourcing in Calculator input
- 4944f89: explicit private Run Git artifact boundary in newly generated immutable Coordinator/Agent input; requires source/QA files and Git HEAD in the Run, not the parent Project
- b0c58ee: explicit video/general discovery domain for non-Vlog named DAGs
- Rust ab0a5a8: release exact terminal Reviewer lease on genuine Graph verdict, validated by fresh production Job715

ProjectRunner behavioral test suite: 38 PASS / 0 FAIL (existing unrelated CLI packaging staging test excluded). Unfiltered suite still has one pre-existing package staging FAIL because skills/iphone-helm is a Git symlink rejected by scripts/stage-neo-cli.mjs; this test must not be misrepresented as passed or modified to hide its failure.

## Additional authentic ProjectRunner restart acceptance — Job717

On 2026-11-22, a fresh three-node source-owned ProjectRunner run deliberately interrupted Script Task2236 while genuinely RUNNING under native Rust PID66439, following exact preflight/WAL backup and no other current-owner Workers. The old Script PID77411 ended with a genuine failed event. Native Rust PID77509 recovered through independent real Codex Troubleshooter2237, retrying the immutable original Task2236 as a second execution PID85456. Both distinct process generations are durably recorded and ended. Script B2238 and C2239 SUCCEEDED with exact Run-local SHA-linked proofs. C enforced two distinct process-start markers, Coordinator2235 SUCCEEDED, and independent real Final Reviewer2240 approved. Job717 COMPLETED with all 6 Task leases null, without fake terminal or manual SQLite state edits.

Production Outbox FIFO temporarily exposed a cross-Task visibility bug: 15 pending legitimate Planner/Script/Model events starved behind a Planner started row. Rust fix 84a7d18 validated canonical Planner outbox keys, 112/112 Rust library tests serial PASS and 24/24 native SQLite/NATS PASS. WAL-backed single-Rust-owner restart replayed all 15 exact immutable event IDs; all 335 unique outbox rows published and Job717 JSON SHA unchanged. Real task events now reports old Script failed generation and recovered Script completed generation; Model/Reviewer history may show duplicate OBSERVATIONS sharing the same event ID, not duplicate Graph terminals. This adds scoped actual RUNNING-restart ProjectRunner proof; QUEUED/review-wait and three-node fencing remain independent unverified Gate E2 requirements.

Detailed evidence: docs/RUST2_GATE_E1_E2_PRODUCTION_20261122.md and the production audit files in mvp/runs/20261122T1323-gate-e2-running-owner-restart/.

## Scoped ProjectRunner sign-off and remaining global gates

D-ProjectRunner DPR1–DPR8: **8/8 PASS for the user-selected live production Rust Relay environment**. Original four true COMPLETED MVPs, new recovered Calculator Job713 COMPLETED, fresh Reviewer/lease-clean Job715 COMPLETED, original Calculator untouched, browser Sessions closed, no test Codex processes, test-owned failed Job714 cancelled, real artifacts/event history/Git evidence retained. This explicitly replaces the older requirement for a separate isolated Relay daemon/store at the user's request.

**Historical debt:** the already-COMPLETED pre-fix Job713 Reviewer2222 still retains old stale terminal lease metadata; no process is running and the record was not directly modified. Fresh Job715 proves all lease fields clean on the updated native Rust path. Historical cleanup must use a separately reviewed safe migration, not an unsafe manual SQLite edit.

Global Gates D/E/F/G, rollback/three-node fencing, full non-ProjectRunner tests and productionReady=true signoff remain separate. One preexisting unfiltered Neo packaging test fails due to an iphone-helm symlink; the scoped 38 ProjectRunner behavior tests pass.
