# Dokploy deployment runbook

## External prerequisites

These are deliberate external gates; the repository cannot safely invent them:

1. Grant Dokploy read access to the private GitHub repository
   `Ensombl/ensombl-auth` and configure it to clone the reviewed revision. Do
   not configure any registry publication.
2. Create DNS for `auth.ensombl.io`. The checked-in Traefik labels attach the
   exact public routes to Dokploy's `websecure` entrypoint and `letsencrypt`
   resolver. TLS must be valid before any user import.
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
| `INVITATION_RECONCILER_SECRET` | independent activation-retry worker |
| `FREIGHTCLAIMS_STAGE_AUTHORIZATION_DECISION_SECRET` | stage API read-only tenant decisions |
| `FREIGHTCLAIMS_PROD_AUTHORIZATION_DECISION_SECRET` | production API read-only tenant decisions |
| `FREIGHTCLAIMS_STAGE_IDENTITY_MANAGEMENT_SECRET` | stage API invitations and tenant membership desired state |
| `FREIGHTCLAIMS_PROD_IDENTITY_MANAGEMENT_SECRET` | production API invitations and tenant membership desired state |
| `FREIGHTCLAIMS_STAGE_HYDRA_CLIENT_SECRET` | stage BFF client; distinct from production |
| `FREIGHTCLAIMS_PROD_HYDRA_CLIENT_SECRET` | production BFF client; distinct from stage |
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
3. Do not create a separate Dokploy domain or port mapping. The Compose labels
   route only the allowlisted paths on `auth.ensombl.io`; PostgreSQL, Ory admin,
   Keto, and internal control paths have no public router.
4. Set persistent storage for the `auth-postgres` volume.
5. Deploy from source. Dokploy builds `apps/control-plane/Dockerfile` locally;
   there is no `image:` name for the project application and nothing is pushed
   to GHCR or any other registry.
6. Wait for PostgreSQL role reconciliation, the three Ory migration jobs, the
   auth-control migration and privilege reconciliation, and
   `product-reconcile` to complete successfully.
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
execute one `SECURITY DEFINER` function that can only assert
`reset_required=true` plus a boolean-only function that validates an exact
completed Stage/Production counterpart before identity reuse. It cannot read
or update the gate table directly.
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
- `freightclaims-stage-web` contains only
  `https://app.staging.freightclaims.ensombl.io/auth/callback` and audience
  `freightclaims-stage`.
- `freightclaims-web` contains only
  `https://app.freightclaims.ensombl.io/auth/callback` and audience
  `freightclaims-prod`.
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

Do not import either Stage or Production users before these gates pass. Stage
must first pass the disposable local-auth rehearsal and may then be imported
only for the approved hosted Stage login test.

## Audited identity import

Source extraction is intentionally not implemented in this repository.
FreightClaims first rehearses the selected reader against disposable local
auth, then prepares the reviewed `freightclaims-fc-stage` or
`freightclaims-fc-prod` batch. The manifest must contain only normalized
traits, the source user key, allowlisted product grants, exact
product/organization tenant bindings, and the Argon2id PHC migration contract
(`m=65536,t=3,p=1`, 16-byte salt, 32-byte hash). Tenant bindings allow only the
`members` or `administrators` organization relation. The manifest must never
contain a plaintext password or legacy ciphertext.

Run the source-built `identity-import` profile from the Dokploy-managed Compose
context with the reviewed revision and approved Bitwarden environment already
in place. Pipe the manifest over standard input; never copy it into the
checkout, a Compose volume, an environment variable, or a command argument:

```bash
source_environment=stage # stage or prod
batch_path="/secure/operator-only/fc-${source_environment}-auth-batch.json"
batch_sha="$(sha256sum "$batch_path" | awk '{print $1}')"
docker compose \
  --file deploy/dokploy/compose.yml \
  --profile identity-import \
  run --rm -T \
  -e "IDENTITY_IMPORT_ALLOWED_SOURCE=freightclaims-fc-${source_environment}" \
  -e IDENTITY_IMPORT_EXPECTED_SHA256="$batch_sha" \
  identity-import <"$batch_path"
unset batch_sha source_environment
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

When a later Production batch contains the same source user ID and normalized
email as a completed Stage entry, it reuses the existing active global
identity. The prior password and the current reset-gate state are preserved,
so a user who already changed their password during hosted Stage is not forced
back to the legacy credential or prompted a second time. Any other
cross-source collision stops the batch.
