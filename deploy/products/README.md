# Product catalog

`products.json` is the hosted catalog and `products.local.json` is the disposable local subset.

Each product declares:

- its product-owner organization, native hosted-login policy, colors, theme, and optional
  base64-encoded logo asset;
- optionally `login_policy.default_redirect_uri`: where ZITADEL sends a user who finishes a flow it
  did not start from an OIDC request (activating an invitation), instead of its Console. It must be
  under one of the product's applications; the local catalog's value follows the local runtime
  profile's application port. Omitted, the organization's existing value is kept;
- optional product-wide project roles; there are no defaults;
- one OIDC BFF application per canonical `local`, `staging`, or `production` environment;
- one management service account per application, with `ORG_USER_MANAGER` on the product
  organization — plus read-only `ORG_OWNER_VIEWER` on the instance organization when the product
  sets `instance_org_user_lookup: true` (to resolve Ensombl operators who also use the product);
- an optional migration service account for importing identities into the product organization;
- optional disposable local human and service-account fixtures for product integration tests.

A migration account is an explicitly trusted control-plane identity, not an application runtime.
The migration account receives `ORG_USER_MANAGER` only on its product organization so it can
import product-owned humans. The hosted FreightClaims account receives `IAM_LOGIN_CLIENT` only for the imported
password verification test. The bootstrap never gives an application management account an
instance role and never creates customer-tenant organizations.

The catalog bootstrap requires a clean ZITADEL instance. Recovery and reset procedures are defined
in [the Dokploy deployment guide](../../docs/dokploy.md).

`domain_policy.user_login_must_be_domain` optionally reconciles an organization-specific domain
policy. Omit it to leave that organization's policy unmanaged. The bootstrap reads the effective
policy, preserves domain validation and SMTP sender restrictions, and writes only when the requested
login-name setting differs. It never changes the instance default.

FreightCheck enables this setting in both catalogs so native ZITADEL login names carry the
organization domain. Email sign-in stays enabled and domain discovery stays disabled. Separate
product identities may share an email address; identities and application memberships are not merged.

The hosted FreightCheck organization is shared by staging and production. Deploy the scoped
FreightCheck authentication change in [FreightCheck PR #642](https://github.com/ensombl/freightcheck/pull/642)
before running this bootstrap against the shared deployment. Inventory existing login names and
users relying on another product's identity, and capture the effective policy before rollout.
If verification fails, stop and assess newly created usernames before reverting the policy:
disabling organization-scoped names can introduce global-name conflicts.
