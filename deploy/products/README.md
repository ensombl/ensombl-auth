# Product catalog

`products.json` is the hosted catalog and `products.local.json` is the disposable local subset.

Each product declares:

- its product-owner organization and login branding;
- optional product-wide project roles; there are no defaults;
- one OIDC BFF application per canonical `local`, `staging`, or `production` environment;
- one management service account per application, with `ORG_USER_MANAGER` only on the product
  organization;
- an optional migration service account for importing identities into the product organization;
- optional disposable local human and service-account fixtures for product integration tests.

A migration account is an explicitly trusted control-plane identity, not an application runtime.
The migration account receives `ORG_USER_MANAGER` only on its product organization so it can
import product-owned humans. A local account may receive `IAM_LOGIN_CLIENT` only for the imported
password verification test. The bootstrap never gives an application management account an
instance role and never creates customer-tenant organizations.

The catalog bootstraps a clean ZITADEL instance. There is no compatibility or repair workflow:
before a greenfield hosted reset, clear the dedicated auth database and generated product secrets,
then run the bootstrap once.
