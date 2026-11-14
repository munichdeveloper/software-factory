#!/bin/sh
# Builds and packs the PINNED worker of one published Factory commit into the current directory (used for the
# current and the previous worker release, see compose.production.yaml). Arguments: factory sha, deployment, queue.
set -eu
sha="$1" deployment="$2" queue="$3"
node -e "if(!/^[a-f0-9]{40}$/.test(process.argv[1]))process.exit(1)" "$sha"
git init . && git remote add origin https://github.com/munichdeveloper/software-factory.git && git fetch --depth=1 origin "$sha" && git checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = "$sha" && rm -rf .git
npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts
harness=$(node -p "require('./temporal-runtime.json').harness.ref")
git init .runtime/harness && cd .runtime/harness && git remote add origin https://github.com/munichdeveloper/dev-agent-harness.git && git fetch --depth=1 origin "$harness" && git checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = "$harness" && rm -rf .git && npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts
cd ../..
node dist/runtime/main.js pack --output "$PWD/package" --factory-sha "$sha" --harness-sha "$harness" --harness "$PWD/.runtime/harness/dist/cli.js" --deployment "$deployment" --build "$sha" --queue "$queue"
