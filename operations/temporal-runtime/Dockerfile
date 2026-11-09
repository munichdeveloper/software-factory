FROM node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts
RUN git init /harness && cd /harness && git remote add origin https://github.com/munichdeveloper/dev-agent-harness.git && git fetch --depth=1 origin f70d11556075e9764d69ac03e029720d12ccef65 && git checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = f70d11556075e9764d69ac03e029720d12ccef65 && npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts

FROM node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
WORKDIR /app
ARG FACTORY_SHA
RUN node -e "if(!/^[a-f0-9]{40}$/.test(process.env.FACTORY_SHA||''))process.exit(1)"
LABEL org.opencontainers.image.title="Software Factory Temporal RC" org.opencontainers.image.version="0.7.0-rc.1" org.opencontainers.image.revision=$FACTORY_SHA
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
