# Dokploy deployment runbook

## External prerequisites

These are deliberate external gates; the repository cannot safely invent them:

1. Create the private GitHub repository `Ensombl/ensombl-auth` and let Dokploy
   clone the reviewed revision. Do not configure any registry publication.
2. Create DNS for `auth.ensombl.io` and attach that domain to the Dokploy
   `gateway` service on port `8080`. TLS must be valid before any user import.
3. Create the Bitwarden Secrets Manager project `ensombl-auth-prod` and a
   read-only machine account scoped only to that project.
4. Configure a verified `ensombl.io` SMTP sender. Recovery, verification, and
   invitations cannot be accepted without working email delivery.
5. Configure encrypted PostgreSQL backups, a restore drill, volume monitoring,
   and an upgrade maintenance window before staging identities are imported.

## Required Bitwarden values

Generate independent, random values per environment. Password values used in a
PostgreSQL URL should be URL-safe (64 hex characters is acceptable).

| Secret | Constraint / consumer |
| --- | --- |
| `POSTGRES_SUPERUSER_PASSWORD` | reconciled PostgreSQL superuser |
| `KRATOS_DB_PASSWORD` | Kratos database role |
| `HYDRA_DB_PASSWORD` | Hydra database role |
| `KETO_DB_PASSWORD` | Keto database role |
| `AUTH_CONTROL_MIGRATOR_DB_PASSWORD` | DDL migrator; assumes the `NOLOGIN` owner |
| `AUTH_CONTROL_RUNTIME_DB_PASSWORD` | least-privilege control application role |
| `IDENTITY_IMPORT_DB_PASSWORD` | one-shot import ledger and true-only reset assertion |
| `KRATOS_COOKIE_SECRET` | at least 32 random bytes |
| `KRATOS_CIPHER_SECRET` | exactly 32 characters for XChaCha20-Poly1305 |
| `HYDRA_SYSTEM_SECRET` | at least 32 random bytes |
| `HYDRA_PAIRWISE_SALT` | at least 32 random bytes; never rotate casually |
| `ORY_HOOK_SECRET` | settings-hook bearer; same in Kratos and control app |
| `MIGRATION_API_SECRET` | only the hardened migration workload |
| `INVITATION_API_SECRET` | only the audited invitation operator/service |
| `INVITATION_RECONCILER_SECRET` | independent activation-retry worker |
| `FREIGHTCLAIMS_HYDRA_CLIENT_SECRET` | same value in FreightClaims |
| `SMTP_CONNECTION_URI` | authenticated TLS SMTP URI |

`SMTP_FROM_ADDRESS` and `SMTP_FROM_NAME` are configuration values but should
still be injected with the environment.

The machine-readable inventory is
`deploy/secrets/manifest.json`. Shared `.env` files are forbidden.

## Bitwarden to Dokploy handoff blocker

The current Dokploy Compose documentation requires variables to be entered in
Dokploy's Compose environment; Dokploy writes those values to a runtime `.env`
file beside the Compose definition. No native Bitwarden Secrets Manager
integration is documented.

That conflicts with the decision that Bitwarden is the only secrets system.
Before hosted deployment, choose and approve exactly one handoff:

1. **Recommended:** an external deployment agent with a read-only
   `ensombl-auth-prod` machine token reads the allowlisted keys in
   `deploy/secrets/manifest.json` and updates the Dokploy Compose environment
   through an authenticated Dokploy API call immediately before deployment.
2. Explicitly allow Dokploy to hold a runtime copy while Bitwarden remains the
   source of truth, with audited rotation and access controls.

The repository does not include a machine token, Dokploy API token, secret
exporter, or command that prints secret values. Implementation of option 1
needs the Dokploy base URL, an API credential with the narrow update/deploy
scope, and confirmation of the target project/environment IDs. Until that
choice is made, hosted deployment is intentionally blocked.

## Create the Dokploy application

1. Select Compose and set the Compose path to
   `deploy/dokploy/compose.yml`.
2. Inject exactly the keys in `deploy/secrets/manifest.json` using the approved
   Bitwarden-to-Dokploy handoff above.
3. Expose only `gateway:8080` at `auth.ensombl.io`. Do not publish ports for
   PostgreSQL, Kratos, Hydra, Keto, or the control application.
4. Set persistent storage for the `auth-postgres` volume.
5. Deploy from source. Dokploy builds `apps/control-plane/Dockerfile` locally;
   there is no `image:` name for the project application and nothing is pushed
   to GHCR or any other registry.
6. Wait for PostgreSQL role reconciliation, the three Ory migration jobs, the
   auth-control migration and privilege reconciliation, and the Hydra client
   bootstrap to complete successfully.
7. Confirm `invitation-reconciler` is healthy. It continuously retries only
   persisted invitation activations; the `invitation-reconcile` profile is the
   operator-triggered one-shot form.

## PostgreSQL ownership and rotation

Database creation and password changes do not depend on first-start `initdb`.
`postgres-reconcile` uses a private shared Unix socket, has no network, and
converges databases, ownership, login attributes, and desired passwords on
every deployment. `auth_control_owner` is `NOLOGIN`;
`auth_control_migrator` assumes it only for migrations; and
`auth_control_runtime` has explicit non-delete DML grants only on the four
application tables it uses. The import role can append/update its ledger and
execute a `SECURITY DEFINER` function that can only assert
`reset_required=true`; it cannot read or update the gate table directly.
The control application receives only its runtime `DATABASE_URL`; the migration
job separately constructs `AUTH_CONTROL_MIGRATION_URL` from the migrator
credential. The migration script rejects runtime credentials, a different
database, or a URL that does not assume the `NOLOGIN` owner. Non-production
runs accept only loopback migration hosts; production requires an explicit
non-loopback host.

To rotate a database credential, update exactly that Bitwarden value and
redeploy all affected services together. The socket reconciler can rotate the
persisted PostgreSQL superuser credential without knowing its old value. Check
all reconcile/migration jobs and service health before retiring the old
deployment. Do not casually rotate Hydra pairwise salt, Kratos cipher/cookie
keys, or Hydra system secrets; those have protocol/data continuity concerns
and require a separate rotation plan.

## Pre-import gates

Verify all of the following:

```text
GET https://auth.ensombl.io/healthz                    -> 200
GET https://auth.ensombl.io/.well-known/openid-configuration -> 200
GET https://auth.ensombl.io/admin/anything             -> 404
GET https://auth.ensombl.io/internal/anything          -> 404
```

- OIDC discovery returns issuer and endpoints on exactly
  `https://auth.ensombl.io`.
- The Hydra client contains only the exact
  `https://freightclaims.ensombl.io/auth/callback` redirect.
- Recovery email reaches a controlled test mailbox and its code can be used.
- A reset-gated test identity can authenticate but cannot obtain a Hydra code
  until it chooses a different password.
- A user without the `Product:freightclaims` admission is denied even with a
  valid Kratos session.
- A backup is restored into an isolated environment and all four databases pass
  readiness checks.
- Auth HTML, Kratos self-service, session, and browser OAuth responses include
  `Cache-Control: no-store`, CSP `frame-ancestors 'none'`, `X-Frame-Options:
  DENY`, `nosniff`, strict referrer policy, and production HSTS. OIDC discovery
  retains its upstream caching policy.

Do not import `fc-stage` users before these gates pass.

## Audited identity import

Source extraction is intentionally not implemented in this repository. Do not
prepare a batch until the operator has a `fc-stage` read-replica route and a
confirmed `SELECT`-only credential, and the legacy schema/mapping has been
fingerprinted. The prepared manifest must contain only normalized traits, the
source user key, product grants, and the exact Argon2id PHC migration contract
(`m=65536,t=3,p=1`, 16-byte salt, 32-byte hash). It must never contain a
plaintext password or legacy ciphertext.

Run the source-built `identity-import` profile from the Dokploy-managed Compose
context with the reviewed revision and approved Bitwarden environment already
in place. Pipe the manifest over standard input; never copy it into the
checkout, a Compose volume, an environment variable, or a command argument:

```bash
batch_path=/secure/operator-only/fc-stage-auth-batch.json
batch_sha="$(sha256sum "$batch_path" | awk '{print $1}')"
docker compose \
  --file deploy/dokploy/compose.yml \
  --profile identity-import \
  run --rm -T \
  -e IDENTITY_IMPORT_EXPECTED_SHA256="$batch_sha" \
  identity-import <"$batch_path"
unset batch_sha
```

If Dokploy does not expose an audited operator shell in its managed checkout,
stop rather than uploading the file through its UI. Provision an approved
stdin-capable job runner first. The container reads at most 1 MiB into bounded,
non-persistent, core-dump-disabled tmpfs, verifies the supplied SHA-256 and
full schema before mutation, and logs only the batch digest and counts.

Each identity is created inactive, the restricted database function durably
sets the reset gate, Keto relations are written idempotently, and only then is
the identity activated and the entry completed. A split failure remains
inactive and/or reset-gated and is resumed from the ledger on the exact batch
rerun. A completed batch rerun is a no-op.
