# Neo Master npm-latest Relay live release gate (2026-11-16/17)

## Gate-cleared update — 2026-11-16 23:17 EST

**Publish gate is GREEN on audited local `main` candidate.** Full `npm run test:publish` passed **1,214/1,214**, 0 failed or skipped. Independent `test:verification:l1` passed 58/58; L2 passed 11 with 1 intentional skip; L3 passed 90 with 1 intentional skip. `npm pack --dry-run --json` includes CLI, daemon and Relay Skill. Evidence logs on Neo Master: `/tmp/relay-publish-gate-full-third-20261116.log`, `/tmp/relay-publish-gate-l1-20261116.log`, `...-l2-...`, `...-l3-...`.

Cleanup removed retired Workspace recursive/GitHub PR-discovery test file and obsolete PR-only assertions, **not** the current Git/SQLite/review/retry gates. Modern tests now require standalone canonical Git roots and numeric Job/Task IDs. Replaced obsolete PR worktree cleanup cases with local Job dirty/unique-commit/active-lease protections. Fixed repository-scoped Task idempotency allocation and made Troubleshooter compare the same repository namespace; added strict blocker `projectPath` rejection; preserved historical SQLite compatibility fixtures; extracted `relay-job-merge.ts` without semantic changes; prevented the L3 Review test from overlapping its own SQLite writes with external helper transitions.

**Deployment status remains separate from green source tests.** GitHub Actions OIDC publish and npm `latest` must be confirmed, then PM2 must be re-registered from the published package and Neo Project Run switched to the npx launcher. This update supersedes the historical 54-failure count below; it records the pre-fix baseline, not current failures.

## Intended deployment

- Production Relay daemon is `npx --yes --package agents-relay@latest agents-relayd`; CLI is `npx --yes --package agents-relay@latest agents-relay`.
- Keep a version-matched published package, not a `dist/` build from the developer's dirty `rust2` checkout.
- `neo/package-service-updater` is running, but its NATS `package.published` event flow must be validated separately: Relay's new no-GitHub daemon sets its webhook handler to `undefined`. An npm release alone does not prove event delivery to the watcher.
- CLI and daemon currently registered in PM2 still point to the source worktree and old arguments. No PM2 re-registration or production restart was performed.

## Current blockers

- npm registry `agents-relay@latest` was `2.0.263` (gitHead `e448afdf...`) on the audit date; `npx --package agents-relay@2.0.263 agents-relay --help` still shows `--no-github` / `job merge`. New local Git-only code is therefore **not** published/live.
- Neo Master npm login reports `ENEEDAUTH`; approved publish path is GitHub Actions `.github/workflows/publish.yml` on a `main` push, using OIDC after `npm run test:publish`.
- Local primary-checkout `npm run test:publish` at pre-skill release source commit `eeeaec3`: **1,185 passed / 54 failed / 1,239 total**. Failed tests include historical owner/repo/PR/Workspace assumptions, TestRuntime fixture issues, and production file-size checks. The prior GitHub workflow for `origin/main` failed before publishing; never bypass mandatory tests to force a package.
- `npm run test:verification:l1`: 58 passed. L2: 11 passed/1 skipped. L3: 90 passed/1 skipped. These gates were independently verified on the immediately preceding local `main` source. They do **not** supersede the `test:publish` gate.
- New published-CLI/Skill change tested with `test/agents-relay-skill-evals.test.js`, `test/local-git-only-cli.test.js`, `test/service-config-drift.test.js`: **10/10 passed**. Default `@latest` and exact `@${RELAY_VERSION}` pinned-execution instructions are included in the Skill.

## Recovery / safe next actions

1. Update obsolete full-publish test fixtures to require standalone canonical Git roots, numeric Job/Task IDs, and local Git-only lifecycle semantics; retain equivalent positive and negative assertions. Do not remove/bypass entire failing test classes.
2. Run full `npm run test:publish` successfully from a primary Git checkout and rerun L1–L3; then push local `main` fast-forward to origin to trigger GitHub Actions. Confirm a **new** npm `dist-tags.latest` with the audited source SHA.
3. Re-register only the affected PM2 `agents-relay/daemon` from published npm, verify no Workspace/GitHub arguments, HTTP/SQLite read and Job/Task lifecycle; use package-backed CLI and daemon and verify both versions.
4. Prove the `package.published` watcher receives valid post-release events (or implement grounded npm latest polling); recheck rollback readiness and PM2 persistence. Keep unrelated Rust and Neo changes untouched.
