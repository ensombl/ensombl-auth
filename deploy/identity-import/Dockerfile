FROM postgres:16-alpine

RUN apk add --no-cache curl jq

COPY deploy/identity-import/import-identities.sh /usr/local/bin/import-identities

USER postgres
ENTRYPOINT ["/usr/local/bin/import-identities"]
