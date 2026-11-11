# Verification of the repository split

Local and CI checks: 109 SF tests, two real external-Harness integration tests,
build, lint, JSON schema parity, generated-schema consistency, deterministic
bundle consistency, actionlint and dependency audit. Harness independently has
16 runtime, CLI and ownership-boundary tests. Both audits report zero findings.
The pre-split 103-test regression suite is retained in SF, with the actual worker
implementation replaced by injected test fixtures; protocol integration invokes
the real implementation from the other repository.

The Factory's integration tests launch the pinned Harness CLI in a subprocess,
verify its exact request/result schemas, persist the correlated result and run
another manager pass to verify lifecycle and idempotency. Separate tests ensure
GitHub/OpenAI credentials do not enter the subprocess and reject unrelated,
invalid, oversized or unsuccessful process responses.

## Actual GitHub Actions evidence

Private fixture repository: `munichdeveloper/dev-agent-harness-e2e-20261106`.
This contains no production application and is disabled after verification.
Factory runtime `d83554c1c60b828a33101189f8b85f0d70e671ce` calls Harness
`afb02103e1255fb966cc5264b6833c5cc63eda94` through contract 2.0.

- [SF CI](https://github.com/munichdeveloper/software-factory/actions/runs/42272407153)
  builds both repositories independently, tests the actual process boundary and
  verifies schemas and bundle reproducibility.
- [Initial manager](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/actions/runs/42272469259)
  successfully reads the old managed tasks/journals from before separation.
- [Dispatch](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/actions/runs/42272579822)
  delegates [Issue #5](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/issues/5).
- [SF execution job](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/actions/runs/42272619959)
  invokes the public pinned Harness from the private SF action, without a PAT.
  SF persists a successful digest result under the new `software-factory:v1`
  marker; the Harness does not publish GitHub comments.
- [Later reconciliation](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/actions/runs/42272698812)
  consumes that result and moves the task to awaiting-pr.

Legacy comments/labels and human blocks remain intact. Historical pre-split
acceptance details are available in the import commit and original Harness PR #1.
No paid OpenAI call was performed: the planning provider was moved without API
changes, and no key is configured. The original v0.1 verification had no coding/review worker or automatic
PR merge is claimed. This private SF distribution supports permitted private
repositories owned by the same account; public targets need a public distribution.

## Lifecycle scenarios

`tests/scenarios.test.ts` runs the real Manager and RuntimeController against a simulated repository
(`tests/scenario-world.ts`): issues, journal comments, the native label timeline with its actors, the broker
store and Temporal. Only I/O is simulated. People grant, revise, close and reopen tasks and merge or close pull
requests; workers finish, fail or vanish; GitHub writes, the label timeline and Temporal fail at arbitrary points.

After every sequence the surroundings are made healthy again and the Manager reconciles until nothing
changes. Then these rules must hold:

- Reconciliation comes to rest and a further run changes nothing.
- Every intent is either running in Temporal or has a journaled result; none is duplicated.
- No unknown outcome remains once the runtime answers.
- A closed task runs nothing and holds no worker slot; a free slot is never denied.
- Every task has exactly one lifecycle status and at most one status comment, which names that status and is
  not rewritten when nothing changed.
- In ready-label mode only a person applies `harness:ready`, no run is admitted on the Manager's own label,
  and a standing grant by an authorized person is honoured.

Named scenarios cover the known sequences; a seeded random search runs 150 sequences per mode in CI
(no gate, ready label, human gate, two workers, and two modes in which successful results open pull requests
that people merge or close). `SF_SCENARIO_SEEDS=2500 npx vitest run tests/scenarios.test.ts`
searches deeper; a failing seed replays exactly and prints its event log.
