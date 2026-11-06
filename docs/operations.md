# Operations and recovery

Bootstrap, then schedule/manual manager runs. Supervised workers require the
exact approval command from a decision or summary. `factory.enabled: false` on
the default branch prevents further activity; separately cancel already-running
Actions for immediate termination. Manual dry_run previews one manager run.

Keep the wrapper filename/config and `Factory worker <executionId>` run name
stable. Intents/results must remain in Issue comments; artifacts are optional.
An explicitly applied blocked label stays blocked until it is cleared, including
when dependencies are closed. Automatic blocks have a mandatory `block_intent`
record tied to the first native blocked-label change after that record's event
boundary. Specification/dependency blocks clear when their condition is fixed;
dispatch quarantine clears when the original execution resolves. This recovery
does not depend on `reporting.persistDecisions`. A later remove/reapply is a new
block and never inherits an older automatic origin, even for the same actor.
Unknown/legacy block provenance is treated as explicit and requires manual clearing.

| Failure | Recovery |
|---|---|
| API failure before intent | Retry manager; no worker has been dispatched |
| Crash after intent/dispatch | Match actual runs by execution ID; never blindly dispatch twice |
| Run not yet visible | Intent occupies a slot during visibility grace |
| No run after grace | Block uncertain execution; investigate manually |
| Run exceeds timeout | Cancel overdue run; wait for completion before retry |
| Completed run without result | Treat failed/cancelled; bounded separately approved retry |
| Failed result | Failed lifecycle; propose next concrete attempt |
| Success | Awaiting-pr; digest is not application implementation |
| Task changed before worker | Publish cancelled result for stale input |
| Native Issue closed | Done label; never automatically reopen |
| LLM failure/invalid output | Deterministic reconciliation continues |

Completed runs without a worker callback are recorded as durable terminal
results by an allowed manager transition, so later Actions-run retention expiry
does not turn a known failure into an uncertain dispatch.

## Uncertain dispatch

Dispatch and comment persistence are not a transaction; GitHub provides no
caller-supplied dispatch idempotency key. Automatic retry after an ambiguous
network failure cannot guarantee exactly once. This MVP keeps uncertain intents
active, preferring duplicate prevention over automatic liveness.

1. Inspect queued, pending and completed runs for the exact execution run name.
   A later manager automatically recovers when the run becomes visible.
2. Only after establishing there is no worker (including delayed delivery), an
   administrator may manually dispatch worker mode with the **original** execution
   ID and Issue number. A trusted intent is required. Identical IDs serialize;
   a durable result makes later duplicate invocations no-ops. Never create a new
   competing intent or delete the old one to bypass uncertainty.
3. To abandon work, disable the harness, cancel applicable runs and administratively
   resolve the task. Do not silently mark an uncertain execution failed and retry.

## Practical limits

- Install one canonical wrapper. It serializes manager/bootstrap runs. Local
  writes must not overlap it. GitHub has no compare-and-swap transaction across
  labels/comments/dispatches. Fresh snapshots and task-version checks reduce
  races, but a human label edit in the final REST update window can race. The
  implementation preserves all unrelated labels present in its final read; it
  does not claim a distributed transactional lock.
- Issues/comments/PRs paginate for correctness; only selected tasks reach the
  LLM. Large repositories can hit API limits and should retry later. More than
  100 closing links on one PR fails closed, never truncates proof. GitHub caps
  filtered run search results; old results remain durable in comments, while an
  unresolved missing run becomes uncertain rather than redispatched.
- Preserve the journal. Administrators can delete comments or alter trusted
  workflows; admin tampering is outside the persistence guarantee.
- Reusable workflow access, organization policies, registered default-branch
  wrapper and available compatible OpenAI model/secrets are installation
  dependencies. Mock mode requires no paid API access.

## Releases

After review, merge and tag the intended commit `v0.1.0` through normal repository
release procedures. Resolve the release tag to its SHA and install both pins at
that SHA. Upgrades require review of workflow/runtime/config changes and both
pin updates, validation and dry run. Merging and release publication are not
performed automatically by this implementation task.
