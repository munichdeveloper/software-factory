# Verification

Automated tests cover all 20 requested categories: empty repo, runnable task,
active worker, merged closing PR, unmerged closed PR, dependencies, worker
failure/timeout, repeated manager, duplicate follow-up, invalid config, limits,
three profiles, overrides, prompt injection, LLM failure, interrupted dispatch
and subsequent reconstruction.

Additional tests cover Octokit HTTP pagination, cross-repository closing links,
bootstrap idempotency, approval authorship/version invalidation, retry-specific
approval IDs, protocol validation, actual digest correctness, asynchronous
success, native closure, dry run/global disable, and nested default isolation.

Commands: `npm run check`, `npm run test:coverage`, `npm run schemas`,
`npm audit --audit-level=moderate`, checksum-verified `actionlint v1.7.12`.
CI repeats checks on Node 22 and rejects generated-schema drift.

## Verified results (6 November 2026)

103 tests pass. Source coverage (excluding CLI) is 93.97% lines / 79.66% branches.
Build, ESLint, generated-schema consistency, YAML validation, actionlint 1.7.12
and `npm audit --audit-level=moderate` pass with zero reported vulnerabilities.
[GitHub CI on the reviewed runtime](https://github.com/munichdeveloper/dev-agent-harness/actions/runs/42228459817)
repeated these checks on Node 22.

The dedicated private fixture repository is
[`munichdeveloper/dev-agent-harness-e2e-20261106`](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106).
It contains no production application; evidence is accessible to its owner.
Initial acceptance runtime: `a511e38fc0efa197014358de9d7829e1ca81beba` (earlier
steps used its immediately preceding commits). Copilot review regressions also
tested runtime `77fc1d4ccfa5004c95378369c2015977613b71b0`.

| Acceptance behavior | Actual GitHub evidence |
|---|---|
| Two-file installation and least-privilege label bootstrap | [Bootstrap run](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/actions/runs/42203004538) |
| Supervised proposes approval before dispatch | [Manager run](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/actions/runs/42203334040), [Issue #1](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/issues/1) |
| Exact maintainer approval dispatches an asynchronous worker | [Manager dispatch](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/actions/runs/42203504311) |
| Real test operation and durable result | [Worker run](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/actions/runs/42203545251), [result comment](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/issues/1#issuecomment-6682807755) |
| Later manager consumes result, preserves documentation label | [Reconciliation](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/actions/runs/42203745841): awaiting-pr, Issue remains open |
| Unchanged repeat is mutation-free | [Repeat run](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/actions/runs/42203844693): executed=0, comment count stays 8, one worker total |
| Native closing reference and automatic Issue closure | [Merged fixture PR #2](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/pull/2), [manager reconciliation](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/actions/runs/42203933528): closed + done |
| Advisory has no mutations | [Advisory run](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/actions/runs/42204020209): Issue #3 remains ready, zero comments and zero new worker runs |
| Autonomous needs no human approval | [Manager](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/actions/runs/42204139431), [worker](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/actions/runs/42204182943) for [Issue #3](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/issues/3) |
| Final runtime reconstructs earlier results | [Final runtime manager](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/actions/runs/42204353445): Issue #3 becomes awaiting-pr |
| Human reopening supersedes an old merge | [First run](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/actions/runs/42204470974) repairs done to backlog; [second run](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/actions/runs/42204593454) preserves open state and reconciles awaiting-pr |

The fixture workflow is disabled after acceptance to prevent future scheduled
test runs. Simulated integration tests cover interrupted dispatch, failed receipt
persistence, uncertain outcomes, cancellation, timeouts, per-attempt approvals
and terminal failure reconstruction after Actions history is removed.

## Copilot review regression verification

All five review findings have regression coverage:

- Automatic block origins use mandatory intents and the specific native label
  application, independent of decision logging. Tests cover human remove/reapply,
  resolved quarantine, post-update crashes, incomplete provenance, queued worker
  cancellation and a human block arriving during the final precondition read.
- The generated configuration schema describes accepted input, including omitted
  defaults. Ajv draft-2020-12 parity tests check minimal/partial/invalid configs.
- CLI tests verify advisory bootstrap never mutates, with and without local-write
  opt-in; dry-run and normal local-write guards are also checked.
- Missing OpenAI credentials are checked only when semantic planning begins;
  deterministic reconciliation succeeds with maxCalls zero and continues with
  a planning error when calls are enabled.
- A 101-task integration test verifies the bounded mock plan still dispatches
  work instead of exceeding the action schema.

Live fixture [Issue #4](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/issues/4)
ran with `persistDecisions: false`, `llm.provider: openai`, `llm.maxCalls: 0`,
no OpenAI secret and workers disabled. The
[first run](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/actions/runs/42228289434)
created a specification block and exactly one mandatory provenance comment.
After acceptance criteria were added, the
[second run](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/actions/runs/42228460682)
restored ready without adding a comment. After a human reapplied the block, the
[third run](https://github.com/munichdeveloper/dev-agent-harness-e2e-20261106/actions/runs/42228555538)
preserved blocked, performed zero actions and left the comment count at one.
The fixture was disabled again after verification.

No OpenAI API secret was configured in the implementation repository. The real
Responses adapter is implemented and transport-tested, but a paid live provider
call was not performed. Organization-specific policies, other token types,
branch rules and extreme API-rate/retention limits remain installation-specific.
