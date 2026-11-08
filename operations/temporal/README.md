# Temporal backup and monitoring – WF-06B

Prepared implementation; disabled until the reviewed restricted access and maintenance behavior are approved. This is an addition to the evidence in [PR #15](https://github.com/munichdeveloper/software-factory/pull/15), not a claim that WF-05/06 are done. No code or credential is installed by merging this PR. No application repository is deployed by the checks.

## Accepted settings

- At least daily backup; target RPO at most 24 hours, target RTO four hours.
- Transfer sealed archives to the user's computer. Start a backup at 20 hours age to leave a four-hour margin before the 24-hour stale-backup alert.
- Portable `age` encryption, public recipient only on the VPS; recovery identity separately held by the user. Existing Windows DPAPI copy can coexist.
- Slack `#notifications`, channel `C0A5XUJFZPF`. Supersedes the earlier email destination; Gmail calls failed and sent no email.
- No backup deletion or retention pruning. Retain all copies for this initial phase; capacity policy must be reviewed before unattended long-term operation.

## Access awaiting approval

Use a dedicated SSH key, `restrict`, and one root-owned forced command:

```text
restrict,command="/usr/bin/python3 -E -s /docker/sf-temporal/ops/backup_command.py" ssh-ed25519 APPROVED_PUBLIC_KEY
```

The key cannot open a shell, execute arbitrary commands, select files/recipients, forward ports, request a PTY or use SFTP/SCP. Its command parser accepts exactly `status`, `snapshot`, or `fetch YYYYMMDDTHHMMSSZ-xxxxxxxx`. The implementation never interprets this input as shell code. `fetch` exposes only an already sealed snapshot with a valid manifest. Neither the age recovery identity nor a Slack token is installed on the VPS or passed to Temporal workers.

The command runs as root so it can invoke the existing Docker project and read its private runtime configuration. Approval must include the real effect of `snapshot`: pause only the `sf-temporal` worker and Temporal services, dump the two databases, resume these services, then seal the archive. PostgreSQL and the VPS itself are not stopped. The helper attempts service resumption on any dump/stop failure and never accepts an arbitrary project. The existing snapshot operation and all new artifacts remain within `/docker/sf-temporal`. A failed health precondition blocks the snapshot before pausing services.

## Installation after approval

1. Keep the original service/container and SSH state available for rollback. Stage `backup_command.py`, `protocol.py`, `health.mjs`, public `recipient.txt`, and the pinned Linux age executable under `/docker/sf-temporal/ops`. Root owns this directory (0700), scripts/recipient (0600), `health.mjs` (0644), and the executable (0755). No group/world-writable file is accepted. Mount only `health.mjs` in the unprivileged metrics probe.
2. Use age **1.3.2** from the [official release](https://github.com/FiloSottile/age/releases/tag/v1.3.2). Linux AMD64 tar.gz SHA-256: `cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10`; Windows AMD64 zip: `f48d8f8f9ebe903ab5027ed067652f2cc1db94bc206976430133b905dcd8e8c7`. Verify before extraction/execution. The reviewed package contains source hashes and the specific approved public key; never substitute a key from repository content automatically.
3. Append the reviewed forced-command key while preserving all other SSH entries. Pin existing host keys locally; the client requires strict host checking and batch mode. Do not disable SSH verification.
4. Populate the absolute local paths and public recipient in `config.json`. Protect the local SSH identity with the user's ACL; it is a different key from the offline age recovery identity.
5. With the local scheduler still paused, run one explicit snapshot and transfer, decrypt a copy with the separately held recovery key, and perform the isolated open-gate restore drill. Inspect recovery of original source services. Only then set `enabled: true` and activate the prepared scheduled task.

## Collector and alarm delivery

Run `python client.py --config ABSOLUTE_CONFIG_PATH`. One local run lock prevents overlap. State and receipts use atomic replacement and fsync. Disabled configuration performs no remote operation. No blind retry of SSH mutations occurs. A fresh remote manifest is reused after an uncertain/lost local snapshot receipt; transfer succeeds only on the approved recipient, complete length, age header and SHA-256. Partial downloads are not promoted and existing mismatched archives are not overwritten.

The collector examines source Docker states, the authenticated HTTPS boundary (anonymous 401 plus Basic challenge), Temporal availability, pending task age over five minutes, activity attempts of three or more, and recent workflow timeouts. Temporal SDK 1.25.0 is supplied by the existing pinned PoC worker image. Open PINNED deployment versions are reported; explicit per-deployment retirement protection and poller availability remain WF-05A. Human Gate age itself is not an error.

The scheduled agent reads `pendingDeliveries`, posts only stable alert codes and delivery IDs to the fixed Slack channel, then acknowledges the returned permalink using `--ack DELIVERY_ID --permalink SLACK_LINK`. It does not post raw status responses, histories, configuration, credentials or archive data. Continuing conditions reuse one delivery ID. Recovery generates one separate notification after a sent incident. A send with an unknown result must be marked `--unknown DELIVERY_ID`; reconcile its unique `sf-alert:ID` marker in Slack before any further send. Missing evidence is not permission to blindly resend. An obsolete incident that was never sent is cancelled.

The schedule is outside Temporal. Local-file tasks still require the computer to be awake, connected, and the app running. A sleeping/offline laptop cannot observe or alert on its own outage; an independent always-on observer is a remaining reliability gap. Thus these settings are operational targets, not a demonstrated 24-hour RPO/four-hour RTO guarantee. No monthly restore or key-custody success is claimed until actually verified. Keep WF-06B open until those activation and monitoring checks pass.

## Verification

`python -m unittest discover -s operations/temporal -p 'test_operations.py' -v` covers command injection/traversal denial, service/Temporal failure, missing/stale/future backup, queue/retry/timeout thresholds, alert dedup/recovery/ambiguous delivery, manifest correlation, atomic transfer, corrupted transfer refusal, reuse after lost receipt, and source resumption after a failed dump. Docker and SSH effects are isolated test doubles; this suite is not a live deployment test. The portable cipher also has separate real age decrypt, wrong-key and tamper tests in the local evidence. The review package and live Slack test link provide the current results.
