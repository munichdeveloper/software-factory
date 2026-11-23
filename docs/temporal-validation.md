# Independent validation of Temporal coding artifacts

Coding and automated validation are separate jobs. The coding job keeps its restricted model environment. A fresh GitHub-hosted runner downloads the original artifact, checks its execution/task/base binding, applies bounded file changes to a clean checkout, and validates without the model secret or broker credentials. It never runs on the Temporal host or a production deployment host.

The original model artifact remains immutable: its own `blocked` status is never rewritten. The run result is a separate decision. When the model reported `blocked` for a nonempty change and the independent validation of exactly that change `passed`, the run result is `success`, so the task continues to its pull request and the merge pass like any validated run. The coding sandbox is offline, so a worker that could not install dependencies or run checks itself reports `blocked` for complete work (controla#63); the passed validation is the evidence it lacked. Both statuses appear in the Draft PR and durable broker records. The coding request tells the worker that its environment is offline, that it should not install dependencies or run the project's build, test, lint or browser commands, and that it reports `blocked` only for an incomplete implementation; the validation job runs those checks. The text is stored once per execution, so an execution dispatched before this guidance keeps the request it was sent. A valid nonempty `success` or `blocked` artifact can produce a review Draft, including when checks fail or the project is unsupported. Failed/unsupported checks remain explicit and cannot make the task successful. Missing, invalid, mismatched or ambiguous artifacts/reports fail closed before publication. Manual acceptance criteria remain separate.

## Installation and compatibility

For new coding admissions, the CLI broker enables `validateCoding: true` by default. Install the exact `executorWrapper(factorySha, harnessSha, true)` output at the configured executor workflow path; the broker compares the entire wrapper at the frozen base. This variant adds a required `validation` dispatch input and read-only Actions access. Pin the Factory and Harness to reviewed 40-character commits. Do not inherit repository secrets into the validator.

Existing persisted admissions without `validationPlan` retain their original wrapper, dispatch inputs, result handling and execution budget. The two-argument wrapper function still produces that legacy variant. `validateCoding: false` is an explicit legacy setting for new admissions, not a migration of existing runs. A new admission with a plan requires the independent report; disabling validation while it runs fails closed.

The broker reads `.github/software-factory.validation.json` at the target base and freezes the parsed plan in the admission snapshot. A missing file defaults to the `npm` profile. Invalid files reject admission. Plans contain literal disposable test values only, never production secrets or references to repository secrets.

```json
{
  "version": 1,
  "profile": "npm",
  "timeoutMinutes": 20,
  "composeProjectPrefix": "sf-validation",
  "environment": {}
}
```

Supported profiles require a committed npm lockfile and `test`/`build` scripts. Checks run `npm ci --ignore-scripts`, `npm test`, `npm run build`, and `npm run test:e2e` when available. Playwright Chromium is prepared when the project includes its CLI. The `npm-docker` profile additionally requires `compose.yaml` and `tests/docker-smoke.mjs`; it checks Compose, starts a uniquely named disposable project, runs the smoke test and always attempts volume/container cleanup with a separate cleanup budget. The `maven` profile requires a `pom.xml` at the repository root and runs `mvn validate`, `mvn -DskipTests package` and `mvn verify` in batch mode, using an executable `mvnw` when the repository has one and the runner's Maven otherwise. Modules such as a frontend built through a Maven plugin are part of these checks. `javaVersion` (`17`, `21` or `25`, maven only) makes the validator install that Temurin JDK; without it the runner's default JDK is used. The validation account gets Docker access on its disposable hosted VM for Testcontainers. On a slot of the Factory's runner pool there is no Docker socket; the account is handed the runner's `DOCKER_HOST` when it names the slot's daemon on loopback (`tcp://127.0.0.1:<port>`), and nothing else from the runner's environment. Browser tests find Google Chrome on both kinds of runner. Missing project support is `unsupported`, never a passing check. The prefix must end in `-ci`, `-test` or `-validation`.

### Generated files

Repositories that check in generated files (for example a bundle built from `src/`) can add an optional `generated` list to the plan; there is no default, so plans without it and their hashes are unchanged. At most three entries:

```json
{ "generated": [{ "command": "npm run bundle", "paths": ["bundle"] }] }
```

`command` is a fixed string split on spaces, without shell metacharacters; `paths` are relative, without `..`. After the other checks (and only if they passed) the validator runs each command with the same account and limits as the other project commands, then compares the listed paths with the applied change. A difference, or a failing command, makes the `generated` check `failed` (`CHECK_FAILED`, so `execution.rework` applies) and `generated.log` says e.g. "generated files out of date: run `npm run bundle`" with the paths. The check only verifies: the regenerated files are restored, never adopted, and source integrity is unchanged.

## Boundaries and evidence

Project commands run as a separate `sf-validator` account with an empty inherited environment, a fixed executable path, `CI=true`, a unique Compose project name and the allowlisted literal test values. Environment control keys, model keys, broker keys and GitHub/AWS credential names are rejected. Checkout credentials are not persisted. The validator reusable workflow declares no secrets; its parent forwards the model key only to the coding job. The Docker profile grants Docker access only on its disposable hosted VM: this is a trusted-repository test boundary, not a hostile-code sandbox or permission to use production credentials. Tests can access the network and supply-chain services. Read-only workflow tokens remain platform credentials, not model or broker credentials.

Reports bind execution ID, task ID/version, frozen base SHA, canonical original artifact hash, plan hash, source Actions run, validation run and first run attempt. The broker verifies these against its correlated run and stores an immutable report plus digest separately from the original coding artifact. A passing report requires required checks and source integrity; mutations of tracked/applied source during validation prevent a pass. Source integrity is not proof that repository tests are complete or adversary-proof. No artifact source enters Temporal history.

Artifacts are named `coding-result-EXECUTION_ID`, `coding-validation-EXECUTION_ID` and `coding-validation-logs-EXECUTION_ID` with seven-day retention. The bounded report is `validation.json`; logs are separate, capped per check, and not forwarded as GitHub command-channel output. Publication continues through durable claims, receipts and reconciliation. Restart between artifact and report persistence reuses the same compute run. Review Draft publication preserves normal scope/path/approval checks and does not authorize merge or deployment.

Focused tests cover original blocked status with passing/failing validation, missing/forged report rejection, hostile paths/symlinks, source mutation, Docker cleanup, reserved environment names and publication response-loss reconciliation. The real GitHub/Temporal acceptance evidence is recorded separately; a unit fixture is not a real model or browser/Docker run.

## Rework after a failed validation

With `execution.rework: true` a result that ended `blocked` only because its bound validation report is `failed`
(`CHECK_FAILED`) starts a further attempt while `execution.maxRetries` allows it. Without the switch, and after the last
allowed attempt, the task ends `blocked` with the original statuses, as before.

- The Manager proposes `retry_worker` for the next attempt number and writes the attempt it continues into the intent
  (`urn:sf-rework:<execution>`). The broker accepts it only if its own records show that attempt for the same task
  version, ended `blocked`, with a failed validation (`REWORK_SOURCE_INVALID` otherwise).
- In ready-label mode the grant that admitted the first attempt covers its rework: same timeline event, consumed only
  by the Manager, task still in a status the Manager set. A new grant, a removed label, a person's `harness:blocked` or
  a revised task text ends that coverage. No attempt beyond `maxRetries` is ever started.
- The worker receives, as `contextReferences` of the unchanged request contract: the head of the previous attempt's
  branch, the failed checks with exit codes, and the tail of each failed check's output (three checks, 2,700 characters
  each at most, control sequences removed, labelled as untrusted output).
- The executor applies the previous attempt to the workspace on the current base before the network is closed. If it
  does not apply cleanly the workspace stays at the base and the commit remains available for inspection.
- The new attempt is published as its own draft pull request; the broker then closes the draft of the attempt it
  continues, so a task has one open Factory draft. A pull request by anyone else for the task stops the rework.

## Rework after the merge review asked for changes

The same switch covers a validated attempt whose pull request the broker's independent merge review refuses
(`request_changes`, or any `blocking` finding). Before, such a pull request stayed open with nothing scheduled.

- The merge pass journals `merge_changes_requested` on the task (once per review), naming the pull request, its head,
  the attempt that published it and the review. Its readable part says whether a rework follows.
- With `execution.rework: true`, while `maxRetries` allows it and the pull request is still open, the Manager proposes
  `retry_worker` as a rework of that attempt. The broker accepts it only for an attempt of the same task version that
  ended `success` without a failed validation and for which that journal entry exists (`REWORK_SOURCE_INVALID`
  otherwise). The grant rules above apply unchanged.
- The worker receives the previous branch head as above, plus the review's reason and up to eight findings (blocking
  first) as `sf-context review-changes: …` and `sf-context review-finding <severity> <path>: …`, each at most 1,000
  characters, control characters removed. They are model text, not instructions of the broker.
- Without the switch, or after the last allowed attempt, the pull request waits for a person as before.

## Task context

Before the first dispatch of an execution the broker resolves, once, the refs of the target repository that the task
text names: full commit SHAs, pull request numbers (`#14`, `PR 14`, `pull/14`; heads in the same repository only) and
branch names quoted as code that exist in the repository. At most six commits are passed on; a named commit or a fork's
pull request that cannot be provided is reported to the worker as unavailable. Task text only names candidates: nothing
is fetched from a URL or from another repository, and a failed lookup never fails the run. The executor fetches these
commits (depth 50) into `refs/sf-context/*` before the isolated step; they are read-only context, and the result is
still a change set against the frozen base under the same path, size and validation rules.

Both mechanisms need the executor workflow of this release. An older pinned executor passes the entries to the worker
as plain text and neither fetches nor applies anything, so enable `execution.rework` only after the release rollout.

### Survey of related work (SF #255)

Before the first dispatch of a first attempt (not a rework) the broker surveys the repository once, so the offline
worker knows what else is going on. It collects without a model, in at most 4 + 12 GitHub requests: the last ten merged
pull requests (with the issues they close or name), up to 30 open pull requests (the task's own `sf/issue-<n>/…`
branches excluded) with the files of the 12 most recently updated, and up to 50 open issues with their relation to the
task (`Depends on:` in either direction, `#n` references in either direction). Open pull requests that change a path
the task text names (equal path, a file inside a named directory, or the same file name) are overlaps.

A fixed Claude Haiku (`claude-haiku-5-5`, the broker's `ANTHROPIC_API_KEY`) condenses these facts into at most four
short notes. The worker receives them as `sf-context reconcile <i>/<n>: …` (the first one says that it is a model's
survey, orientation only, not instructions), followed by up to three `sf-context reconcile-overlap #<pr>: …` facts of
the broker; all are bounded to 1,000 characters each and at most eight entries, and they never displace the rework or
ref entries above. The call is recorded in the cost analytics as step `reconcile` (about 3k input tokens, well below
one cent). A detected overlap is a hint only: the run starts as before (Johannes, 2026-11-22: hint first, then measure).
Without the key only the overlap facts are passed; a failed GitHub lookup or model call leaves the run without a
survey. Each survey logs one `factory-survey` line (repository, issue, open pull requests, overlaps, linked issues,
whether the model was used, an error code). `FACTORY_RECONCILE=off` in the broker's environment turns the survey off.
The result is stored with the execution (`coding-reconcile`), so later polls rebuild the identical request; executions
dispatched before this release get none.

## Local servers and browser tests for the worker

With `workers.coding.loopback: true` the broker adds `sf-context sandbox loopback` to the request and the executor
runs the Harness action in its loopback mode: each command of the worker stays in a private network namespace that has
only `lo`, so it can start the project's server and run browser tests against `127.0.0.1`. Outbound traffic, DNS and
the host's loopback, including the model API proxy, stay unreachable for commands; the Harness verifies that with a
probe before the model starts and aborts otherwise. If the locked dependencies contain Playwright, the executor installs
its Chromium before the isolated step and the Harness shares it read-only with the worker account.

In this mode the checkout is marked untrusted for Codex, so a repository `.codex/config.toml` is not applied. The mode
relies on an experimental Codex feature and is therefore opt-in per repository.

