#!/bin/bash
# One ephemeral runner slot: waits for a just-in-time configuration in /jit, runs exactly one job, cleans up, repeats.
# Started as root only to open the slot directory to the broker and to reset the workspace; jobs run as 'runner'.
set -uo pipefail
slot=/jit work=/home/runner/_work
chmod 0777 "$slot"
rm -f "$slot/busy"
while true; do
  if [[ ! -s "$slot/jitconfig" ]]; then sleep 5; continue; fi
  # 'busy' first, so the broker never sees the slot idle between taking the file and the end of the job.
  touch "$slot/busy"
  config=$(cat "$slot/jitconfig"); rm -f "$slot/jitconfig"
  echo "sf-runner: starting one job"
  # The configuration is single-use: once this runner has connected, it cannot register another runner.
  # runuser (not sudo: root has no sudoers entry in this image) keeps the environment, so DOCKER_HOST reaches the job.
  HOME=/home/runner runuser -u runner -- \
    bash -c 'cd /home/runner && exec ./run.sh --jitconfig "$1"' _ "$config"
  echo "sf-runner: job ended with $?"
  unset config
  # Nothing of one job reaches the next: workspace, tool caches and home directory files are reset.
  find "$work" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null
  rm -rf /home/runner/.cache /home/runner/.npm /home/runner/.m2 /home/runner/.docker /tmp/* 2>/dev/null
  if [[ -n "${DOCKER_HOST:-}" ]]; then
    docker system prune --all --volumes --force >/dev/null 2>&1 || true
  fi
  rm -f "$slot/busy"
done
