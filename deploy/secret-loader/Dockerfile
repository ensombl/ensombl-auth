FROM alpine:3.22 AS bws
ARG TARGETARCH
RUN apk add --no-cache ca-certificates curl unzip
COPY deploy/bws/install.sh /install-bws.sh
RUN sh /install-bws.sh "$TARGETARCH"

FROM alpine:3.22
RUN apk add --no-cache ca-certificates jq
COPY --from=bws /out/bws /usr/local/bin/bws
COPY --chmod=0555 deploy/secret-loader/load.sh /usr/local/bin/load-zitadel-secrets
ENTRYPOINT ["/usr/local/bin/load-zitadel-secrets"]
