# Deployment after pushes (docker-ssh)

SF v0.5 can deploy the default branch to a Docker host over SSH, for example a
Hostinger VPS with Docker. It is disabled by default and independent of planning,
workers, merging and notifications: none of them changes behaviour.

## Flow

1. A push to the default branch triggers either directly (`trigger: push`) or,
   by default, after the listed CI workflows succeeded (`trigger: checks`).
2. SF deploys only the **current head** of the default branch. An older commit is
   skipped (`superseded`) because the newer commit's own run deploys it. With
   `checks`, every listed workflow must have succeeded for exactly that commit.
3. The wrapper checks out that commit; `git archive` (tracked files only, no
   `.env` or build output) is streamed over SSH to `<path>/releases/<sha>`.
4. On the host: the env file `<path>/.env` is linked into the release, then
   `docker compose --project-name <project> up --detach --build --remove-orphans --wait`
   starts it with `SF_RELEASE_SHA` set to the release commit, so the compose file can pass it on as a
   build argument or image label. Healthchecks defined in the compose file must pass; optionally an
   additional HTTP check (`healthcheck.url`) runs on the host.
5. Success switches the `<path>/current` link, keeps `keepReleases` releases and
   prunes dangling images of the project. Failure prints recent container logs and,
   with `rollback: true`, starts the previous release again. The job then fails.

Deployments are serialized (wrapper concurrency plus a `flock` on the host). The
Compose project name stays fixed across releases, so named volumes keep their data.
If the application already runs on the host, set `project` to its existing Compose
project name (by default the directory it was started from), otherwise Docker
creates new, empty volumes.

## Host setup (Hostinger VPS)

```sh
# as root on the VPS (Ubuntu with Docker, e.g. Hostinger's Docker template)
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
mkdir -p /opt/backofficer && chown deploy:deploy /opt/backofficer
# copy the application's .env to /opt/backofficer/.env (owner deploy, mode 600)
```

Docker Compose v2.21 or newer is required (`docker compose version`). Membership
in the `docker` group is equivalent to root access on the host: use a dedicated
VPS or user for the application. Allow SSH in the Hostinger firewall; keep
application ports bound to 127.0.0.1 behind a reverse proxy where possible.

Create a dedicated key pair and pin the host key (no trust on first use):

```sh
ssh-keygen -t ed25519 -N "" -C "github-deploy" -f deploy_key
ssh-copy-id -i deploy_key.pub deploy@VPS_HOST
ssh-keyscan -t ed25519 VPS_HOST          # with a custom port: ssh-keyscan -p PORT VPS_HOST
```

Compare the scanned fingerprint with the one shown in the Hostinger panel or on
the VPS console (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`).

## Repository setup

Install the wrapper, e.g. only deployment without the planning manager:

```sh
npx tsx scripts/install.ts --directory TARGET --ref FULL_FACTORY_COMMIT_SHA --no-manager \
  --deploy --deploy-after "Application checks" --deploy-path /opt/backofficer
```

Existing files are preserved; add the `deploy` section from
`templates/software-factory.yml` and `templates/factory-deploy.yml` manually when
upgrading. Then add secrets to the GitHub environment (default `production`) or
the repository:

| Secret / variable | Content |
|---|---|
| `DEPLOY_SSH_KEY` | Private key (`deploy_key`), unencrypted |
| `DEPLOY_KNOWN_HOSTS` | Output of `ssh-keyscan` |
| `DEPLOY_HOST` | VPS host name or IP (secret or variable), unless `deploy.host` is set |
| `DEPLOY_USER` | SSH user (secret or variable), unless `deploy.user` is set |
| `DEPLOY_PORT` | Variable, optional (default 22), unless `deploy.port` is set |

Until key, host key, host and user exist the deployment is skipped with a
warning instead of failing. Environment protection rules (required reviewers,
branch restrictions) apply to every deployment. A manual `workflow_dispatch`
redeploys the current head (still gated by `checks`) or previews with `dry_run`.

## Configuration

```yaml
deploy:
  enabled: true
  provider: docker-ssh
  trigger: checks          # or push
  workflows: ["Application checks"] # names of the CI workflows; must match the wrapper's workflow_run list
  environment: production
  host: null               # null: DEPLOY_HOST
  port: null               # null: DEPLOY_PORT or 22
  user: null               # null: DEPLOY_USER
  path: /opt/backofficer
  composeFile: compose.yaml
  project: backofficer     # Compose project; default: last segment of path
  envFile: .env            # relative to path or absolute; null disables
  healthcheck:
    url: http://127.0.0.1:3000/  # optional, checked on the host (curl or wget)
    timeoutSeconds: 180    # also the docker compose --wait timeout
  rollback: true
  keepReleases: 5
  timeoutMinutes: 30       # per upload and per activation
  githubDeployment: false  # extra deployment record; the wrapper's environment already records one
```

`factory.enabled: false`, `execution.dryRun` and the `advisory` profile stop
deployments like every other mutation.

## Security

- The deploy job only has `contents: read`, `deployments: write`, `actions: read`
  and only receives deployment secrets; the OpenAI and Slack credentials are never
  passed to it. Deployment secrets are exposed only to the deploy steps of the action.
- SSH runs with `StrictHostKeyChecking=yes` against the pinned host key,
  `IdentitiesOnly`, no agent and batch mode. The key lives in a private temporary
  directory (mode 700/600) for the duration of the run.
- Configuration values passed to the host are validated (paths, names, user, host)
  and shell-quoted. Only tracked files of the exact verified commit are uploaded.
- The application's secrets stay on the host in the env file and never pass
  through GitHub, unless the wrapper passes them explicitly with `deploy-env`
  (see below).

## Secrets from GitHub (`deploy-env`)

Secrets that should not be maintained by hand on the host can come from GitHub.
The wrapper names them in the action's `deploy-env` input, one `NAME=value` per line:

```yaml
      - uses: munichdeveloper/software-factory@FACTORY_COMMIT_SHA
        with:
          mode: deploy
          deploy-env: |
            OPENAI_API_KEY=${{ secrets.BROKER_OPENAI_API_KEY }}
```

Every deployment writes these values to `.sf-deploy.env` (mode 600) in the release
directory on the host, i.e. the Compose project directory, before it starts the
release. The file is always written, empty when nothing is passed, so a service can
list it unconditionally, e.g. `env_file: [/opt/app/app.env, .sf-deploy.env]`; a later
file wins. The values travel over SSH stdin only, never as arguments, are written
single-quoted (literal, no Compose interpolation; a single quote is rejected) and
never logged; the log names the variables only. A name whose secret is unset arrives
empty, is left out and is reported as a warning. Rotating a secret is a redeploy
(`workflow_dispatch`). A rollback restarts the previous release with the values it was
deployed with. Only the deploy job receives these secrets, and only the services that
list the file see them.

## Recovery

| Situation | Effect |
|---|---|
| Upload or SSH fails | Job fails; nothing changed on the host |
| Precondition fails (`env-file-missing`, `compose-missing`, …) | Job fails before containers change |
| New release unhealthy | Previous release restarted (`rolled-back`), job fails |
| Rollback also fails | `rollback-failed`; inspect `docker compose ps/logs` on the host |
| Manual rollback | `ln -sfn /opt/app/releases/<sha> /opt/app/current` and run `docker compose --project-name <project> up -d --build` in it, or re-run an older workflow run via dispatch after reverting the commit |

## The Factory's own runtime

This repository deploys its own runtime stack (broker, worker, SF Manager and their databases) the same way:
`.github/software-factory.yml` enables `deploy` after the `CI` workflow succeeded on `main`, and
`operations/temporal-runtime/compose.production.yaml` is the compose file of the release.

- The **broker** is built on the host from the deployed release (`SF_RELEASE_SHA`). A merge to `main`
  therefore replaces the broker and restarts the services sharing its network namespace (worker, Manager).
  Running Temporal workflows keep their Run-ID across this restart.
- The **PINNED worker release** is named in the compose file itself (`x-worker-release`, a published Factory
  commit). Every deployment builds the worker image from that commit, with its package baked in, and the broker
  serves its repositories with exactly that release; the `release` entries of `registry.json` are superseded.
  Rolling out a worker release is therefore a pull request that changes this one commit, not a step on the host.
  The broker refuses to start while a run of another release is still active; the deployment then fails and the
  previous release keeps running. Installed repositories additionally need their executor wrapper rolled to the
  same commit through the SF Manager.
- The **Manager image** is named by commit in the compose file. The Factory installed deploy-only in
  `munichdeveloper/sf-manager` builds `sf-manager:<commit>` on the host after each merge there; a pull request
  here then switches the stack to that commit.
- Credentials (`*.env`) and `registry.json` stay on the host in the deploy path and never pass through GitHub.
  The exception is the broker's merge review key: the wrapper passes the repository secret
  `BROKER_OPENAI_API_KEY` as `OPENAI_API_KEY` through `deploy-env`, and the broker lists `.sf-deploy.env`
  after `broker.env` (see `docs/temporal-runtime.md`).
- The public host name of the Manager is read from `SFM_HOST` in the host's `.env`. Without it the compose file
  does not resolve and the deployment fails before any container changes.

One-time setup: add `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_HOST` and `DEPLOY_USER` to the
`production` environment of this repository. Until they exist every deployment is skipped with a warning.
The SSH user needs write access to the deploy path and membership in the `docker` group.

The first deployment takes over the already running Compose project `sfm`. It has no previous release to
roll back to: if it fails after containers changed, start the previous stack from the host's original
compose file in the deploy path.
