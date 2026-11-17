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
