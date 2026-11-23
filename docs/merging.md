# AI-reviewed PR decisions and merging

SF v0.4 adds a dedicated PR review/merge phase. Green checks alone never authorize
a merge. The real OpenAI reviewer examines immutable head/base code changes,
complete changed files, trusted default-branch AGENTS.md, checks, review decisions
and unresolved discussions. It returns one structured decision in German:

- `merge`: code is acceptable and evidence is sufficient.
- `update_branch`: code is acceptable, but the branch must first incorporate the
  current base and get new CI plus a new AI review.
- `request_changes`: concrete blocking findings, with file-specific explanations.
- `defer`: insufficient evidence (stub-only tests, facts outside the diff, spec deviations for a person) or a
  workflow waiting in `action_required`. Pending checks, red checks and open review threads never reach a
  `defer`: the merge manager decides them before the review (see below).

The decision, findings, explanation, head SHA and base SHA are recorded on the PR.
Decisions are reused only for the same complete input and policy. A changed head,
base, checks, reviews or merge configuration causes a new decision. PR text and
source are untrusted data, never authority to approve or bypass gates. The model
has no tools or GitHub credentials. The task planner cannot execute `merge_pr`.

## Checks and review threads before the review

The merge pass resolves these itself instead of handing the PR to a person (issue #251):

- **Pending checks.** While any check on the head is still running (the Factory's own merge check excluded), or a
  required check is missing, no AI review runs and none is recorded for the head. The pass waits and looks again on
  the next poll or webhook nudge. A check that stays pending longer than 6 hours (fixed internal limit) hands the PR
  over (`handover`, `sf:needs-human`) with the check named.
- **Red checks.** A failed check goes back to rework like `request_changes`; the task carries the check name and what
  it reports (check summary, failed steps). A secret-scanner alert (e.g. GitGuardian) asks the worker to replace the
  flagged value with an obvious placeholder; the Factory never dismisses or marks a finding itself. Without rework
  (`execution.rework` off, `execution.maxRetries` used up, not the latest attempt, not a Factory PR) the PR is handed
  over with the check named. A required check that failed is re-run once first, as before.
- **Open review threads.** Unresolved review comments go back to rework with their texts; the Factory resolves no
  thread itself. The new head is reviewed again after the rework push.
- **Unchanged.** A workflow in `action_required` stays a `defer` (the Factory never opens that gate), and so does
  insufficient evidence. Step and label names (`review-rejected`, `handover`, `sf:needs-human`) keep their meaning.

## Waiting for a predecessor (`Depends on:`)

A line `Depends on: #12, #13` in the PR text names predecessors, with the same syntax as for tasks (`src/state/lifecycle.ts`).
The numbers may be pull requests or issues. The merge pass looks at this line first, before anything else:

- **Open predecessor** (PR not merged, issue not closed): no AI review, no risk assessment, no merge. The check
  "Software Factory / Merge" shows "Wartet auf Vorgänger #n" (neutral) and the status comment says the same.
- **Predecessor PR closed without merge**: it keeps blocking and is reported as "Vorgänger #n ohne Merge geschlossen".
  The PR is handed over to a person (`sf:needs-human`).
- **Predecessor merged** (or issue closed): the normal flow (branch update, checks, review, risk) runs in the next pass.
- **Cycle** (e.g. #5 depends on #6 and #6 on #5): reported as a block and handed over to a person.

Typical use: the critical part lives in its own PR; the rest carries `Depends on: #n` and merges by risk afterwards.

## Opt-in and configuration

```yaml
autonomy:
  profile: autonomous
  overrides:
    merge_pr: allow # approval also supported; deny is the default.
merge:
  enabled: true # false by default, preserving existing installations.
  includeFactoryPRs: true
  adoptLabel: sf:automerge
  method: squash
  updateBranch: true
  requiredChecks: [test-backend, test-frontend, test-docker]
  validationWorkflow: test.yml # Started after a branch update only when it declares workflow_dispatch.
  maxReviewsPerRun: 2
  maxActionsPerRun: 1
  review:
    model: gpt-6.1-sol
    reasoningEffort: high
    timeoutSeconds: 120
    maxOutputTokens: 12000
    maxFiles: 60
    maxContextBytes: 250000
    maxParts: 4 # Larger change sets are reviewed in up to this many parts (1: never).
  postMergeWorkflows: [] # Explicit workflow_dispatch hooks, e.g. docker-publish.yml.
```

A change set whose full review context exceeds `maxContextBytes` is reviewed in
parts (issue #189). Each part stays under the limit and carries `AGENTS.md`, the
PR facts, the list of all other changed files (with their patches while they fit)
and the full content of its own files; a module and its test stay together. A
file that alone does not fit is reviewed by its patch with 200 lines of context
around every hunk, so every changed line is still reviewed. The PR merges only
when every part approves the same head; a part that rejects or defers decides
for the whole PR, and later parts are not reviewed. The review comment names the
number of parts. More than `maxParts` parts are refused with a hint to split the
PR. The risk assessment uses the same parts and keeps the highest class; the
deterministic size and area rules still apply to the whole change set.

Only proven Factory PRs or same-repository PRs explicitly labeled `sf:automerge`
are eligible. The label is an authorization by a repository maintainer to enter
the AI review process, not an instruction to merge. PR bodies cannot enroll work.
Bootstrap creates default `sf:automerge` and `sf:blocked` labels. A custom label
must already exist. Fork PRs, drafts, non-default targets and explicit blocks are
excluded. Closed/blocked source tasks stop Factory PR merges. Candidate discovery
uses the 100 most recently updated PRs; enrolling an older PR updates its position.

`merge_pr: approval` additionally requires an authorized `/harness approve <id>`
comment tied to the exact reviewed head/base, decision and policy. Revocations
are honored. Advisory, dry-run, global disable and merge disable perform no review
or merge mutations. Notifications and merge policy changes do not invalidate
unrelated coding-worker approvals; merge approvals include their own full policy.

## Stale branches and merge conflicts

With `merge.updateBranch: true` (the default) the Factory brings a branch that is
behind its base up to date itself, before any AI review: once the required checks of
the current head are green and that head was not already rejected, it merges the base
into the branch (GitHub "Update branch"), dispatches the validation workflow for the
new head and reviews only that head. A review of a stale state would only be repeated
after the update. Each head/base pair is updated at most once.

A branch that conflicts with its base (GitHub `mergeStateStatus` `DIRTY`, or an update
GitHub refuses with a merge conflict) gets no pull-request checks, so the Factory does
not wait for them and does not review it:

- A Factory pull request of the task's latest attempt, with `execution.rework: true` and
  attempts left within `execution.maxRetries`: the broker journals a
  `merge_changes_requested` event with `cause: conflict` on the task, once per head. The
  Manager starts a rework. The executor applies the previous attempt to the current
  base and leaves git's conflict markers in the files where it collides; the worker
  resolves them and is told so in its review context. A conflict rework stays on
  `workers.coding.agents` and does not escalate to `retryAgents` by itself. The rework's
  pull request replaces the old one and goes through checks, validation and review.
- Everything else (rework off, attempts used up, a pull request adopted with
  `sf:automerge`): a `merge_handover` event with `decision: conflict` and the label
  `sf:needs-human` hand it over to a person; with
  `notifications.slack.events.handover_required` that is announced on Slack. Commits a
  person with write access pushes to resolve it are adopted.

A failed update caused by a conflict no longer ends the merge pass for the other pull
requests.

## Risk-based auto-merge

With `merge.risk.enabled` every merge candidate also gets a risk class (`low`,
`medium`, `high`, `critical`), decided in parallel to the AI review once the
required checks are green. The class only tightens `merge_pr: allow`: within
`autoMergeUpTo` (default `medium`) the Factory merges on its own, above it a
person approves with `/harness approve <id>` (the id also binds the assessment)
or, with `aboveThreshold: block`, merges by hand. `critical` is never merged
automatically. With `merge_pr: approval` the class is only shown.

### Overruling a deferral

When the AI review for the current head ends with `defer` and has no `blocking`
finding (for example a false alarm of a secret scanner), the merge manager
computes an approval id like the one of the risk gate, bound to repository, pull
request, head, base, review key, review and risk. The status comment, the check
"Software Factory / Merge" and the queue details show the line
`/harness approve <id>` and say that it overrules the deferral. A comment with
the current id from a person who may approve (same identity check as the risk
gate) lets the normal flow continue: required checks, merge gate, merge. If the
risk is also above `autoMergeUpTo`, the same approval covers the risk gate (one
id, one comment). The override is journaled (`merge_defer_overridden`), noted on
the pull request as "Zurückstellung überstimmt von @login", and `sf:needs-human`
is removed.

A person can never overrule `request_changes` or a review with a `blocking`
finding: there is no id, and a matching comment is ignored and reported as "nicht
überstimmbar". The same holds where the Factory does not merge at all
(`aboveThreshold: block`). A new commit, a new base or a new review changes the
id, so an old id has no effect.

```yaml
merge:
  enabled: true
  risk:
    enabled: true
    autoMergeUpTo: medium
    areas:
      - name: Dokumentation
        paths: ['docs/**', '**/*.md']
        class: low
      - name: Datenbankmigrationen
        paths: ['src/main/resources/db/migration/**']
        class: high
```

- Built-in critical paths cannot be lowered: `.github/workflows/**`,
  `.github/actions/**`, `.github/software-factory.yml`,
  `.github/software-factory.validation.json`, `AGENTS.md` and `CODEOWNERS`.
- A change covered completely by areas takes the highest area class without a
  model call. Otherwise the AI assessor decides, and touched areas plus the size
  rule (`maxLowRiskLines`, `maxMediumRiskLines`, `maxMediumRiskFiles`) act as a
  minimum. Content decides more than size: an assessment naming authentication,
  permissions or money (factors `auth`, `permissions`, `payments`) is at least
  `high`, even for a one-line change.
- The assessor sees the changed files and trusted `guidance`, never the PR title,
  body, comments or task text. Any failure counts as `critical` and is retried in
  the next pass.
- The assessment is journaled as a `merge_risk` event per head, base and risk
  configuration. A display-only label `sf:risk-<class>` is set by the Factory and
  is never read as authorization. `mode: observe` classifies without gating.

The concept and its reasoning are in [risk-based-merge.md](risk-based-merge.md).

## Check run on the pull request

The broker shows the merge pass as the check run **Software Factory / Merge** on the head of each pull request it
handles (issue #208), next to the repository's own checks under "Checks". It says where the pull request stands and
why, in the Factory's own words:

| Merge step | Check run |
| --- | --- |
| required checks pending, AI review running, merging | in progress |
| approval needed (with risk class, threshold and `/harness approve <id>`), review asks for changes, handed over | completed, *action required* |
| required check failed, conflict, gate, stopped, branch updated, error | completed, *neutral* |
| merged | completed, *success* |

A new head gets its own check run; the one on the old head stays. The check run is display only: the merge pass
ignores it when it evaluates required checks and gates, so it can never block a merge, and a failure to write it never
fails the pass. It is written only when its status, conclusion or text changes, and after a broker restart the existing
check run of a head is updated instead of a second one being created.

It needs the GitHub App permission **Checks: Read & write** (accepted in each installation). The broker requests it with
a separate token limited to `checks: write`; without it, the check run pauses for six hours, logs
`factory-check-run-disabled` once and everything else runs unchanged. `merge.checkRun: false` turns it off for a
repository; leaving it out keeps it on.

## Technical gates remain mandatory

A positive AI decision is necessary but insufficient. Immediately before merging,
SF re-reads the PR and requires unchanged head/base, current enrollment, resolved
discussions, no changes-requested or required-review state, native `CLEAN` status,
strict effective GitHub PR/status-check rules, and success of every configured and
native required check on the exact head. Other pending/failed checks also block.
No truncated/binary/missing source context receives an approval. Effective rulesets
must enforce strict up-to-date required checks; classic-only protection is currently
insufficient for this verifier. SF never weakens repository rules or uses bypass flags.

The Merge API receives the exact reviewed head SHA. GitHub enforces repository
rules at mutation time, including strict-base freshness. Updates use GitHub's
expected-head branch update API, never force pushes or local hooks. Any ambiguity
or provider failure stops mutation for the rest of that run and posts a reason.

## Execution, CI and recovery

Install the updated wrapper, not only the Action pin. It separates read-only task
management, a trusted merge job (contents/PR write, checks/status read), and Slack
reconciliation. No target code is checked out or executed in the merge job. CI
completion (`workflow_run` for the template's `Test` workflow), default-branch pushes
and scheduled/manual manager runs drive reconciliation. Change the workflow name
in the trigger for repositories whose product CI has a different display name.

A branch update is journaled before mutation, waits for the new head and explicitly
dispatches product CI as supplementary evidence. GitHub may create PR workflows in
`action_required` after a `GITHUB_TOKEN` branch update. A maintainer must inspect
the workflow changes and select **Approve workflows to run** on the PR. SF reads
these exact-head runs, explains the gate and never approves or bypasses it.
Green `workflow_dispatch` jobs do not satisfy native PR required checks; an eligible
PR/push workflow must pass before GitHub reports `CLEAN`. See
[GitHub required-check guidance](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
and [workflow token triggers](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
A new AI decision is required after that update; it never
merges in the same iteration. Unknown update outcomes are quarantined until native
state changes. Successful merges are journaled and adopted PRs enter the existing
bot-only Slack notification flow. Trusted merge intents plus native facts recover
notifications even when the completion receipt was lost.

GitHub suppresses normal push workflows for `GITHUB_TOKEN` mutations. Optional
`postMergeWorkflows` therefore explicitly dispatch trusted, named workflows after a
confirmed merge. Each must support workflow_dispatch on the default branch. Receipts
avoid ordinary repeated dispatches, but ambiguous cross-service failures can repeat
a dispatch; downstream workflows must be idempotent. Confirmed closed bot merges
are reconciled for missing completion receipts/hooks. Optional hooks whose workflow
is not installed yet are deferred until a later reconciliation. This feature does not deploy
code by itself. A merge of workflow files may require repository permissions beyond
those available to an installation; GitHub rejection is reported, never bypassed.
