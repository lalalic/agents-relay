# Neo Master npm-latest Relay live release gate (2026-11-16/17)

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
