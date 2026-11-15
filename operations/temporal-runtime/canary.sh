#!/usr/bin/env bash
# Deployment canary of the runtime host (software-factory#27), run by the docker-ssh deployment as deploy.verify once
# the new release is healthy. One small task in the acceptance repository (FACTORY_CANARY_REPOSITORY in the broker's
# deployment environment) has to get from start to journaled result; see docs/temporal-runtime.md. Without that
# variable the canary is skipped. Exit 0: passed or skipped; anything else fails the deployment.
set -euo pipefail
compose() { docker compose --project-name "$SF_DEPLOY_PROJECT" --project-directory "$SF_DEPLOY_RELEASE_DIR" --file "$SF_DEPLOY_RELEASE_DIR/$SF_DEPLOY_COMPOSE_FILE" "$@"; }
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
status=0
line=$(compose exec -T runtime-broker node dist/runtime/main.js canary --release "$SF_RELEASE_SHA" --timeout "${SF_CANARY_TIMEOUT_SECONDS:-840}" | tail -n 1) || status=$?
echo "$line"
[ "$status" = 0 ] || { echo "Canary failed (exit $status)"; exit 1; }
case "$line" in *'"outcome":"skipped"'*) exit 0 ;; esac
# The broker's own reconciliation of the acceptance repository must not have reported an error meanwhile.
repository_id=$(printf '%s' "$line" | sed -n 's/.*"repositoryId":\([0-9]*\).*/\1/p')
errors=$(compose logs --no-color --since "$since" runtime-broker 2>/dev/null \
  | grep -E '"event":"factory-reconcile(-failed)?"' | grep "\"repositoryId\":$repository_id[,}]" \
  | grep -Ev '"errors":\[\]' || true)
if [ -n "$errors" ]; then
  echo "Canary failed at stage reconcile: the broker reported errors for repository $repository_id:"
  printf '%s\n' "$errors" | tail -n 5
  exit 1
fi
echo "Canary passed"
