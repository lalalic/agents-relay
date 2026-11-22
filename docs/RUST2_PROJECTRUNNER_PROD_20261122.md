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

## New live repeatability probe: Job713

A NEW actual neo project run on 2026-11-22 produced Job713, Coordinator 2218, Builder 2219, from a fresh no-index private Run (created 2026-11-22-discovery-7f86613b). Builder authored and tested a calculator but incorrectly wrote index.html and qa/verification.md into parent Project Git rather than canonical Run Git. Git commit under parent .git was sandbox-denied; authentic task.failed events were durably ingested and native Troubleshooter Task 2220 created. An independent QA comment about the wrong Git root was appended to the original Builder Task. The genuine Troubleshooter repaired the Run root, browser-verified and committed Run-local SHA 183f15c, then requested a retry of original Builder Task2219. This is failure-recovery evidence, NOT clean-repeatability PASS. Job713 must not be reported COMPLETED unless final independent QA, Reviewer and Job are actually terminal.

## Source repairs

Neo ProjectRunner source, on main and pushed:
- 20ed95c: domain-specific discovery prompts, preserving video-domain behavior; no more generic viral-video sourcing in Calculator input
- 4944f89: explicit private Run Git artifact boundary in newly generated immutable Coordinator/Agent input; requires source/QA files and Git HEAD in the Run, not the parent Project

ProjectRunner behavioral test suite: 37 PASS / 0 FAIL (existing unrelated CLI packaging staging test excluded). Unfiltered suite still has one pre-existing package staging FAIL because skills/iphone-helm is a Git symlink rejected by scripts/stage-neo-cli.mjs; this test must not be misrepresented as passed or modified to hide its failure.

## Checklist and residual gate

Four functional D-MVPs PASS with real production evidence. DPR1-DPR6 have substantive live proof under the explicit production-environment override; DPR7 remains open for the complete native outbox/lease and repeatability sign-off; DPR8 remains open until active Job713 is settled and test-owned wrong-root artifacts are cleaned without touching unrelated Jobs. Do not mark the entire D-ProjectRunner Gate PASS while the new live regression is unresolved. Gate D full requirements and other gates remain independent.
