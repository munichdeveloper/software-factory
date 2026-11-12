FROM node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts
RUN git init /harness && cd /harness && git remote add origin https://github.com/munichdeveloper/dev-agent-harness.git && git fetch --depth=1 origin 9fa9621cb14d8730e82b096c8a0469ecb5749b9f && git checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = 9fa9621cb14d8730e82b096c8a0469ecb5749b9f && npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts

FROM node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
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
