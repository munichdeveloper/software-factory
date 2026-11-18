# Self-hosted runners as a fallback (#110)

GitHub-hosted runners stay the default. When the account's Actions budget is used up, GitHub refuses every job in
private repositories before it starts ("The job was not started because recent account payments have failed or your
spending limit needs to be increased"); public repositories are not affected. The Factory can then move the jobs of
private repositories to its own runners on the runtime host and back once the new billing month starts.

## Runner selection

Every job that runs in an installed repository takes its runner from the repository variable `SF_RUNNER`:

```yaml
runs-on: ${{ vars.SF_RUNNER || 'ubuntu-latest' }}
```

This applies to the wrapper templates (`factory-manager.yml`, `factory-manager-coding.yml`, `factory-deploy.yml`) and
to the reusable workflows that installed repositories call (`coding-worker.yml`, `temporal-coding-executor.yml`,
`temporal-artifact-validator.yml`). In a reusable workflow `vars` are those of the calling repository. Without the
variable, or with it empty, nothing changes. `scripts/validate-workflows.ts` keeps every job of these files on this
expression.

A repository's own CI workflows (for example `test.yml`) need the same `runs-on` line to follow the switch.

| `SF_RUNNER`      | Jobs run on                                     |
| ---------------- | ----------------------------------------------- |
| unset or empty   | GitHub-hosted `ubuntu-latest`                   |
| `sf-self-hosted` | the Factory's runner pool on the runtime host   |

## Runner pool

The runtime host (`operations/temporal-runtime/compose.production.yaml`) runs two runner slots. Each slot is a
runner container (`operations/runner/Dockerfile`, the official `actions-runner` image) and its own Docker daemon
(`docker:dind`) sharing one network namespace, so jobs can use `docker`, `docker compose` and services on
`localhost` as on a hosted runner. Per slot the daemon is limited to 2 CPUs and 5 GB memory. The host has 4 CPUs and
16 GB; the runtime itself needs well under 4 GB. Two slots means at most two jobs at a time; further jobs wait in
GitHub's queue until a slot is free.

Runners are ephemeral just-in-time runners: each takes exactly one job and is then removed by GitHub. Between jobs
the slot wipes its workspace, temporary files and everything in its Docker daemon.

The Factory's coding job sets up its isolated coding account with `sudo` as on a hosted runner (Harness): it
bind-mounts the job's browser cache into the account's home and limits the account's egress with `iptables` owner
rules. The runner containers therefore have the capabilities `SYS_ADMIN` and `NET_ADMIN`, no AppArmor profile
(Docker's default profile denies `mount`) and `iptables` in their image. Between jobs the slot also removes the coding
accounts, what the job mounted into their homes and their egress rules; the rules live in the network namespace of
the slot's Docker daemon, which outlives the job.

### Hand-out

The runners hold no credentials. The broker, which has a GitHub App token per repository, writes a just-in-time
configuration (`generate-jitconfig`, label `sf-self-hosted`) into an idle slot's volume when a job with that label
waits in a switched repository. A slot is idle when it has neither a `jitconfig` nor a `busy` file. The runner marks
itself `busy`, reads and deletes the configuration, runs the job and clears `busy` again. Configurations already
handed out count against waiting jobs, so a job never gets two runners.

### Switching

The broker checks every registered **private** repository on its reconcile interval (`src/runtime/runners.ts`):

- **To the pool:** a job GitHub never started (completed with failure, no runner, no steps, within 30 seconds, not
  on `sf-self-hosted`) is how a used-up budget shows. The budget is account-wide, so the broker sets
  `SF_RUNNER=sf-self-hosted` in every private repository that does not have it, re-runs each refused run once and
  posts to Slack.
- **Back:** once a new UTC month has started since the variable was set, the broker deletes it again and posts to
  Slack. If the budget is still used up, the next refusal switches again.
- A value a person set to anything other than `sf-self-hosted` is never touched.

### Configuration

| Broker environment             | Meaning                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| `FACTORY_RUNNER_FALLBACK`      | `on` enables switching and hand-out; anything else disables it |
| `FACTORY_RUNNER_SLOTS_DIR`     | directory with one subdirectory per slot                       |
| `FACTORY_RUNNER_ALERT_CHANNEL` | Slack channel for switch notices (needs `SLACK_BOT_TOKEN`)     |
| `FACTORY_RUNNER_REPOSITORIES`  | extra private repositories outside the registry, `id:owner/name` |

The GitHub App needs, in addition to its usual permissions, **Administration: write** (just-in-time runners) and
**Variables: write** (`SF_RUNNER`). The broker requests these only in a separate token used for these two calls.

### Security

The Docker daemons run privileged and the runners can mount and change packet filter rules: a job can take over the
runtime host. The pool therefore only serves the account's own private repositories, never public ones or forks. The
runner network is separate from the runtime networks; the slot volume is the only thing the broker and runners share
and it only carries one-job configurations.
