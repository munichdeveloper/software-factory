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
| `autonomy.startGrant` | `ready-label` | Repositories the SF Manager registered: `ready-label` starts a run only on `harness:ready` applied by a person with write access; `managed-label` takes `harness:managed` applied by a person with write access as the grant, and follow-ups the Factory creates inherit their origin's grant (at most three levels); `none` needs no grant, every managed runnable task starts within the policy and execution limits. Labels can only be set by people with write access either way. Switching back to `ready-label` does not turn a `harness:ready` the Factory applied meanwhile into a grant |
| `execution.dryRun` | `false` | Evaluate without writes/dispatch; manual dry-run also enables this |
| `execution.maxParallelWorkers` | `1` | Active/uncertain executions, including old task versions, 1–20 |
| `execution.maxRetries` | `2` | Retries after initial attempt, 0–5; separately approved per attempt. A start the runtime refused before it ran does not count |
| `execution.maxNewIssues` | `3` | Follow-ups created/run, 0–20 |
| `execution.workerTimeoutMinutes` | `30` | Worker cap, 1–30; overdue active runs cancelled before retry |
| `execution.dispatchGraceMinutes` | `10` | Actions visibility grace, 1–60; expiry quarantines uncertain intents |
| `execution.rework` | `false` | Temporal coding with independent validation only: a failed validation, or a merge review that asks for changes to a validated pull request, starts a further attempt within `maxRetries` instead of waiting for a person. Enable only after the executor release that fetches task context is rolled out. With rework off, such a pull request is labeled `sf:needs-human` (and announced with `notifications.slack.events.handover_required`); Independently of rework, commits that accounts with write access push onto a Factory pull request after publication are adopted: the new head goes through the required checks, the validation workflow and a new review. Commits from other accounts, or a rewritten history, are still refused |
| `workers.coding.loopback` | `false` | Temporal executor only: the worker's commands may bind and connect on a private loopback interface (local server, browser tests) and get the locked Playwright browser; all other network stays closed. Needs the executor release that supports it |
| `monitoring.enabled` | `true` | Temporal: the broker's sanity check of this repository's runs after each reconciliation (no extra GitHub requests). The whole `monitoring` section is optional and leaves the configuration hash unchanged while absent |
| `monitoring.stuckRunMinutes` | `60` | A run still active this many minutes after its worker timeout is reported as stuck, 5–1440 |
| `monitoring.approvalWaitHours` | `48` | A run waiting at its approval gate this long is reported, 1–720 |
| `monitoring.repeatedFailures` | `3` | This many attempts in a row ending with the same error code are reported as an endless retry, 2–20 |
| `monitoring.stalledPasses` | `10` | Consecutive reconciliations a status label may differ from the derived status, or reconciliations may fail or report errors, before it is reported, 2–200 |
| `workers.coding.maxCostUsd` | none (broker uses `10`) | Spend cap per coding attempt in US dollars, Temporal engine: Claude Code stops at it (`--max-budget-usd`, result `error_max_budget_usd`); Codex has no cap. Fixed per execution when it is first dispatched. Usage of every run is recorded and reported, see [Temporal runtime](temporal-runtime.md) |
| `workers.coding.smallPullRequests` | `true` | Tells the coding worker to keep each change to the task's one concern (no drive-by refactoring, renaming or unrelated fixes) and, for a task that bundles several concerns or is too large for one reviewable change, to report `blocked` with a proposed split instead of one large PR; the planner cuts follow-ups to one concern each. Fixed per execution when it is first dispatched. Risk-based merging (`merge.risk`, more than 800 changed lines are at least `high`) stays the hard limit |
| `monitoring.slack` | `true` | Posts new and resolved findings to Slack with the broker's bot (`SLACK_BOT_TOKEN`), one message per reconciliation that changed something, at most once |
| `monitoring.channel` | `null` | Slack channel for findings; `null` uses `notifications.slack.channel` where `notifications.slack.enabled`, otherwise nothing is posted |
| `llm.provider` | `static` | `static`: deterministic planner without a model (every startable issue by priority label, then issue number); `openai`: real Responses API. The former name `mock` is still accepted and read as `static`; `jev`: see [Jev planner](#jev-planner) |
| `llm.model` | `gpt-4.1-mini` | Explicit provider model string; account must have access |
| `llm.reasoningEffort` | `null` | Omit capability, or `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; must match model |
| `llm.maxOutputTokens` | `4000` | Output cap, 256–16000 |
| `llm.timeoutSeconds` | `60` | Per call timeout, 1–120 |
| `llm.maxCalls` | `1` | Total calls incl. retries, 0–3; zero disables semantic planning only |
| `workers.test.enabled` | `true` | Bundled non-code-changing worker |
| `workers.test.operation` | `sha256` | Digest, deterministic `fail`, or deterministic `blocked` |
| `workers.coding` | `false` | Or `{enabled: true, agent: codex, model: gpt-6.1-sol, reasoningEffort: high}`; requires coding workflow wrapper. `agent: claude` runs Claude Code instead (Temporal engine only): name a Claude `model` such as `claude-opus-5-5` or `claude-sonnet-5-5`, `reasoningEffort` `low`…`max`, and set the repository secret `ANTHROPIC_API_KEY` instead of `OPENAI_API_KEY`. `agents` (instead of `agent`, Temporal engine only) is a priority list of up to three agents, each `{agent, model, reasoningEffort}`: see [Agent priority list](#agent-priority-list). `retryAgents` (optional, same shape) is the list for attempts after the agent failed: see [Escalation on retry](#escalation-on-retry). An entry may add `credential: subscription` to run on a Claude subscription: see [Claude subscription as fallback](#claude-subscription-as-fallback) |
| `workers.review` | `false` | Must be false; not implemented |
| `merge.checkRun` | on | Shows the merge pass as the check run `Software Factory / Merge` on each pull request, see [merging](merging.md#check-run-on-the-pull-request); needs the App permission Checks write; optional, leaving it out keeps the configuration hash |
| `merge.risk.enabled` | `false` | Risk-based auto-merge, see [merging](merging.md#risk-based-auto-merge); requires `merge.enabled` |
| `merge.risk.mode` | `enforce` | `enforce` gates merges by risk class; `observe` only classifies and shows |
| `merge.risk.autoMergeUpTo` | `medium` | Highest class the Factory merges on its own: `low`, `medium`, `high`; `critical` never |
| `merge.risk.aboveThreshold` | `approval` | `approval` asks for `/harness approve`; `block` leaves the merge to a person |
| `merge.risk.maxLowRiskLines`/`maxMediumRiskLines` | `300`/`5000` | More changed lines make a change at least `medium`/`high` |
| `merge.risk.maxMediumRiskFiles` | `100` | More changed files make a change at least `high`; optional, leaving it out keeps the configuration hash |
| `merge.risk.assessor` | `{provider: llm, model: gpt-6.1-sol, reasoningEffort: medium, timeoutSeconds: 90}` | AI assessor; `llm` follows `llm.provider`, a static configuration fails closed (critical) |
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
| `deploy.secrets` | `{}` | Application secrets from GitHub: `NAME: SECRET_NAME`; the SF Manager renders them into the wrapper's `deploy-env` (0.12.0, see [deploy](deploy.md#declared-in-the-configuration-deploysecrets-0120)) |
| `router` | absent | Model router (0.16.0): a decision model picks model and effort per call among the candidates of each purpose, see [Model router](#model-router) |
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
`create_followup` answers a finished attempt: it is allowed only when the task's
latest attempt reported `blocked` or `success`, and not while a follow-up of the
task (`Origin: #n`) or a pull request of the task is still open, except for
further parts of a split proposed in the same run. A task that has not run, or whose run failed, is started or
retried itself, never copied. Fields of another operation in a planner proposal
(for example `status` on `start_worker`) are dropped before the policy decides.

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

## Agent priority list

```yaml
workers:
  coding:
    enabled: true
    agents:
      - agent: claude
        model: claude-opus-5-5
        reasoningEffort: high
      - agent: codex
        model: gpt-6.1-sol
        reasoningEffort: high
```

Neither Anthropic nor OpenAI publishes the remaining prepaid credit of an API key. Before each coding run the
executor's `validate` job therefore sends each agent's provider a minimal request (a few tokens, a fraction of a cent)
with the repository's key and the agent's model, in list order, and runs the first agent that can be used:

| Provider answer | Result |
| --- | --- |
| success, rate limit, overload, network error | the agent runs (a transient failure is the agent's to retry) |
| Anthropic `credit balance is too low`, HTTP 402, or the spend cap `enforced_spend_limit_reached`; OpenAI `insufficient_quota` | used-up credit: the next agent is tried |
| no key (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` missing) or a refused key (401/403) | the next agent is tried |

The choice is uploaded as the artifact `coding-agent-<executionId>`; the broker names the agent that ran in the commit
and PR title. When no agent can run the run fails without spending an attempt. With `FACTORY_CREDIT_ALERT_CHANNEL`
set, the broker posts a Slack message for each agent skipped for used-up credit, at most three times per agent; once
that agent has run again, a later shortage is announced anew. Each repository needs the secret of every agent in its
list. A single `agent` keeps the earlier behaviour without any check.

### Claude subscription as fallback

```yaml
    agents:
      - agent: claude
        model: claude-sonnet-5-5
        reasoningEffort: medium
      - agent: claude
        model: claude-sonnet-5-5
        reasoningEffort: medium
        credential: subscription
```

An entry with `credential: subscription` (agent `claude` only, never first in `agents` or `retryAgents`) runs Claude
Code with the OAuth token of a Claude Pro/Max subscription instead of the API key, for example when the API credit is
used up. Create the token once with `claude setup-token` and store it as the repository secret
`CLAUDE_CODE_OAUTH_TOKEN` (the SF Manager checks it like the API keys). Its credit check is one print-mode call of the
pinned Claude Code in the `validate` job: an HTTP 429 means the subscription's 5-hour or weekly limit is reached, 401/403
a token that no longer works; either way the next agent is tried. The harness hands the token only to its credential
proxy (dev-agent-harness#16); the worker sees a placeholder, and GitHub masks the secret in logs.

The subscription shares its limits with the owner's own Claude use, so the broker takes at most
`FACTORY_SUBSCRIPTION_MAX_RUNS_PER_DAY` runs on it in any 24 hours across all repositories (deploy variable, default
6; finished runs count). At the cap the entry is left out of new requests and Slack hears it once a day. With
`FACTORY_CREDIT_ALERT_CHANNEL` every run the subscription takes over is announced. Its usage is stored with
`billing = subscription`: `cost_usd` is Claude Code's list-price estimate, left out of the daily spend threshold and
listed separately in the daily report. Check the subscription's terms before using it for unattended runs.

## Escalation on retry

```yaml
workers:
  coding:
    enabled: true
    agents:
      - agent: claude
        model: claude-sonnet-5-5
        reasoningEffort: medium
      - agent: codex
        model: gpt-6.1-sol
        reasoningEffort: high
    retryAgents:
      - agent: claude
        model: claude-opus-5-5
        reasoningEffort: high
      - agent: codex
        model: gpt-6.1-sol
        reasoningEffort: high
```

The first attempt of a task runs the `agents` list. A further attempt runs `retryAgents` instead (with the same
credit check and fallback) once an earlier attempt of the same task version failed for a reason the agent owns: a
rework after a failed validation or a merge review's requested changes, or a failed, blocked, cancelled or timed-out
agent run. A retry after the runner failed before the agent started (`EXECUTOR_INFRASTRUCTURE_FAILURE`, e.g. a setup
step) keeps `agents`, since a stronger model would not change that outcome. The Manager marks an escalated intent with
`urn:sf-escalate`. Most tasks then cost the cheaper model, and only those the agent could not finish escalate.
`retryAgents` is optional without a default: a configuration without it keeps its hash and every attempt uses `agents`.
Each repository needs the secret of every agent in both lists.

## Model router

```yaml
router:
  enabled: true                 # default true
  model: typesafe/jev-1.14      # decision model (default; jev-1.14.0 at TypeSafe)
  minConfidence: 0.5            # minimum probability of Jev's choice; below it the configured models run
  timeoutSeconds: 10
  coding:                       # first attempts of coding runs (Temporal engine)
    candidates:
      - id: sonnet-medium
        agent: claude
        model: claude-sonnet-5-5
        reasoningEffort: medium
        description: Clearly specified, contained changes in one area; bug fixes, small features, texts, tests.
      - id: opus-high
        agent: claude
        model: claude-opus-5-5
        reasoningEffort: high
        description: Changes across several modules, new architecture, migrations, security or hard debugging.
  review:                       # merge review; likewise risk (assessment) and planner (llm.provider openai)
    candidates:
      - id: sonnet-medium
        provider: claude
        model: claude-sonnet-5-5
        reasoningEffort: medium
        description: Small pull requests with few files and a clear purpose.
      - id: opus-high
        provider: claude
        model: claude-opus-5-5
        reasoningEffort: high
        description: Large pull requests, security-relevant or behaviour-changing code.
```

Before a model does the work, the broker asks the decision model TypeSafe Jev one choice question. Since 0.17.0 it asks
TypeSafe directly (`POST https://api.typesafe.ai/v1/systemone`, broker key `TYPESAFE_API_KEY`, deploy secret
`BROKER_TYPESAFE_API_KEY`) or through OpenRouter (Decisions API `POST /api/alpha/decisions`, `OPENROUTER_API_KEY`, deploy
secret `BROKER_OPENROUTER_API_KEY`). The broker setting `FACTORY_ROUTER_API` (`typesafe` or `openrouter`) chooses; without
it a TypeSafe key wins. `router.model` keeps OpenRouter's id: for TypeSafe, `typesafe/jev-1.14` becomes `jev-1.14.0`,
and TypeSafe's own names (`jev-latest`, `jev-preview`) pass unchanged. The question: the options are the candidates' ids with their descriptions, the
state is the request in short (a coding task's description and acceptance criteria; a pull request's title, body and
file list with changed lines, never its patches). Jev answers with a choice and a probability per candidate; the chosen candidate
then does the actual work with the same instructions, input and schema as the configured model, only model and effort
differ. A routed coding agent runs first, the configured `agents` stay behind it as the credit fallbacks; the decision
is stored per execution, so later polls send the identical request. Escalated attempts are not routed: they run
`retryAgents`. Broker-side candidates run with the broker's keys: `provider: claude` needs its Anthropic key, `openai`
its OpenAI key; a candidate that cannot run, or fails, falls back to the configured chain (Claude first, OpenAI second).
A static configuration (`provider: llm` with `llm.provider: static`) is never routed. A purpose without `candidates` is not
routed, and each purpose takes 2 to 6 candidates with unique ids; the candidates are also the floor, so leave out cheap
options where a cheap answer is not acceptable (e.g. no `low` effort for reviews).

The router never blocks. Without the broker's key for the chosen endpoint (deploy secrets in the environment
`production`), when Jev is unreachable or answers something unusable, and when the probability of its choice stays below
`minConfidence`, the configured models run as before. Since 0.17.1 `minConfidence` is compared with the probability Jev
gives its choice, not with TypeSafe's `confidence` ((p − 1/n) / (1 − 1/n), 0 for an even split): with two candidates a
66 % lean is only 32 % confidence. With two candidates the default 0.5 therefore always follows Jev's lean; set e.g.
0.65 to follow only clear leans. Since 0.16.1 the task's status comment names the agent of its
coding run (`**Model:**`, chosen by the router or the configured agents and why), and the merge review and risk
comments name the model that did the review (`Modellwahl: …`). Each decision is also logged as one `factory-router` line (purpose,
choice, confidence or reason and a fixed code). With `FACTORY_ROUTER_ALERT_CHANNEL` on the broker, every decision Jev made
goes to Slack (since 0.17.2: purpose, repository, chosen candidate with agent, model and effort, probability), and every
case in which the configured models ran instead too, at most once per repository, purpose and reason every six hours; the
next message counts the cases in between. Issue and pull request text reaches Jev as untrusted data it only classifies:
at worst it picks another of the configured candidates. `router` is optional without a default: a configuration without
it keeps its hash.

## Jev planner

`llm.provider: jev` (broker, Temporal engine; elsewhere it plans like `static`) keeps the static planner's selection of
startable tasks and lets TypeSafe Jev, the model router's decision model, make two decisions on them:

- **Start order.** When more tasks are startable than worker slots are free (`execution.maxParallelWorkers`), Jev is
  asked which task to implement first (at most 16 options). Its probabilities rank the tasks; a priority label
  (`harness:priority-high` / `-low`) still comes first.
- **Start readiness.** Before a task starts, Jev classifies its text as `ready`, `unclear` or `too-large`. An unclear or
  too large task is not started; the planner blocks it for its current text, and the status comment says so. A revised
  text lifts the block and is judged again; a person who removes `harness:blocked` starts it as it is. Readiness is
  asked for at most two tasks beyond the free slots per reconciliation.
- **Risk isolation (SF #210).** With risk-based merging enforced (`merge.risk.enabled`, `mode: enforce`) readiness has a
  fourth verdict, `mixed-risk`: the task mixes a risky part (authentication, permissions or roles, money, data
  migrations) with routine work. A text model (Claude first, OpenAI second, model and effort of `merge.risk.assessor`)
  then writes two follow-up tasks, a routine part that merges automatically and a small risky part that a person
  approves, and the original task is blocked as their origin. If the model finds the parts inseparable, the task starts
  as it is; if it fails, the task is blocked with the reason. The parts themselves are never split again.

Jev's settings come from the `router` block (`enabled`, `model`, `minConfidence`, `timeoutSeconds`; no candidates
needed). Without the broker's Jev key, when Jev is unreachable, gives no usable answer or stays below
`router.minConfidence`, the static plan runs. Answers are kept per task version and per set of candidates, so Jev is
asked when something changed, not on every reconciliation. Each decision is logged (`factory-router`, purpose
`planner`) and reported to the router's Slack channel like other routing decisions.

