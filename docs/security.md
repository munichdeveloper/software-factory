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

Issue/PR text and comments are untrusted data. The planner has no API tools; plans
are schema validated and independently checked against policy, current facts,
concrete approvals and budgets. Trusted journal authors and native label timeline
events distinguish automatic block provenance from later human blocks.

Advisory, dry run, global disable, retry/action/parallelism limits, protected
branches and explicit denials remain active. Merge and standalone scope actions
remain unsupported. Audit logging may be disabled; recovery journals are mandatory.

Private Action access is limited by GitHub to permitted private repositories of
the owner. Public targets cannot consume this private distribution. Do not copy
an operator's PAT into target secrets merely to check out SF. The bundle is
generated deterministically and checked for drift in CI. Protect changes to SF,
its action, its bundle and its independent Harness pin together through review.

GitHub has no multi-operation transaction across comments, labels and dispatch.
An uncertain intent occupies a worker slot and is quarantined instead of blindly
redispatched. Recheck failures stop the run. This is duplicate prevention with
explicit recovery, not a claim of distributed exactly-once delivery.
