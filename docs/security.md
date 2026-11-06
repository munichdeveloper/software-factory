# Security boundaries

- Issue/PR bodies, comments and future repository context are untrusted data,
  serialized as user input. Strict schema and independent policy validation are
  the execution boundary; prompt instructions alone are not.
- Only managed Issues are mutated. Native closing connections prove completion.
  Planners cannot assert execution/completion facts or increase permissions.
- Default-branch config and reviewed workflows are trusted policy. Workflow and
  runtime must use matching reviewed SHA pins. Third-party Actions are pinned.
  Lockfile installation disables lifecycle scripts.
- No target code is checked out or executed. No `pull_request_target` is used.
  PR CI has only contents-read and no API secrets.
- Manager has contents-read, issues-write, PRs-read, Actions-write. Worker has
  contents-read, issues-write and Actions-read; it receives no OpenAI secret.
  GitHub has no comment-only permission, so the worker token technically permits
  issue updates. The reviewed worker code publishes only results; never run
  untrusted application code in that privileged job.
- Machine authors are explicitly trusted. GitHub's bot identity is shared across
  repository workflows, so other issue-write workflows are in the same trust
  boundary. Restrict privileged jobs and protect config/workflows with rulesets
  and owner review. User text cannot impersonate a comment's actual author.
- Approvals use exact full-comment commands and current write/maintain/admin
  permission. IDs bind task text, complete config, payload and retry attempt.
  A ready label or generated approve_task proposal never grants worker permission.
  Workers recheck configuration identity and current approval before starting;
  queued work is cancelled if authorization changed after delegation.
- Caps, global disable and dry run apply in all profiles. Advisory prohibits all
  mutations. Unsupported actions cannot be enabled through overrides.
  Bootstrap also skips all mutations in advisory and dry-run modes.
- Logs omit secrets, issue text, raw request errors and provider response bodies.
  Job-summary text is escaped. Provider requests use a fixed HTTPS OpenAI endpoint;
  there is no configurable credential-exfiltration URL.

Scope classification is semantic and can be mistaken. Explicit scope expansion
is separately gated, but the model's classification is not a proof. Keep follow-up
creation behind approval when strict mandate review is needed. Never put secrets
in tasks: descriptions intentionally persist as worker input and may enter LLM
context.

Read probes validate Issues, contents, PR and Actions access. GitHub exposes no
universally available non-mutating token-permission introspection across all
token types. Missing write permission fails closed at the first journal,
bootstrap or dispatch operation; CLI diagnostics name required scopes and never
print request objects. Organization policies and branch rules remain authoritative.
