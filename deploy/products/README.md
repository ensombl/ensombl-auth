# Product catalog

`products.json` is the hosted catalog and `products.local.json` is the disposable local subset.

Each product declares:

- its product-owner organization, native hosted-login policy, colors, theme, and optional
  base64-encoded logo asset;
- optional product-wide project roles; there are no defaults;
- one OIDC BFF application per canonical `local`, `staging`, or `production` environment;
- one management service account per application, with `ORG_USER_MANAGER` on the product
  organization — plus read-only `ORG_OWNER_VIEWER` on the instance organization when the product
  sets `instance_org_user_lookup: true`, or instance-wide `user.read` through
  `instance_user_lookup: true`; the two flags are mutually exclusive and default to false;
- an optional migration service account for importing identities into the product organization;
- optional disposable local human and service-account fixtures for product integration tests.

A migration account is an explicitly trusted control-plane identity, not an application runtime.
The migration account receives `ORG_USER_MANAGER` only on its product organization so it can
import product-owned humans. The hosted FreightClaims account receives `IAM_LOGIN_CLIENT` only for the imported
password verification test. FreightCheck declares `instance_user_lookup: true`, so its application
management accounts receive
`IAM_FREIGHTCHECK_DIRECTORY_READER` for cross-organization identity lookup, including FreightClaims
customers. They do not retain the instance-organization viewer grant. FreightCheck memberships
control tenant access; there is no synchronized enrollment role. Bootstrap never creates customer-tenant organizations.

The catalog bootstrap requires a clean ZITADEL instance. Recovery and reset procedures are defined
in [the Dokploy deployment guide](../../docs/dokploy.md).

The optional top-level `registration_guidance` configures English registration text for the entire
instance, including FreightClaims and FreightCheck. Its `description` and `creation_error` fields
are validated catalog values. Bootstrap applies them after provisioning; translation failures warn
without blocking the runtime configuration. Omitting the field preserves existing translations.
