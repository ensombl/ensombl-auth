FROM alpine:3.22 AS bws
ARG TARGETARCH
RUN apk add --no-cache ca-certificates curl unzip
COPY deploy/bws/install.sh /install-bws.sh
RUN sh /install-bws.sh "$TARGETARCH"

FROM oryd/keto:v26.2.0

USER root
RUN apk add --no-cache ca-certificates jq
COPY --from=bws /out/bws /usr/local/bin/bws
COPY --chmod=0555 deploy/bws/with-secrets.sh /usr/local/bin/with-secrets
COPY deploy/ory/keto/keto.yml /home/ory/keto.yml
COPY deploy/ory/keto/namespaces.ts /home/ory/namespaces.ts
USER ory
ENTRYPOINT ["/usr/local/bin/with-secrets", "keto"]
CMD ["serve"]
