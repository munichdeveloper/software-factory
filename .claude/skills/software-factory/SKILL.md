---
name: software-factory
description: "Work with Johannes' Software Factory (SF): write issues the Factory picks up, check and judge the state of runs and the job queue, and step in when runs hang, fail or wait. Use for any SF ticket, queue, run, merge or rollout question in the Factory or target repos."
---

# Software Factory: tickets, state, intervention

The Software Factory (SF) turns GitHub issues into merged pull requests. A broker on the runtime host reconciles every
registered repository, starts coding runs (Temporal), validates them independently, reviews and risk-rates the PR
with a model, merges and deploys.

Talk to Johannes in German. Skill text, issue text and commits may be English or German (match the repo).

## Map

| Repo | Role |
|---|---|
| `munichdeveloper/software-factory` | Factory itself: broker/runtime (`src/runtime`), planner (`src/manager`), merge (`src/merge`), config schema, docs (`docs/configuration.md`, `docs/operations.md`, `docs/merging.md`), host compose `operations/temporal-runtime/compose.production.yaml` (worker pin) |
| `munichdeveloper/dev-agent-harness` | Coding executor (Claude Code / Codex in an offline sandbox), `scripts/claude-run.sh` |
| `munichdeveloper/sf-manager` | SF Manager (https://sfm.srv2127002.hstgr.cloud): installs, rollouts, config changes, Vault; MCP connector "Software Factory Manager" |
| `munichdeveloper/software-factory-monitor` | Monitor (https://sf-monitor.srv2127002.hstgr.cloud): queue, pipeline, Kosten, Metriken, "Freigeben" button |
| Target repos | `letterflow`, `backofficer`, `business-os`, `controla`, `geschaeftsideen-web`, `dev-agent-harness-e2e-20261106` (E2E) |

Runtime and Manager run on the Hostinger VPS 2127002 (compose project `sfm`), not on the netcup VPS.

Per-repo config lives in `.github/software-factory.yml` of each target repo. Always read it (or SF Manager
`get_repository` → `configuration`) before acting; the values below were true on 2026-11-22 and drift.

| Repo | `autonomy.startGrant` | Notes |
|---|---|---|
| controla, backofficer | `none` (no grant needed) | rework on |
| letterflow, geschaeftsideen-web, business-os, E2E | `ready-label` (default) | letterflow: planner `jev`; letterflow CLAUDE.md wants a `BOS: <task-id>` line in every issue |

## Hard rules

- No manual changes on the VPS. Secrets/config only via deploys (GitHub env `production` + `deploy-env`).
- Factory versions reach repos ONLY through the SF Manager (`prepare_rollout` → `publish_change` → merge the PR). Never
  hand-edit wrappers/pins in target repos.
- Host pin bumps and rollouts ONLY when the queue is empty across ALL repos. A host pin is always followed immediately
  by the rollouts of all repos (otherwise every start is refused with `EXECUTOR_WRAPPER_RELEASE_MISMATCH`). One thread
  owns a host pin at a time.
- New Factory releases need an sf-manager `temporalReleases` entry (`src/lib/credential-requirements.ts` + fixtures)
  before `prepare_rollout` accepts them; the Manager imports releases hourly at :13.
- New optional config keys get NO default (the config hash is in every run snapshot; a default turns in-flight runs
  `STALE_SNAPSHOT`).
- Replacement/fix PRs a Claude thread opens for a Factory PR get label `sf:automerge` at creation; close the replaced
  Factory PR. The broker only manages its own PRs and `sf:automerge` PRs.
- GitHub MCP acts as `munichdeveloper`. Labels and `/harness approve` comments you post count as Johannes' own grant.
  Only set `harness:ready` / `harness:managed` or post `/harness approve` when he asked for that work to start/merge.
- If runs are refused because agent credit/limits are used up, do the requested work yourself in a Claude PR
  (`sf:automerge`).
- Report any token leak or unexpectedly expensive run right away.

## 1. Writing an issue the Factory picks up

### Required shape

The parser is `src/state/lifecycle.ts` + `src/state/reconstruct.ts`. A task is startable only if:

1. Label `harness:managed` is on the issue (the Factory ignores issues without it).
2. A heading `## Acceptance criteria` (also `Akzeptanzkriterien` / `Abnahmekriterien`, levels `#`–`###`) with at
   least one list item. Missing → blocked "Missing Acceptance criteria section". Max 20 items read.
3. Every issue on a `Depends on: #12, #13` line (own line, starts with `Depends on:`) is closed. Open ones block it.
4. The text asks for nothing protected (see below).
5. Grant per `autonomy.startGrant`:
   - `ready-label`: `harness:ready` applied by a person with write access (a bot-set ready never counts,
     `READY_ACTOR_NOT_AUTHORIZED`).
   - `managed-label`: the person's `harness:managed` is the grant.
   - `none`: nothing more.

Template:

```markdown
<Context: what exists today, which files/modules are involved, why this is needed.>

## Goal
<One concern, one PR.>

## Acceptance criteria
- <observable, testable outcome>
- <tests that must exist/pass>

## Out of scope
- <what not to touch>

Depends on: #<n>   (only if needed; omit the line otherwise)
```

Labels at creation: `harness:managed` (+ `harness:ready` only if the repo uses `ready-label` and Johannes wants it to
start now). Optional priority: `harness:priority-high|normal|low` (planner orders priority, then issue number).

### Things that make a task fail or never start

- **Protected paths** (`src/state/protected-paths.ts`): any mention of `.github/…`, `.gitmodules`, `.claude/`,
  `.codex/`, `.agents/`, `AGENTS.md`, `CODEOWNERS`, or "new/neuer/eigener CI-Job/Workflow" blocks the task before
  start. The worker may not edit them. Do that part yourself in a separate PR, or list it under `## Out of scope` /
  `## Nicht enthalten`, or phrase as prohibition ("Keine Änderungen an `.github/`"). `.gitignore`/`.gitattributes` are
  fine since SF #147.
- **Secret-like text**: never put literal header examples like `Authorization: Bearer <key>`, tokens or key-shaped
  strings into the issue. GitHub masks them and drops the coding request → `EXECUTOR_INFRASTRUCTURE_FAILURE`
  (controla#133). Describe in words.
- **Too large**: `workers.coding.smallPullRequests` is on; the worker reports `blocked` with a proposed split. Diffs
  >5000 lines / >100 files are risk ≥ high; review context above `merge.review.maxContextBytes` is split into ≤4 parts.
  Cut work into small, independent issues chained with `Depends on:`.
- **New npm dependencies**: allowed (harness resolves `package-lock.json` after the agent since 0.25.0), but say so in
  the issue.
- **Binary assets** (ZIP, images): put them in their own PR, merged before the Factory issue that needs them.
- **Workers are offline**: they cannot fetch URLs, call APIs or check external facts. Put needed facts into the issue.
  Facts a person must verify (legal, AVV, prices) → write `[prüfen]` placeholders, or the merge review defers.
- **Hard risk floor**: migrations, auth/permissions, payments, new external interfaces → at least `high` → needs
  `/harness approve` unless the repo's `autoMergeUpTo` is higher. Mention that to Johannes up front.
- **Editing an issue later** creates a new task version (fresh retry budget, restarts). An edit by an account without
  write access removes `harness:managed` (and ready) until a maintainer re-applies it.
- Follow repo rules (e.g. letterflow: `BOS:` line, invented test data only, no real leads/addresses in a public repo).

### After creating

Check within a reconcile cycle (webhook nudges usually seconds; safety poll 900 s) that the Factory posted its status
comment on the issue and the monitor lists the issue. A `Blocked:` line in the status comment names the fix.

## 2. Checking and judging state

Sources, cheapest first:

1. **Issue status comment** (Factory bot, edited in place): state, `**Needs:**`, `**Model:**`, `**Usage:**`, failure
   codes. Labels: `harness:{backlog,ready,running,awaiting-pr,awaiting-approval,blocked,failed,done}`;
   PR labels `sf:needs-human`, `sf:risk-<class>`, `sf:blocked`.
2. **SF Monitor** (https://sf-monitor.srv2127002.hstgr.cloud, GitHub login, Johannes' allowlist): use the browser tools
   (Claude in Chrome preferred). Pages: queue (`/`), `/analytics` (Kosten), `/metrics` (lead time, Jev evaluation).
   `/api/queue` returns the broker queue JSON for the signed-in session. Groups: Läuft, In Warteschlange,
   Wartet auf dich, Blockiert/fehlgeschlagen, Erledigt (24 h).
3. **Broker HTTP API** (bearer = `FACTORY_MONITOR_TOKEN` or manager token; not reachable from the cloud container,
   proxy 403): `GET /v1/queue`, `/v1/events`, `/v1/metrics`, `/v1/analytics?days&repository`,
   `/v1/repositories/{id}/{runs|findings|events}`. Use it via the monitor instead.
4. **SF Manager MCP**: `list_repositories`, `get_repository` (config, pin, lifecycle), `list_factory_versions`,
   `get_change`.
5. **GitHub Actions job logs** (`mcp__github__get_job_logs`): coding job "code / code", step "Run Claude Code behind the
   credential proxy" prints `result: <subtype> turns=N cost_usd=X`; validation job "Application checks" holds the real
   test output. Read the job log before trusting a worker's "environment" diagnosis.
6. **Broker logs**: Hostinger connector (`mcp__Hostinger_Connector__search` for the docker logs operation), VPS 2127002,
   project `sfm`, services `runtime-broker`, `runtime-worker`, `runtime-worker-previous`. Only last ~300 lines,
   lost on container recreate. Useful lines: `factory-sanity`, `github-requests` (quota `limits`), `factory-usage`,
   `factory-llm-fallback`, `factory-router`, `factory-nudge`.

Monitor stages and what they mean:

| Stage | Meaning / next step |
|---|---|
| queued | Startable, waiting for a slot (`maxParallelWorkers` usually 1) |
| awaiting-grant | Only `harness:ready` by a person missing |
| refused | Runtime refused start (code shown; costs no attempt; backoff 15 min → 6 h) |
| starting / running | Run in progress |
| retry | Rework/retry scheduled by the Factory itself |
| awaiting-pr | PR open: checks, AI review, risk gate, merge |
| awaiting-approval | Run waits at the approval gate in the SF Manager |
| blocked / failed | Needs action, see section 3 |

Judge health by:
- Same error code on several attempts in a row → deterministic, don't let it retry; fix the cause.
- Sanity findings (`run_stuck` > 60 min, `approval_waiting` > 48 h, `retries_exhausted`, `repeated_failure`,
  `blocked_without_pr`, `dependency_cycle`, `status_stalled`, `reconcile_failing`).
- Cost: Opus high ≈ 0.30 $/min; Slack alerts at ≥ 6 $/run, ≥ 30 $/repo/day, cap `workers.coding.maxCostUsd` (10 $).
  Tokens without a result = waste; report it.
- Repo-wide `GITHUB_HTTP_403` = App installation quota (5000 req/h) exhausted. Do not lower the 900 s poll interval.
- Monitor "nächster Abgleich vor X Min." in the past is a known display quirk, not a hang.

## 3. Intervening

| Symptom | Cause | Fix |
|---|---|---|
| Sits in awaiting-grant | No person's grant | Person applies `harness:ready` (only with Johannes' go) |
| `READY_ACTOR_NOT_AUTHORIZED` / `MANAGED_ACTOR_NOT_AUTHORIZED` | Label set by bot/foreign account | Person removes and re-applies the label |
| `EXECUTOR_WRAPPER_RELEASE_MISMATCH` everywhere | Host pin ≠ repo wrappers (pin merged without rollouts, or wrapper change deployed from main) | Roll all repos out to the host's release via SF Manager now |
| Blocked: Missing Acceptance criteria / Unresolved dependencies / protected paths | Spec | Fix issue text / close deps; clears next pass |
| Blocked by worker (`blocked` result) | Journal holds the result | Removing the label is not enough: edit the issue text (new version) saying what changed |
| Blocked by planner (jev: unclear/too large) | Planner verdict | Revise text, or remove `harness:blocked` to start as is |
| `harness:failed`, retries used up | Budget spent | Add a hint to the body (new version), remove `harness:failed`, close a leftover draft PR from the old run (it keeps the task in awaiting-pr) |
| Fails ~1 s after "Apply bounded artifact", "Harness failed" | Protected artifact path | Remove that path from the task |
| `EXECUTOR_INFRASTRUCTURE_FAILURE` in agent.prepare, empty request | Secret-like text masked | grep validate job log for "Skip output"; reword issue |
| Rework fails in `npm ci` / `WORKSPACE_DEPENDENCIES_FAILED` | package.json changed without lockfile | Claude replacement PR with regenerated lock, `sf:automerge` |
| `OPERATION_FAILED` | Generic broker error | Broker logs (`errorType`), job logs |
| PR "Wartet auf dich" with `/harness approve <64-hex>` | Risk above `autoMergeUpTo` | Johannes clicks "Freigeben" in the monitor or comments the exact line on the PR; post it yourself only on his explicit go |
| PR `sf:needs-human` after review `request_changes`/`defer` | No rework (rework off, adopted PR, or `defer` = facts need a person) | Fix the PR yourself (writer commits are adopted and re-reviewed) or ask Johannes; `defer` usually means unverifiable facts |
| PR `sf:needs-human` "conflict" | Conflict on adopted PR / no attempts left | Resolve on the branch yourself |
| Review context too big / binary diff | Size or binaries | Split PR; land binaries separately |
| Run waits in awaiting-approval | Approval gate in Manager | Approve/cancel in the SF Manager UI |
| Repo-wide refusal / reconcile failing with `LLM_HTTP_*` | Broker LLM key/credit | Report; keys come via GitHub env `production` + redeploy, never on the VPS |

Replacement PR recipe (Factory output nearly right but stuck):
1. Branch from the Factory branch or main, finish the change, run the repo's checks.
2. Open the PR with label `sf:automerge` immediately; reference the issue (`Closes #n`).
3. Close the replaced Factory PR. The broker reviews, risk-rates and merges it; PRs touching `.github/workflows/*` are
   critical and need Johannes' merge.

Rollout recipe (only at empty queue, all repos):
1. Release merged in software-factory → sf-manager `temporalReleases` entry merged and deployed.
2. Host pin PR in software-factory (`WORKER_FACTORY_SHA` new, old value → `PREVIOUS_WORKER_FACTORY_SHA`), wait for the
   deploy (~10 min plus canary ~11 min).
3. For every installed repo: `prepare_rollout` (show diff/warnings) → `publish_change` → merge the rollout PR right away.
   The auto-mode classifier may block `publish_change` without Johannes' go in the thread; ask first with a decision.
4. Check the queue for refusals afterwards.

Config change recipe: SF Manager `get_repository` → edit the full YAML → `prepare_config_change` → `publish_change` →
merge the PR. Never edit `.github/software-factory.yml` by hand.

## Before you finish

- State what you saw with its source (status comment link, monitor, job log line), not guesses.
- Save new lasting findings (a new failure pattern, a changed repo setting) to project memory.
