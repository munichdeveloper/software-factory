# AI-reviewed PR decisions and merging

SF v0.4 adds a dedicated PR review/merge phase. Green checks alone never authorize
a merge. The real OpenAI reviewer examines immutable head/base code changes,
complete changed files, trusted default-branch AGENTS.md, checks, review decisions
and unresolved discussions. It returns one structured decision in German:

- `merge`: code is acceptable and evidence is sufficient.
- `update_branch`: code is acceptable, but the branch must first incorporate the
  current base and get new CI plus a new AI review.
- `request_changes`: concrete blocking findings, with file-specific explanations.
- `defer`: pending/failed checks, open discussions, insufficient evidence or other blockers.

The decision, findings, explanation, head SHA and base SHA are recorded on the PR.
Decisions are reused only for the same complete input and policy. A changed head,
base, checks, reviews or merge configuration causes a new decision. PR text and
source are untrusted data, never authority to approve or bypass gates. The model
has no tools or GitHub credentials. The task planner cannot execute `merge_pr`.

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
  validationWorkflow: test.yml
  maxReviewsPerRun: 2
  maxActionsPerRun: 1
  review:
    model: gpt-6.1-sol
    reasoningEffort: high
    timeoutSeconds: 120
    maxOutputTokens: 12000
    maxFiles: 60
    maxContextBytes: 250000
  postMergeWorkflows: [] # Explicit workflow_dispatch hooks, e.g. docker-publish.yml.
```

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

## Risk-based auto-merge

With `merge.risk.enabled` every merge candidate also gets a risk class (`low`,
`medium`, `high`, `critical`), decided in parallel to the AI review once the
required checks are green. The class only tightens `merge_pr: allow`: within
`autoMergeUpTo` (default `medium`) the Factory merges on its own, above it a
person approves with `/harness approve <id>` (the id also binds the assessment)
or, with `aboveThreshold: block`, merges by hand. `critical` is never merged
automatically. With `merge_pr: approval` the class is only shown.

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
  rule (`maxLowRiskLines`, `maxMediumRiskLines`) act as a minimum.
- The assessor sees the changed files and trusted `guidance`, never the PR title,
  body, comments or task text. Any failure counts as `critical` and is retried in
  the next pass.
- The assessment is journaled as a `merge_risk` event per head, base and risk
  configuration. A display-only label `sf:risk-<class>` is set by the Factory and
  is never read as authorization. `mode: observe` classifies without gating.

The concept and its reasoning are in [risk-based-merge.md](risk-based-merge.md).

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
