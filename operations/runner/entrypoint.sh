#!/bin/bash
# One ephemeral runner slot: waits for a just-in-time configuration in /jit, runs exactly one job, cleans up, repeats.
# Started as root only to open the slot directory to the broker and to reset the workspace; jobs run as 'runner'.
set -uo pipefail
slot=/jit work=/home/runner/work idle=${SF_RUNNER_IDLE_SECONDS:-180}
chmod 0777 "$slot"
rm -f "$slot/busy"
# The workspace is a volume shared with the slot's Docker daemon; it starts out owned by root.
chown runner:runner "$work"
# The Factory's coding job creates its own isolated accounts (Harness); their homes hold agent state of the job. The
# Harness also bind-mounts the job's browser cache into the account's home and limits the account's egress with owner
# rules in OUTPUT. A mount keeps the home from being removed, and the rules live in the network namespace of the slot's
# Docker daemon, which outlives the job: left behind, they would apply to whichever account gets the UID next.
clear_job_accounts() {
  local account target filter
  local -a rule
  for account in codex-worker claude-worker; do
    if id "$account" >/dev/null 2>&1; then pkill -KILL -u "$account" 2>/dev/null; fi
    while read -r target; do
      umount "$target" 2>/dev/null || umount -l "$target" 2>/dev/null
    done < <(awk -v home="/home/$account/" 'index($2, home) == 1 { print $2 }' /proc/self/mounts | sort -r)
    if id "$account" >/dev/null 2>&1; then userdel -r -f "$account" >/dev/null 2>&1; fi
  done
  for filter in iptables ip6tables; do
    while read -r -a rule; do
      "$filter" -w "${rule[@]}" 2>/dev/null
    done < <("$filter" -w -S OUTPUT 2>/dev/null | sed -n 's/^-A \(OUTPUT .*--uid-owner .*\)$/-D \1/p')
    "$filter" -w -F HARNESS_CLAUDE 2>/dev/null; "$filter" -w -X HARNESS_CLAUDE 2>/dev/null
  done
}
# A slot restarted in the middle of a job starts clean as well.
clear_job_accounts
while true; do
  if [[ ! -s "$slot/jitconfig" ]]; then sleep 5; continue; fi
  # 'busy' first, so the broker never sees the slot idle between taking the file and the end of the job.
  touch "$slot/busy"
  config=$(cat "$slot/jitconfig"); rm -f "$slot/jitconfig"
  echo "sf-runner: starting one job"
  # The configuration is single-use: once this runner has connected, it cannot register another runner.
  # runuser (not sudo: root has no sudoers entry in this image) keeps the environment, so DOCKER_HOST reaches the job.
  log=$(mktemp)
  setsid env HOME=/home/runner runuser -u runner -- \
    bash -c 'cd /home/runner && exec ./run.sh --jitconfig "$1"' _ "$config" > >(tee "$log") 2>&1 &
  pid=$! waited=0
  unset config
  # A configuration is handed out for a queued job of one repository. When that job is cancelled before it starts
  # (concurrency groups do this) and the repository has no other queued job, the runner would wait forever and keep
  # the slot. Without a job after $idle seconds the runner is stopped and the slot freed; GitHub drops the offline
  # just-in-time runner itself.
  while kill -0 "$pid" 2>/dev/null; do
    if (( waited >= idle )) && ! grep -q 'Running job' "$log"; then
      echo "sf-runner: no job after ${idle}s, giving the slot back"
      kill -TERM -- "-$pid" 2>/dev/null; sleep 10; kill -KILL -- "-$pid" 2>/dev/null
      break
    fi
    sleep 5; waited=$((waited + 5))
  done
  wait "$pid"; echo "sf-runner: job ended with $?"
  rm -f "$log"
  # Nothing of one job reaches the next: workspace, tool caches and home directory files are reset.
  find "$work" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null
  rm -rf /home/runner/.cache /home/runner/.npm /home/runner/.m2 /home/runner/.docker /tmp/* 2>/dev/null
  clear_job_accounts
  if [[ -n "${DOCKER_HOST:-}" ]]; then
    docker system prune --all --volumes --force >/dev/null 2>&1 || true
  fi
  rm -f "$slot/busy"
done
