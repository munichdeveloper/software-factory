# Ephemeral self-hosted GitHub Actions runner of the Factory's fallback pool (software-factory#110).
# The official runner image; the broker hands each runner a just-in-time configuration for one job through the
# runner's slot volume (/jit), so the runner holds no GitHub or broker credential of its own.
FROM ghcr.io/actions/actions-runner:2.338.1@sha256:e275409999c37162649aa050ca573f03eab2eabcb3a1e7fcc47548de6b4f9690
USER root
# The tools hosted Ubuntu runners have and the Factory's workflows use (jq, zip, git and docker are in the base image).
# Fonts: tests that draw text onto images (canvas, browsers) render nothing without a system font.
# openssh-client: Factory deploy jobs reach the deploy host over SSH.
# iptables: the Factory's coding job (Harness) limits the egress of its coding account with owner rules.
RUN apt-get update && apt-get install -y --no-install-recommends jq zip unzip xz-utils ca-certificates curl \
  fontconfig fonts-dejavu-core fonts-liberation openssh-client iptables \
  && rm -rf /var/lib/apt/lists/*
# The runner image's docker CLI has no plugins; compose and buildx come from the same Docker release as the slot daemons.
COPY --from=docker:29.9.3-dind@sha256:7bf70dcb85c822e3fa6f2d332143e474b99147b9d7b39102b0cfe8b04a7dd61b \
  /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/lib/docker/cli-plugins/
# Marks this image as the Factory's ephemeral pool, so independent validation accepts it like a fresh hosted runner (#131).
RUN printf 'software-factory ephemeral runner pool\n' > /etc/sf-runner-pool && chmod 0444 /etc/sf-runner-pool
COPY operations/runner/entrypoint.sh /usr/local/bin/sf-runner
RUN chmod 0755 /usr/local/bin/sf-runner
ENTRYPOINT ["/usr/local/bin/sf-runner"]
