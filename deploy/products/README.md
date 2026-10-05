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

FreightCheck also declares a dedicated optional `invitation_service_account` per application. Bootstrap grants it `ORG_USER_MANAGER` only in the FreightCheck organization and writes its credentials to `invitationServiceAccount` runtime output and the product/environment `INVITATION_CLIENT_ID` and `INVITATION_CLIENT_SECRET` Bitwarden keys. Native setup returns to the catalog login policy `default_redirect_uri`; change the hosted FreightCheck destination from staging to production at launch. The canonical-domain and SMTP-default changes require the coordinated other-product removal before deployment.
