FROM alpine:3.22 AS bws
ARG TARGETARCH
RUN apk add --no-cache ca-certificates curl unzip
COPY deploy/bws/install.sh /install-bws.sh
RUN sh /install-bws.sh "$TARGETARCH"

FROM oryd/kratos:v26.2.0

USER root
RUN apk add --no-cache ca-certificates jq
COPY --from=bws /out/bws /usr/local/bin/bws
COPY --chmod=0555 deploy/bws/with-secrets.sh /usr/local/bin/with-secrets
COPY deploy/ory/kratos /etc/config/kratos
USER 10000
ENTRYPOINT ["/usr/local/bin/with-secrets", "kratos"]
CMD ["serve"]
