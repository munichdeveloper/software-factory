# Configuration reference (schema version 1)

The configuration is read by API from the target default branch. Unknown keys,
duplicate YAML keys, invalid limits/enums and unsupported workers fail validation.
Generated JSON schemas share the executable Zod source.

| Setting | Default | Meaning / range |
|---|---|---|
| `version` | required `1` | Configuration contract version |
| `factory.enabled` | `true` | Global kill switch, including bootstrap |
| `factory.scope` | required | Trusted mandate, 1–4000 characters |
| `manager.workflow` | `factory-manager.yml` | Installed wrapper filename; letters/digits/underscore/hyphen and YAML extension |
| `manager.maxActions` | `10` | Executed business actions/run, 1–100; journal bookkeeping does not consume proposal slots |
| `manager.timeoutMinutes` | `15` | Manager runtime cap, 1–30; Actions cap is 30 minutes including setup |
| `manager.maxContextTasks` | `20` | Tasks in semantic planner context, 1–100 |
| `manager.maxContextChars` | `20000` | Serialized task array character budget, 1000–100000; scope adds at most 4000 |
| `manager.trustedActors` | `[github-actions[bot]]` | Nonempty exact author-login allowlist for machine events |
| `autonomy.profile` | `supervised` | `advisory`, `supervised`, `autonomous` |
| `autonomy.overrides` | `{}` | Per-action `allow`, `deny`, `approval`; unknown actions fail |
| `execution.dryRun` | `false` | Evaluate without writes/dispatch; manual dry-run also enables this |
| `execution.maxParallelWorkers` | `1` | Active/uncertain executions, including old task versions, 1–20 |
| `execution.maxRetries` | `2` | Retries after initial attempt, 0–5; separately approved per attempt |
| `execution.maxNewIssues` | `3` | Follow-ups created/run, 0–20 |
| `execution.workerTimeoutMinutes` | `30` | Worker cap, 1–30; overdue active runs cancelled before retry |
| `execution.dispatchGraceMinutes` | `10` | Actions visibility grace, 1–60; expiry quarantines uncertain intents |
| `execution.rework` | `false` | Temporal coding with independent validation only: a failed validation starts a further attempt within `maxRetries` instead of waiting for a person. Enable only after the executor release that fetches task context is rolled out |
| `workers.coding.loopback` | `false` | Temporal executor only: the worker's commands may bind and connect on a private loopback interface (local server, browser tests) and get the locked Playwright browser; all other network stays closed. Needs the executor release that supports it |
| `monitoring.enabled` | `true` | Temporal: the broker's sanity check of this repository's runs after each reconciliation (no extra GitHub requests). The whole `monitoring` section is optional and leaves the configuration hash unchanged while absent |
| `monitoring.stuckRunMinutes` | `60` | A run still active this many minutes after its worker timeout is reported as stuck, 5–1440 |
| `monitoring.approvalWaitHours` | `48` | A run waiting at its approval gate this long is reported, 1–720 |
| `monitoring.repeatedFailures` | `3` | This many attempts in a row ending with the same error code are reported as an endless retry, 2–20 |
| `monitoring.stalledPasses` | `10` | Consecutive reconciliations a status label may differ from the derived status, or reconciliations may fail or report errors, before it is reported, 2–200 |
| `workers.coding.smallPullRequests` | `true` | Tells the coding worker to keep each change to the task's one concern (no drive-by refactoring, renaming or unrelated fixes) and, for a task that bundles several concerns or is too large for one reviewable change, to report `blocked` with a proposed split instead of one large PR; the planner cuts follow-ups to one concern each. Fixed per execution when it is first dispatched. Risk-based merging (`merge.risk`, more than 800 changed lines are at least `high`) stays the hard limit |
| `monitoring.slack` | `true` | Posts new and resolved findings to Slack with the broker's bot (`SLACK_BOT_TOKEN`), one message per reconciliation that changed something, at most once |
| `monitoring.channel` | `null` | Slack channel for findings; `null` uses `notifications.slack.channel` where `notifications.slack.enabled`, otherwise nothing is posted |
| `llm.provider` | `mock` | Deterministic mock or real `openai` Responses API |
| `llm.model` | `gpt-4.1-mini` | Explicit provider model string; account must have access |
| `llm.reasoningEffort` | `null` | Omit capability, or `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; must match model |
| `llm.maxOutputTokens` | `4000` | Output cap, 256–16000 |
| `llm.timeoutSeconds` | `60` | Per call timeout, 1–120 |
| `llm.maxCalls` | `1` | Total calls incl. retries, 0–3; zero disables semantic planning only |
| `workers.test.enabled` | `true` | Bundled non-code-changing worker |
| `workers.test.operation` | `sha256` | Digest, deterministic `fail`, or deterministic `blocked` |
| `workers.coding` | `false` | Or `{enabled: true, agent: codex, model: gpt-6.1-sol, reasoningEffort: high}`; requires coding workflow wrapper |
| `workers.review` | `false` | Must be false; not implemented |
| `merge.risk.enabled` | `false` | Risk-based auto-merge, see [merging](merging.md#risk-based-auto-merge); requires `merge.enabled` |
| `merge.risk.mode` | `enforce` | `enforce` gates merges by risk class; `observe` only classifies and shows |
| `merge.risk.autoMergeUpTo` | `medium` | Highest class the Factory merges on its own: `low`, `medium`, `high`; `critical` never |
| `merge.risk.aboveThreshold` | `approval` | `approval` asks for `/harness approve`; `block` leaves the merge to a person |
| `merge.risk.maxLowRiskLines`/`maxMediumRiskLines` | `300`/`800` | More changed lines make a change at least `medium`/`high` |
| `merge.risk.assessor` | `{provider: llm, model: gpt-6.1-sol, reasoningEffort: medium, timeoutSeconds: 90}` | AI assessor; `llm` follows `llm.provider`, a mock configuration fails closed (critical) |
| `merge.risk.guidance` | `null` | Trusted project hint for the assessor, at most 2000 characters |
| `merge.risk.areas` | `[]` | Up to 30 `{name, paths, class}` with relative globs (`*`, `?`, `**`); lower the class only when they cover every changed file, otherwise a minimum |
| `deploy.enabled` | `false` | Optional deployment of the default branch, see [deploy](deploy.md) |
| `deploy.trigger` | `checks` | `checks` (after `deploy.workflows` succeeded) or `push` |
| `deploy.workflows` | `[]` | CI workflow names; required for `checks` |
| `deploy.host`/`port`/`user` | `null` | Target; `null` uses `DEPLOY_HOST`/`DEPLOY_PORT` (22)/`DEPLOY_USER` |
| `deploy.path` | `/opt/app` | Absolute release root on the host |
| `deploy.composeFile` | `compose.yaml` | Compose file relative to the repository root |
| `deploy.project` | `null` | Compose project; default last path segment |
| `deploy.envFile` | `.env` | Host env file linked into each release; `null` disables |
| `deploy.healthcheck.url`/`timeoutSeconds` | `null`/`180` | Optional HTTP check on the host; wait timeout 10–900 |
| `deploy.rollback`/`keepReleases`/`timeoutMinutes` | `true`/`5`/`30` | Restart previous release on failure; releases kept 1–20; per-step timeout 5–60 |
| `deploy.githubDeployment` | `false` | Additional GitHub deployment record with outcome |
| `reporting.persistDecisions` | `true` | Deduplicated decision comments; execution intents/results and automatic block provenance always durable |

## Policy defaults

| Action | Advisory | Supervised | Autonomous |
|---|---|---|---|
| `transition` | deny | allow | allow |
| `close_issue` | deny | allow with verified proof | allow with verified proof |
| `create_followup` | deny | approval | allow |
| `prioritize` | deny | allow | allow |
| `approve_task` | deny | approval | allow |
| `start_worker` | deny | approval | allow |
| `retry_worker` | deny | approval per attempt | allow within retry cap |
| `cancel_worker` | deny | allow for overdue runs | allow for overdue runs |
| `expand_scope` | deny | approval | deny |
| `merge_pr` | deny | deny (override approval/allow) | deny (override allow) |

Overrides replace defaults; technical constraints remain. Advisory and global
disable are absolute zero-mutation boundaries even with an allow override. Dry
run evaluates but never executes. `expand_scope` gates a follow-up explicitly
marked `expandsScope=true`; standalone scope changes are unsupported. PR merging
requires the separate opt-in AI review workflow documented in [merging](merging.md).
`approve_task` marks a well-specified task ready; it never grants worker permission.

```yaml
autonomy:
  profile: autonomous
  overrides:
    create_followup: approval
    retry_worker: deny
    expand_scope: deny
```

Priority labels are `harness:priority-high`, `harness:priority-normal`,
`harness:priority-low`. Mock planning orders priority then issue number; OpenAI
may recommend a new priority or a necessary follow-up under the same policy.
