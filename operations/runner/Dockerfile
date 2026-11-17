# Ephemeral self-hosted GitHub Actions runner of the Factory's fallback pool (software-factory#110).
# The official runner image; the broker hands each runner a just-in-time configuration for one job through the
# runner's slot volume (/jit), so the runner holds no GitHub or broker credential of its own.
FROM ghcr.io/actions/actions-runner:2.338.1@sha256:e275409999c37162649aa050ca573f03eab2eabcb3a1e7fcc47548de6b4f9690
USER root
# The tools hosted Ubuntu runners have and the Factory's workflows use (jq, zip, git and docker are in the base image).
RUN apt-get update && apt-get install -y --no-install-recommends jq zip unzip xz-utils ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY operations/runner/entrypoint.sh /usr/local/bin/sf-runner
RUN chmod 0755 /usr/local/bin/sf-runner
ENTRYPOINT ["/usr/local/bin/sf-runner"]
