/** Single-quotes a value for POSIX shells (the remote side of `ssh` always runs a shell). */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Remote command line that runs `script` with positional arguments in bash. */
export function bashCommand(script: string, args: string[]): string {
  return ['bash', '-c', script, 'sf-deploy', ...args].map(shellQuote).join(' ');
}

/**
 * Receives a tar stream of the release on stdin and unpacks it atomically to
 * `<root>/releases/<sha>`. Arguments: root, sha.
 */
export const uploadScript = `set -euo pipefail
root=$1 sha=$2
release="$root/releases/$sha"
mkdir -p "$root/releases"
rm -rf -- "$release.upload"
mkdir -p "$release.upload"
tar -x -C "$release.upload"
rm -rf -- "$release"
mv -- "$release.upload" "$release"
echo "SF_DEPLOY_UPLOADED=$sha"
`;

/**
 * Starts a release with Docker Compose under a stable project name (so named
 * volumes persist), verifies it, switches the "current" link and prunes old
 * releases. On failure the previous release is started again when enabled.
 * Compose runs with SF_RELEASE_SHA set to the commit of the release it starts.
 * Arguments: root, sha, project, composeFile, envFile, keep, healthUrl, healthTimeout, rollback.
 * Exit codes: 0 deployed, 2 failed, 3 rolled back, 4 precondition failed.
 */
export const activateScript = `set -euo pipefail
root=$1 sha=$2 project=$3 compose_file=$4 env_file=$5 keep=$6 health_url=$7 health_timeout=$8 rollback=$9
release="$root/releases/$sha"
fail() { echo "SF_DEPLOY_ERROR=$1"; exit 4; }
command -v docker >/dev/null || fail docker-missing
docker compose version >/dev/null 2>&1 || fail compose-missing
if command -v flock >/dev/null; then
  exec 9>"$root/.sf-deploy.lock"
  flock -w 600 9 || fail lock-timeout
fi
[ -d "$release" ] || fail release-missing
[ -f "$release/$compose_file" ] || fail compose-file-missing
if [ -n "$env_file" ]; then
  case "$env_file" in /*) env_path=$env_file ;; *) env_path="$root/$env_file" ;; esac
  [ -f "$env_path" ] || fail env-file-missing
  ln -sfn "$env_path" "$release/.env"
fi
previous=""
if [ -L "$root/current" ]; then previous=$(readlink "$root/current"); fi
echo "SF_DEPLOY_PREVIOUS=$(basename "\${previous:-none}")"
# The compose file may use SF_RELEASE_SHA, e.g. as a build argument or image label of the release.
compose() { local dir=$1; shift; SF_RELEASE_SHA=$(basename "$dir") docker compose --project-name "$project" --project-directory "$dir" --file "$dir/$compose_file" "$@"; }
healthy() {
  [ -z "$health_url" ] && return 0
  local deadline=$((SECONDS + health_timeout))
  while (( SECONDS < deadline )); do
    if command -v curl >/dev/null; then
      curl -fsS -o /dev/null --max-time 10 "$health_url" && return 0
    elif command -v wget >/dev/null; then
      wget -q -O /dev/null -T 10 "$health_url" && return 0
    else
      echo "SF_DEPLOY_ERROR=http-client-missing"; return 1
    fi
    sleep 3
  done
  return 1
}
start() { compose "$1" up --detach --build --remove-orphans --wait --wait-timeout "$health_timeout" && healthy; }
if start "$release"; then
  ln -sfn "$release" "$root/current.next"
  mv -Tf "$root/current.next" "$root/current"
  kept=1
  while IFS= read -r dir; do
    dir=\${dir%/}
    [ "$dir" = "$release" ] && continue
    if (( kept < keep )); then kept=$((kept + 1)); else rm -rf -- "$dir"; fi
  done < <(ls -1dt "$root"/releases/*/ 2>/dev/null)
  docker image prune --force --filter "label=com.docker.compose.project=$project" >/dev/null 2>&1 || true
  echo "SF_DEPLOY_RESULT=deployed"
  exit 0
fi
echo "Release $sha failed to start; recent logs:" >&2
compose "$release" logs --no-color --tail 80 >&2 || true
if [ "$rollback" = 1 ] && [ -n "$previous" ] && [ -d "$previous" ] && [ "$previous" != "$release" ]; then
  if start "$previous"; then echo "SF_DEPLOY_RESULT=rolled-back"; exit 3; fi
  echo "SF_DEPLOY_RESULT=rollback-failed"; exit 2
fi
echo "SF_DEPLOY_RESULT=failed"
exit 2
`;

export function remoteValue(output: string, key: string): string | undefined {
  return [...output.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))].at(-1)?.[1]?.trim();
}
