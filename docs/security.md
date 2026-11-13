# Security boundary

SF credentials are scoped to the target repository: contents-read, issues-write,
PRs-read and Actions-write. They are used only by SF's reviewed bundled code.
The OpenAI key belongs to SF planning; worker mode receives an empty planner key.
The Harness subprocess inherits only OS temporary-directory/SystemRoot variables,
never GitHub/OpenAI credentials, NODE_OPTIONS or arbitrary caller environment.

No target application code is checked out or executed. Worker mode checks out
only the SHA-pinned public Harness, disables credential persistence and installs
locked dependencies with lifecycle scripts disabled. Runtime handlers are trusted
code, not dynamically loaded repository files. Incoming CI has contents-read only.

Issue/PR text and comments are untrusted data. Applying `harness:managed` (and, under
Temporal, `harness:ready`) approves the title and body as they are at that moment. An issue
author keeps edit rights, also on public repositories, so SF reads the native title changes and
body revisions of every managed issue. A change after the latest approval by an account without
write access withdraws it: the Manager removes `harness:managed` and `harness:ready` and explains
why, the policy denies every action except cancelling a worker, a ready grant is refused with
`READY_CONTENT_CHANGED`, and the merge pass does not merge a Factory PR of such a task. Changes by
people with write access keep the approval. A maintainer re-approves by applying `harness:managed`
again after reading the new text. An unreadable edit history fails the run instead of being
treated as unchanged. The planner has no API tools; plans
are schema validated and independently checked against policy, current facts,
concrete approvals and budgets. Trusted journal authors and native label timeline
events distinguish automatic block provenance from later human blocks.

Advisory, dry run, global disable, retry/action/parallelism limits, protected
branches and explicit denials remain active. Merge and standalone scope actions
remain unsupported. Audit logging may be disabled; recovery journals are mandatory.

SF was made public with owner approval for its v0.1.0 release. Public and private
targets can use its SHA-pinned Action, subject to their Actions policies. No
cross-repository PAT is necessary. The bundle is
generated deterministically and checked for drift in CI. Protect changes to SF,
its action, its bundle and its independent Harness pin together through review.

GitHub has no multi-operation transaction across comments, labels and dispatch.
An uncertain intent occupies a worker slot and is quarantined instead of blindly
redispatched. Recheck failures stop the run. This is duplicate prevention with
explicit recovery, not a claim of distributed exactly-once delivery.
