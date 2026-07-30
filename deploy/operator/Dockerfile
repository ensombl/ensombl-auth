FROM alpine:3.22 AS bws
ARG TARGETARCH
RUN apk add --no-cache ca-certificates curl unzip
COPY deploy/bws/install.sh /install-bws.sh
RUN sh /install-bws.sh "$TARGETARCH"

FROM node:24-alpine
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json biome.json ./
COPY src src
COPY deploy/products deploy/products
COPY --from=bws /out/bws /usr/local/bin/bws
ENTRYPOINT ["pnpm", "exec", "tsx", "src/cli.ts"]
