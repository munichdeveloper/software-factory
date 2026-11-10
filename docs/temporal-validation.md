# Independent validation of Temporal coding artifacts

Coding and automated validation are separate jobs. The coding job keeps its restricted model environment. A fresh GitHub-hosted runner downloads the original artifact, checks its execution/task/base binding, applies bounded file changes to a clean checkout, and validates without the model secret or broker credentials. It never runs on the Temporal host or a production deployment host.

The original model artifact remains immutable. An original `blocked` result is never rewritten to `success`, even when independent checks pass. Both statuses appear in the Draft PR and durable broker records. A valid nonempty `success` or `blocked` artifact can produce a review Draft, including when checks fail or the project is unsupported. Failed/unsupported checks remain explicit and cannot make the task successful. Missing, invalid, mismatched or ambiguous artifacts/reports fail closed before publication. Manual acceptance criteria remain separate.

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

Supported profiles require a committed npm lockfile and `test`/`build` scripts. Checks run `npm ci --ignore-scripts`, `npm test`, `npm run build`, and `npm run test:e2e` when available. Playwright Chromium is prepared when the project includes its CLI. The `npm-docker` profile additionally requires `compose.yaml` and `tests/docker-smoke.mjs`; it checks Compose, starts a uniquely named disposable project, runs the smoke test and always attempts volume/container cleanup with a separate cleanup budget. Missing project support is `unsupported`, never a passing check. The prefix must end in `-ci`, `-test` or `-validation`.

## Boundaries and evidence

Project commands run as a separate `sf-validator` account with an empty inherited environment, a fixed executable path, `CI=true`, a unique Compose project name and the allowlisted literal test values. Environment control keys, model keys, broker keys and GitHub/AWS credential names are rejected. Checkout credentials are not persisted. The validator reusable workflow declares no secrets; its parent forwards the model key only to the coding job. The Docker profile grants Docker access only on its disposable hosted VM: this is a trusted-repository test boundary, not a hostile-code sandbox or permission to use production credentials. Tests can access the network and supply-chain services. Read-only workflow tokens remain platform credentials, not model or broker credentials.

Reports bind execution ID, task ID/version, frozen base SHA, canonical original artifact hash, plan hash, source Actions run, validation run and first run attempt. The broker verifies these against its correlated run and stores an immutable report plus digest separately from the original coding artifact. A passing report requires required checks and source integrity; mutations of tracked/applied source during validation prevent a pass. Source integrity is not proof that repository tests are complete or adversary-proof. No artifact source enters Temporal history.

Artifacts are named `coding-result-EXECUTION_ID`, `coding-validation-EXECUTION_ID` and `coding-validation-logs-EXECUTION_ID` with seven-day retention. The bounded report is `validation.json`; logs are separate, capped per check, and not forwarded as GitHub command-channel output. Publication continues through durable claims, receipts and reconciliation. Restart between artifact and report persistence reuses the same compute run. Review Draft publication preserves normal scope/path/approval checks and does not authorize merge or deployment.

Focused tests cover original blocked status with passing/failing validation, missing/forged report rejection, hostile paths/symlinks, source mutation, Docker cleanup, reserved environment names and publication response-loss reconciliation. The real GitHub/Temporal acceptance evidence is recorded separately; a unit fixture is not a real model or browser/Docker run.
