# Architecture

## Identity and tenancy model

One ZITADEL instance is the global Ensombl identity boundary. A human identity is created once and
can receive authorizations in any number of customer organizations.

| Ensombl concept | ZITADEL object |
| --- | --- |
| Global identity platform | Instance |
| Product identity owner and product branding | Product owner organization |
| FreightClaims or FreightCheck | Project |
| Local, staging, or production BFF | OIDC application |
| Customer tenant | Organization |
| Product available to a tenant | Project grant |
| User role in a tenant | Authorization (user grant) |
| Admin UI | ZITADEL Console |

Product projects are owned by dedicated product organizations. Enforcing project-owner branding
therefore makes the login screen deterministic from the OIDC client even before the user is known.
A tenant can additionally own colors, logos, fonts, and message text. A product passes an
organization scope when the tenant is already known; this is the explicit contract that selects
tenant branding. Hostname alone is not treated as tenant identity.

The default product roles are `member`, `admin`, and `owner`. A product may extend or completely
replace that stack in the catalog. FreightClaims currently replaces it with its existing canonical
roles so the rewrite does not need a second role translation.

## Authentication

Products use Authorization Code with PKCE through a confidential BFF client. The canonical issuer
is `https://auth.ensombl.io`. Access and ID tokens contain ZITADEL project-role claims whose values
map each role to the organization IDs in which it applies. Authorization is evaluated from those
signed claims and the product database projection; there is no separate Keto decision service.

Machine clients use ZITADEL API applications and standard token introspection. Product management
uses a least-privilege ZITADEL service account. The initial IAM-owner PAT exists only to reconcile
the declarative catalog and is mounted from the private bootstrap volume.

## Legacy password migration

ZITADEL is configured with the `argon2` password verifier. The FreightClaims migrator sends the
Argon2id PHC string to `POST /v2/users/new` as `hashedPassword.hash` and sets
`changeRequired: true`. The bounded migrator decrypts the legacy credential only in a no-swap,
no-core-dump tmpfs process, immediately hashes it, and never logs or persists the plaintext. The
FreightClaims runtime never receives the legacy password.

The contract was verified against ZITADEL v4.16.2:

1. the FreightClaims Argon2id PHC was accepted unchanged;
2. the old password authenticated;
3. ZITADEL required an immediate password change;
4. an external role assignment gave the same user access under a second customer organization.

ZITADEL rehashes a verified legacy password using its active password hasher.

## Branding and email

ZITADEL owns instance, product-owner, and tenant login branding. Product branding is selected by
the OIDC application. Tenant branding is selected by explicit organization context.

ZITADEL system notifications use `Ensombl <noreply@notifications.ensombl.io>` through Resend SMTP.
Product-initiated invitations are sent by the initiating product with its configured From name;
generic account recovery has no product context and intentionally uses the Ensombl default.

## Runtime and secrets

The hosted stack contains only ZITADEL, Login V2, a one-shot Bitwarden secret loader, and a one-shot
catalog reconciler. PostgreSQL is a native Dokploy database service. The old Kratos, Hydra, Keto,
and auth-control databases are not used by the new stack and are retained temporarily for rollback.

Dokploy receives only `BWS_ACCESS_TOKEN` and the non-secret `BWS_PROJECT_ID`. The loader writes the
ZITADEL master key and JSON runtime config to a private volume. ZITADEL itself has no Bitwarden
token or outbound secret-manager access.

No project container image is published. Dokploy builds the two small helper images from the
reviewed source and pulls the pinned upstream ZITADEL images.
