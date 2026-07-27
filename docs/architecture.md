# Architecture and flow contracts

## Public routing

Dokploy's existing Traefik terminates TLS and uses the checked-in Compose labels
to expose only:

| Path | Destination |
| --- | --- |
| `/ui/*`, `/healthz`, `/` | source-built control application |
| `/self-service/*`, `/sessions/*`, `/schemas/*` | Kratos public API |
| `/oauth2/*`, `/.well-known/*`, `/userinfo` | Hydra public API |

There is no catch-all router, so `/internal/*`, `/admin/*`, and Keto APIs do not
match a public route. Hydra public and admin listeners are separate containers;
only `hydra-public` joins `dokploy-network`. Kratos v26.2.0 serves public and
admin listeners from one process, so its container joins both
`dokploy-network` and the private Kratos-admin network. Traefik routes only
port 4433 and the public path allowlist, but other workloads on the shared
Dokploy network remain part of the trusted deployment boundary. Keto and every
database remain on internal networks.

Product APIs never receive a raw Keto endpoint. They call the private
`POST /internal/authorization/check` decision boundary with a client-specific
bearer secret. The control plane derives the product from the authenticated
client, constructs a product-namespaced tenant object, and returns only an
allow/deny result. The route is not exposed by Traefik; dependency failures
return `503` and product APIs fail closed. A pre-created external Docker
network named `ensombl-auth-product-decisions` exposes only the control plane
under alias `ensombl-auth-control` to product API containers; raw Ory services
never join it.

Traefik middleware emits anti-framing, MIME-sniffing, no-referrer, and
production HSTS headers. Browser auth/UI paths are forced `no-store`; OIDC
discovery is deliberately excluded so Hydra's API caching contract is
preserved. The local development stack continues to use its small Caddy router.

## Interactive OAuth flow

1. FreightClaims starts Authorization Code + PKCE at Hydra.
2. Hydra sends a one-time login challenge to `/ui/oauth2/login`.
3. The control application validates the challenge through Hydra admin and the
   browser's host-only Kratos session through `sessions/whoami`.
4. If there is no Kratos session, the browser enters the Kratos login flow.
5. The control application checks `auth_control.identity_gates` even when Hydra
   says the login can be skipped.
6. A required reset enters Kratos settings. Kratos itself rejects a password
   equal to the current password. The synchronous password-settings hook first
   revokes every Kratos session for the identity and only then clears the gate
   exactly once. The user authenticates again with the replacement password; a
   revocation failure leaves the gate set.
7. The control application asks Keto whether
   `Product:freightclaims#access@User:<identity-id>` is allowed. Any dependency
   failure denies admission.
8. The control application accepts Hydra login with the Kratos UUID as
   `subject`.
9. Consent repeats identity, reset, and product checks. Only configured
   first-party clients are auto-approved; unknown clients require explicit
   consent.
10. Hydra returns an authorization code to the exact FreightClaims BFF
    callback. Angular never sees an access or refresh token.

## Logout scope

RP-initiated logout ends only the named product's Hydra/application session.
The control application accepts or rejects the Hydra logout challenge and does
not terminate the host-only Kratos identity cookie. The global Ensombl identity
therefore remains available for SSO into other products. A separate,
user-explicit global sign-out flow is future work.

## Migration control contract

The auth-side boundary is a source-built, one-shot Compose profile with no
public endpoint. It accepts an operator-prepared manifest only through stdin,
copies at most 1 MiB into a mode-0700 tmpfs, checks an out-of-band SHA-256 and
the exact schema, and never logs traits or password hashes. Its database role
can append/update only import ledger rows and execute a pinned-search-path
`SECURITY DEFINER` function that can assert `reset_required=true`; it cannot
read, clear, or otherwise update an identity gate.

The manifest accepts only the exact Argon2id contract used by the
FreightClaims migrator: `m=65536,t=3,p=1`, 16-byte salt, and 32-byte hash.
Plaintext and legacy ciphertext are rejected. `fc-stage` extraction is used
only for a read-only rehearsal into disposable local auth. The hosted global
stack accepts only the reviewed `fc-prod` batch at the final migration; the
auth repository does not invent or widen source access.

The import order is:

1. Validate the complete batch and open its idempotency ledger.
2. Create/import the Kratos identity and hash in `inactive` state.
3. Durably assert the reset gate through the true-only function.
4. Write explicit Keto `Product` relationships.
5. Activate the Kratos identity.
6. Commit the identity and batch ledger entries.

Failure injection exists at every split boundary. Before activation a partial
identity is inactive; after activation it is already reset-gated and admitted.
Reruns validate the ledger-bound Kratos external ID, email, and state before
resuming. A completed batch hash is a no-op.

## Invitation contract

Human invitation issuance uses the same-origin SvelteKit action at
`/ui/admin/invitations`. It requires an active AAL2 Kratos session, a clear
reset gate, and a strict Keto `Product:<product>#administer` decision. The
audited `invited_by` identity is derived from that session.

`POST /internal/invitations` is a separate machine boundary. It requires
`INVITATION_API_SECRET`, records the configured `INVITATION_SERVICE_ACTOR`
instead of caller-supplied attribution, and requires a unique `Idempotency-Key`
header. The request is persisted before any Kratos or courier call. Retries
with the same key resume a failed identity lookup or recovery dispatch; reusing
the key with different request data is rejected.

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
