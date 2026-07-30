# Architecture and flow contracts

## Public routing

Dokploy's existing Traefik terminates TLS. Hydra remains a single canonical
issuer at `auth.ensombl.io`; `auth.freightclaims.ensombl.io` and
`auth.freightcheck.com` are branded Kratos and control-UI edges over the same
global identity database.

| Host and path | Destination |
| --- | --- |
| all auth hosts: `/ui/*`, `/healthz`, `/` | source-built control application |
| all auth hosts: `/self-service/*`, `/sessions/*`, `/schemas/*` | host-configured Kratos public edge |
| `auth.ensombl.io`: `/oauth2/*`, `/.well-known/*`, `/userinfo` | canonical Hydra public API |

There is no catch-all router. Only the five product endpoints documented below
match `/internal/*`; every other internal path, `/admin/*`, and Keto API does
not match a public route. Hydra public and admin listeners are separate
containers, and Kratos v26.2.0 serves public and admin listeners from one
process. Traefik routes only the declared public ports and path allowlists.
All Kratos edges share the dedicated native Kratos database, cookie/cipher
secrets, identity schema, and reset hooks, but issue host-only browser cookies.
Kratos, Hydra, Keto, and auth control each use a separate native Dokploy
PostgreSQL service. The dedicated auth Dokploy installation and its shared
container network are the trusted deployment boundary; database and admin
ports have no public router or host port.

Product APIs never receive a raw Keto endpoint. From their separate
infrastructure they call the exact HTTPS
`POST /internal/authorization/check` decision boundary with a client-specific
bearer secret. The control plane derives the product from the authenticated
client, constructs a product-namespaced tenant object, and returns only an
allow/deny result. Dependency failures return `503` and product APIs fail
closed. Traefik also exposes the exact invitation, membership, identity
migration, and token-introspection routes. Introspection is proxied by the
control plane so Hydra admin never joins the public network; it requires the
same environment-specific read-only authorization secret and client ID.
Every other `/internal/*` path stays private and returns `404`.

## Hosted secret bootstrap

The singleton hosted stack reads runtime secrets from the
`ensombl-auth` Bitwarden Secrets Manager project. The read-only
`ensombl-auth-runtime` machine account has access only to that project, and the
Dokploy installation holds one deployment-specific access token plus the
non-secret project UUID.

Every checked-in runtime image installs the same pinned, checksum-verified BWS
CLI. Before starting its real process, a common wrapper retrieves the project,
exports only the service's reviewed mappings, removes the Bitwarden token and
retrieval payload, and uses `exec` for the final process. Dokploy
administration credentials are outside this project and never enter the auth
stack. Secret changes take effect on redeployment; an already-running process
does not depend on Bitwarden remaining reachable.

The BWS token remains in Docker's stored container configuration even though it
is absent from the final process environment. Dokploy and Docker administrator
access is therefore part of the trusted auth-stack boundary.

Traefik middleware emits anti-framing, MIME-sniffing, no-referrer, and
production HSTS headers. Browser auth/UI paths are forced `no-store`; OIDC
discovery is deliberately excluded so Hydra's API caching contract is
preserved. The local development stack continues to use its small Caddy router.

## Interactive OAuth flow

1. FreightClaims starts Authorization Code + PKCE at Hydra.
2. Hydra sends a one-time login challenge to `/ui/oauth2/login`.
3. The control application resolves the trusted Hydra client through the
   reviewed product catalog and moves the browser to
   `auth.freightclaims.ensombl.io`; Hydra's issuer and protocol endpoints remain
   on `auth.ensombl.io`.
4. The control application validates the challenge through Hydra admin and the
   browser's host-only Kratos session through `sessions/whoami`.
5. If there is no Kratos session, the browser enters the FreightClaims-branded
   Kratos login flow.
6. The control application checks `auth_control.identity_gates` even when Hydra
   says the login can be skipped.
7. A required reset enters Kratos settings. Kratos itself rejects a password
   equal to the current password. The synchronous password-settings hook first
   revokes every Kratos session for the identity and only then clears the gate
   exactly once. The user authenticates again with the replacement password; a
   revocation failure leaves the gate set.
8. The control application asks Keto whether
   `Product:freightclaims#access@User:<identity-id>` is allowed. Any dependency
   failure denies admission.
9. The control application accepts Hydra login with the Kratos UUID as
   `subject`.
10. Consent repeats identity, reset, and product checks. Only configured
   first-party clients are auto-approved; unknown clients require explicit
   consent.
11. Hydra returns an authorization code to the exact FreightClaims BFF
    callback. Angular never sees an access or refresh token.

## Logout scope

RP-initiated logout ends only the named product's Hydra/application session.
The control application accepts or rejects the Hydra logout challenge and does
not terminate any host-only Kratos identity cookie. Identity records and
credentials are global, but browser sessions are deliberately separate per
auth hostname; no `.ensombl.io` parent cookie is used. A separate,
user-explicit sign-out-across-hosts flow is future work.

## Product-aware auth email

Kratos stores the Traefik-injected `X-Ensombl-Auth-Product` marker with each
queued recovery or verification message. Public routers overwrite that marker,
and private invitation dispatch derives it from the already-authenticated
product client. Arbitrary sender names are never accepted.

Neither Kratos public process watches the shared queue. One `kratos-courier`
worker posts queued messages to the non-public control endpoint using its own
bearer secret. The control plane resolves the marker through
`products.json` and sends with the Resend API. The sender address is always
`noreply@notifications.ensombl.io`; the display name is `Ensombl` by default,
`FreightClaims` for FreightClaims-originated flows, and `FreightCheck` for
FreightCheck-originated flows. A missing marker uses the reviewed default; an
unknown marker fails closed.

## Migration control contract

The hosted auth stack does not read a legacy database and contains no password
decryptor. FreightClaims performs source selection and decryption inside its
isolated migration worker, immediately converts accepted credentials to the
reviewed Argon2id contract, and calls the exact HTTPS
`POST /internal/migration/identities` boundary.

The endpoint requires a client ID and the corresponding catalog-declared
identity-migration bearer. It derives the product, source environment, and
admission scope from that authenticated client rather than accepting them as
caller-controlled fields. Payloads accept only `m=65536,t=3,p=1`, a 16-byte
salt, and a 32-byte hash. Plaintext and legacy ciphertext are rejected and
never enter auth logs.

For each accepted identity the control plane:

1. Validates the source record and idempotency binding.
2. Creates or verifies the Kratos identity and imported hash.
3. Durably asserts the mandatory reset gate.
4. Writes the reviewed product and tenant relations to Keto.
5. Activates the identity only after the reset gate and admission exist.
6. Commits the source alias and membership ledger.

Retries validate the bound Kratos identity, normalized email, source user ID,
and state before resuming. A production source may reuse a completed staging
global identity only for the exact reviewed counterpart. It never replaces an
active password or reasserts a reset gate the user already completed. Any
incomplete, differently keyed, or email-mismatched collision fails closed.

## Invitation contract

Human invitation issuance uses the same-origin SvelteKit action at
`/ui/admin/invitations`. It requires an active AAL2 Kratos session, a clear
reset gate, and a strict Keto `Product:<product>#administer` decision. The
audited `invited_by` identity is derived from that session.

`POST /internal/invitations` is a separate machine boundary. It requires the
calling client's catalog-declared identity-management secret and `client_id`,
derives both product and audited service actor from that client, and requires a
unique `Idempotency-Key` header. The request is persisted before any Kratos or
courier call. Retries with the same key resume a failed identity lookup or
recovery dispatch; reusing the key with different request data is rejected.

`PUT /internal/tenants/memberships` uses the same product-client capability. It
applies an idempotent active or revoked desired role to only the caller's
product tenant. The catalog supplies `member`, `admin`, and `owner` by default.
A product can extend those defaults or replace the complete role set and map
each role to product-owned permissions. Keto stores one product-scoped role
assignment per identity and tenant; changing a role removes every prior
assignment before granting the desired one. The product service remains
responsible for its canonical membership transaction and audit record.

Dispatching an invitation never grants Keto admission. A synchronous Kratos
post-recovery hook records the successful recovery flow and activates only
invitations that had not expired when recovery succeeded. The hook then writes
the product relation idempotently and marks the invitation active. Failed or
partially completed activation remains audited. A separately authenticated
internal reconciliation worker leases and retries persisted
`activation_pending`/`activation_failed` records with bounded backoff; the
one-shot form of the same command remains available to operators. OAuth
admission also rejects any non-active invitation whose relation did not predate
the invitation, so a Keto-write/database-write split cannot leak access. Once
activation succeeds, invitation expiry no longer acts as an authorization TTL;
product access is removed only through the explicit authorization lifecycle.

Kratos courier sends the one-time code; the control application never receives
or logs the password. Public routing always returns 404 for this endpoint.
