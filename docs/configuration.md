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
| `llm.provider` | `mock` | Deterministic mock or real `openai` Responses API |
| `llm.model` | `gpt-4.1-mini` | Explicit provider model string; account must have access |
| `llm.reasoningEffort` | `null` | Omit capability, or `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; must match model |
| `llm.maxOutputTokens` | `4000` | Output cap, 256–16000 |
| `llm.timeoutSeconds` | `60` | Per call timeout, 1–120 |
| `llm.maxCalls` | `1` | Total calls incl. retries, 0–3; zero disables semantic planning only |
| `workers.test.enabled` | `true` | Bundled non-code-changing worker |
| `workers.test.operation` | `sha256` | Digest, deterministic `fail`, or deterministic `blocked` |
| `workers.coding` | `false` | Must be false; not implemented |
| `workers.review` | `false` | Must be false; not implemented |
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
| `merge_pr` | unsupported | unsupported | unsupported |

Overrides replace defaults; technical constraints remain. Advisory and global
disable are absolute zero-mutation boundaries even with an allow override. Dry
run evaluates but never executes. `expand_scope` gates a follow-up explicitly
marked `expandsScope=true`; standalone scope changes and all merges are unsupported.
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
