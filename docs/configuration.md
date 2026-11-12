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
