# Product catalog

`products.json` is the hosted catalog and `products.local.json` is the disposable local subset.

Each product declares:

- its product-owner organization and login branding;
- whether roles inherit, extend, or replace `member`, `admin`, and `owner`;
- one OIDC BFF application per canonical `local`, `staging`, or `production` environment;
- one management service account per application, with `PROJECT_OWNER` on only that product
  project and `ORG_USER_MANAGER` only on the product organization;
- an optional migration service account for importing identities into the product organization;
- optional disposable local human and service-account fixtures for product integration tests.

A migration account is an explicitly trusted control-plane identity, not an application runtime.
For a product that migrates B2B tenants, it receives `IAM_ORG_MANAGER` to create only the required
tenant organizations, `ORG_USER_MANAGER` on its product organization to import product-owned
humans, and `PROJECT_OWNER` on its product project. The bootstrap never gives an application
management account an instance role.

The catalog bootstraps a clean ZITADEL instance. There is no compatibility or repair workflow:
before a greenfield hosted reset, clear the dedicated auth database and generated product secrets,
then run the bootstrap once.
