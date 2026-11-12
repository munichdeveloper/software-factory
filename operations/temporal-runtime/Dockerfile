FROM node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts
RUN git init /harness && cd /harness && git remote add origin https://github.com/munichdeveloper/dev-agent-harness.git && git fetch --depth=1 origin c8882950c7a267ae99937aaa048de22e6ecd7492 && git checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = c8882950c7a267ae99937aaa048de22e6ecd7492 && npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts

FROM node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS base-runtime
WORKDIR /app
ARG FACTORY_SHA
RUN node -e "if(!/^[a-f0-9]{40}$/.test(process.env.FACTORY_SHA||''))process.exit(1)"
LABEL org.opencontainers.image.title="Software Factory Temporal Runtime" org.opencontainers.image.version="0.8.0" org.opencontainers.image.revision=$FACTORY_SHA
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
FROM node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS worker-build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ARG WORKER_FACTORY_SHA
ARG WORKER_DEPLOYMENT
ARG WORKER_QUEUE
RUN node -e "if(!/^[a-f0-9]{40}$/.test(process.env.WORKER_FACTORY_SHA||''))process.exit(1)"
WORKDIR /app
RUN git init . && git remote add origin https://github.com/munichdeveloper/software-factory.git && git fetch --depth=1 origin "$WORKER_FACTORY_SHA" && git checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = "$WORKER_FACTORY_SHA" && rm -rf .git
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts
RUN HARNESS=$(node -p "require('./temporal-runtime.json').harness.ref") && git init .runtime/harness && cd .runtime/harness && git remote add origin https://github.com/munichdeveloper/dev-agent-harness.git && git fetch --depth=1 origin "$HARNESS" && git checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = "$HARNESS" && rm -rf .git && npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts
RUN node dist/runtime/main.js pack --output /app/package --factory-sha "$WORKER_FACTORY_SHA" --harness-sha "$(node -p "require('./temporal-runtime.json').harness.ref")" --harness /app/.runtime/harness/dist/cli.js --deployment "$WORKER_DEPLOYMENT" --build "$WORKER_FACTORY_SHA" --queue "$WORKER_QUEUE"

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

# The broker of the commit being deployed, told which worker release serves its repositories.
FROM base-runtime AS broker
COPY --from=worker-build /app/package/worker-package.json /app/worker-release.json
ENV FACTORY_RELEASE_FILE=/app/worker-release.json

# Default target: the plain runtime image, as before (CI packaging, manual installations with a registry release).
FROM base-runtime AS runtime
