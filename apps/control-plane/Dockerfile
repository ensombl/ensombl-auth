FROM alpine:3.22 AS bws
ARG TARGETARCH
RUN apk add --no-cache ca-certificates curl unzip
COPY deploy/bws/install.sh /install-bws.sh
RUN sh /install-bws.sh "$TARGETARCH"

FROM node:24-slim AS base
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/control-plane/package.json apps/control-plane/
RUN pnpm install --frozen-lockfile --filter @ensombl/auth-control

FROM deps AS build
COPY tsconfig.json turbo.json biome.json ./
COPY apps/control-plane apps/control-plane
RUN pnpm --filter @ensombl/auth-control build
RUN pnpm --filter @ensombl/auth-control deploy --prod --legacy /app/deployed

FROM node:24-slim AS runner
RUN apt-get update \
  && apt-get install -y --no-install-recommends jq tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
COPY --from=build /app/apps/control-plane/build build
COPY --from=build /app/deployed/node_modules node_modules
COPY --from=build /app/deployed/package.json package.json
COPY --from=build /app/apps/control-plane/migrations migrations
COPY --from=build /app/apps/control-plane/scripts scripts
COPY --from=bws /out/bws /usr/local/bin/bws
COPY --chmod=0555 deploy/bws/with-secrets.sh /usr/local/bin/with-secrets
COPY --chown=node:node deploy/products/products.json /etc/ensombl/products.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "--", "/usr/local/bin/with-secrets"]
CMD ["node", "build"]
