# Migrating the former combined Harness installation

Disable the old manager schedule and wait for active jobs to end. Keep the
existing wrapper filename while unresolved delegations remain: run recovery reads
that workflow's history. Replace its implementation with the new SF template,
retaining the filename in `manager.workflow`. Use the new concurrency group only
after old runs have ended, so old/new managers cannot overlap.

Copy `.github/harness.yml` to `.github/software-factory.yml`, replace its top-level
`harness` section with `factory`, and set `manager.workflow` to the retained
wrapper filename (or `factory-manager.yml` for a new installation). Preserve
scope, autonomy, trusted actors and limits. Pin SF and Harness independently.
Configuration changes invalidate old action approvals; review and approve the
new concrete IDs rather than copying approvals.

Do not rename/delete existing `harness:*` labels or journal comments. SF recognizes
legacy journals and run names. Existing results remain usable; an unresolved
dispatch without visible history is quarantined, never automatically redispatched.
No migration script mutates production repositories automatically.

Worker delegation/result envelope 1.0 is SF-owned storage. The external Harness
request/result contract is 2.0 with opaque task identifiers and no GitHub API or
Factory actions. The adapter converts between these contracts explicitly.
