FROM node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts
RUN git init /harness && cd /harness && git remote add origin https://github.com/munichdeveloper/dev-agent-harness.git && git fetch --depth=1 origin 59c113ffac9add7e5da4c10bb887d27d1cf39d55 && git checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = 59c113ffac9add7e5da4c10bb887d27d1cf39d55 && npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts

FROM node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS base-runtime
WORKDIR /app
ARG FACTORY_SHA
RUN node -e "if(!/^[a-f0-9]{40}$/.test(process.env.FACTORY_SHA||''))process.exit(1)"
LABEL org.opencontainers.image.title="Software Factory Temporal Runtime" org.opencontainers.image.version="0.19.0" org.opencontainers.image.revision=$FACTORY_SHA
RUN mkdir -p /run/factory-package && chown node:node /run/factory-package
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /harness/package.json ./.runtime/harness/package.json
COPY --from=build /harness/node_modules ./.runtime/harness/node_modules
COPY --from=build /harness/dist ./.runtime/harness/dist
COPY temporal-runtime.json runtime.json installation-contract.json ./
COPY bundle ./bundle
COPY schemas ./schemas
USER node
ENTRYPOINT ["node", "dist/runtime/main.js"]
CMD ["serve", "--file", "/run/factory/registry.json"]

# The PINNED worker release: built from the published Factory commit WORKER_FACTORY_SHA, never from the commit being
# deployed, and packed at build time so image and package are one immutable unit. The repository is public; the
# Harness pin is the one that release itself declares.
FROM node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS worker-tools
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY operations/temporal-runtime/build-worker.sh /usr/local/bin/build-worker
WORKDIR /app

FROM worker-tools AS worker-build
ARG WORKER_FACTORY_SHA
ARG WORKER_DEPLOYMENT
ARG WORKER_QUEUE
RUN sh /usr/local/bin/build-worker "$WORKER_FACTORY_SHA" "$WORKER_DEPLOYMENT" "$WORKER_QUEUE"

# The PREVIOUS worker release (the one before the last host rollout) on the same deployment and queue. It only finishes
# runs admitted before the rollout; the broker retains its release for them and starts every new run on the current one.
FROM worker-tools AS previous-worker-build
ARG PREVIOUS_WORKER_FACTORY_SHA
ARG WORKER_DEPLOYMENT
ARG WORKER_QUEUE
RUN sh /usr/local/bin/build-worker "$PREVIOUS_WORKER_FACTORY_SHA" "$WORKER_DEPLOYMENT" "$WORKER_QUEUE"

FROM node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS worker
WORKDIR /app
ARG WORKER_FACTORY_SHA
LABEL org.opencontainers.image.title="Software Factory Temporal Worker" org.opencontainers.image.revision=$WORKER_FACTORY_SHA
COPY --from=worker-build /app/package.json /app/package-lock.json ./
COPY --from=worker-build /app/node_modules ./node_modules
COPY --from=worker-build /app/dist ./dist
COPY --from=worker-build /app/.runtime/harness/package.json ./.runtime/harness/package.json
COPY --from=worker-build /app/.runtime/harness/node_modules ./.runtime/harness/node_modules
COPY --from=worker-build /app/.runtime/harness/dist ./.runtime/harness/dist
COPY --from=worker-build /app/package ./package
USER node
ENTRYPOINT ["node", "dist/runtime/main.js"]
CMD ["worker", "--file", "/app/package/worker-package.json"]

FROM node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS previous-worker
WORKDIR /app
ARG PREVIOUS_WORKER_FACTORY_SHA
LABEL org.opencontainers.image.title="Software Factory Temporal Worker (previous release)" org.opencontainers.image.revision=$PREVIOUS_WORKER_FACTORY_SHA
COPY --from=previous-worker-build /app/package.json /app/package-lock.json ./
COPY --from=previous-worker-build /app/node_modules ./node_modules
COPY --from=previous-worker-build /app/dist ./dist
COPY --from=previous-worker-build /app/.runtime/harness/package.json ./.runtime/harness/package.json
COPY --from=previous-worker-build /app/.runtime/harness/node_modules ./.runtime/harness/node_modules
COPY --from=previous-worker-build /app/.runtime/harness/dist ./.runtime/harness/dist
COPY --from=previous-worker-build /app/package ./package
USER node
ENTRYPOINT ["node", "dist/runtime/main.js"]
CMD ["worker", "--file", "/app/package/worker-package.json"]

# The broker of the commit being deployed, told which worker release serves its repositories and which previous
# release it retains for runs admitted before the last host rollout.
FROM base-runtime AS broker
COPY --from=worker-build /app/package/worker-package.json /app/worker-release.json
COPY --from=previous-worker-build /app/package/worker-package.json /app/previous-worker-release.json
ENV FACTORY_RELEASE_FILE=/app/worker-release.json FACTORY_PREVIOUS_RELEASE_FILE=/app/previous-worker-release.json
# Node's own heap limit was about 505 MB, half of the container's mem_limit (1g) unused when the broker died of
# "JavaScript heap out of memory" (software-factory#194). 768 MB leaves room for buffers and native memory.
ENTRYPOINT ["node", "--max-old-space-size=768", "dist/runtime/main.js"]
# A new ENTRYPOINT clears the inherited CMD.
CMD ["serve", "--file", "/run/factory/registry.json"]

# Default target: the plain runtime image, as before (CI packaging, manual installations with a registry release).
FROM base-runtime AS runtime
