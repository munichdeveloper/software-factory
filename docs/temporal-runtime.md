# Temporal execution runtime – migration in progress

The existing Factory planner, permission policy, immutable delegation intents and Harness contracts remain the authority. `execution.engine: temporal` replaces worker dispatch and observation with the durable runtime; it never falls back to GitHub Actions if unavailable. Omitted `engine` retains the existing installation behavior. This is preview `0.7.0-temporal.0`, not a released or deployed replacement for v0.6.0.

The private broker owns repository-scoped GitHub credentials and PostgreSQL receipts. A separate PINNED worker owns a verified workflow bundle and pinned Harness entrypoint. Worker subprocesses receive no GitHub, planning or broker credentials. The first executor supports the real deterministic Harness contract; coding tasks are explicitly rejected until the isolated coding executor and PR publication path are integrated. Do not interpret a hash-worker result as a completed coding migration.

## Boundaries

- Admission freezes numeric repository identity, Factory/Harness commits, workflow hash, deployment/build/queue, specification/input, base commit, configuration and policy. The broker verifies the trusted Factory intent before starting the workflow.
- Workflow IDs derive from repository ID and execution ID. PostgreSQL advisory locks serialize claims; a lost Temporal start response is reconciled against the actual history input binding before accepting its run ID.
- Human gates persist in the broker. Signals only wake the workflow; they do not carry permission. The Manager session supplies the actor server-side, CSRF checks protect mutations, and the broker checks the actor's live repository permission and exact binding. Revocation, changed policy/specification/base and unsupported releases block execution/publication.
- Completed result receipts can be reused without new writes after a later task change. A publication with an ambiguous response is reconciled against trusted GitHub journal evidence. Missing evidence never authorizes a blind retry. The initial result-journal outbox does not yet replace the complete Branch/Commit/PR publisher from WF-06A.
- Existing PINNED runs accept only their original release or an explicitly retained release. Startup refuses a registry which would orphan an open recorded run. Human wait does not consume the ordinary worker timeout. No automatic migration of running workflows is implemented.

## Running an isolated development instance

Build with Node 22.12+ or Node 24 and `npm ci && npm run build`. Build the pinned Harness from `runtime.json` in `.runtime/harness`.

`npm run runtime:pack -- --factory-sha COMMIT --harness-sha COMMIT --harness ABSOLUTE_HARNESS_CLI --deployment NAME --build BUILD --queue QUEUE` writes a verified workflow bundle and worker package. Pack only a clean immutable source snapshot. Keep every package referenced by an open workflow.

The broker `npm run runtime:serve -- --file REGISTRY.json` reads `TEMPORAL_ADDRESS`, `FACTORY_RUNTIME_DATABASE_URL`, `FACTORY_MANAGER_TOKEN` and `FACTORY_WORKER_TOKEN`. Manager/worker tokens must be distinct and at least 32 characters. It binds loopback port 8095 by default. Use protected transport when exposing it beyond loopback; do not publish Temporal/PostgreSQL or grant workers Docker access.

Registry format: `{ "namespace": "software-factory-poc", "repositories": [{ "repositoryId": 123, "repository": "owner/repo", "githubTokenEnv": "SF_GH_TEST_REPO", "release": { "factorySha": "40hex", "harnessSha": "40hex", "workflowHash": "64hex", "deploymentName": "factory-runtime", "buildId": "BUILD", "taskQueue": "factory-runtime", "schemaVersion": 1 }, "retainedReleases": [], "requireHumanGate": true }] }`. The broker verifies the live numeric repository ID before serving. Tokens belong in private environment configuration, never the registry or workflow input.

For an existing GitHub App, replace `githubTokenEnv` with `githubInstallationId`. The broker reads `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_ALLOWED_INSTALLATION_IDS` privately. Every installation token explicitly requests **one numeric repository ID** and Contents/Issues/Pull requests/Actions write; missing permission fails closed. Installation-wide fallback is forbidden. The App key and installation tokens stay in the broker. `tests/runtime-github-app.test.ts` exercises real authentication hooks, token caching, separate repository scopes and authorization failure with a disposable RSA key and simulated GitHub responses.

Linux regression verification on 2026-11-09: all 324 tests passed, line coverage 88.88%, with the existing thresholds unchanged. The disposable test image includes Git because deployment tests create local repositories. Windows alone cannot verify the existing POSIX deployment scripts.

Run `npm run runtime:worker -- --file ABSOLUTE_WORKER_PACKAGE` in a separate environment with only `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `FACTORY_BROKER_URL` and the worker-role token. The worker verifies bundle and Harness entrypoint hashes and refuses GitHub/planning credentials or `NODE_OPTIONS`.

The Manager optionally reads `FACTORY_RUNTIME_URL` and `FACTORY_RUNTIME_TOKEN` on its server. Its repository Runs tab displays Factory tasks and approval/cancellation actions. Session, installation and repository checks remain in force; browsers cannot supply the actor identity or runtime token.

## Verification and outstanding work

`npm run test:runtime` creates a fresh disposable local PostgreSQL/Temporal cluster with pinned images, an internal network, no published ports, and a version-bound acceptance runner. It requires Docker, Python 3 and a clean committed source tree. It exercises the regular Factory Manager → private broker → actual Temporal worker → real Harness → durable result journal path for two simulated repository adapters. It kills/restarts the worker during a gate, checks server PINNED behavior, invalid approvals and a lost publication response. Only labeled test resources are removed. No actual GitHub PR is published by that test.

Remaining acceptance: two actual installed Factory releases with distinct workflow packages, real repository-scoped GitHub integration and coding/PR publication, operator deployment wiring, authenticated Manager browser end-to-end proof and the complete WF-05A/WF-06A negative/live matrix. Existing productive installations and the paused backup/monitoring job are not changed by this branch. No automatic merge or deployment is authorized by the migration.
