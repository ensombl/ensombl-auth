# Product catalog

`products.json` is the hosted catalog and `products.local.json` is the disposable local subset.

Each product declares:

- its product-owner organization and login branding;
- whether roles inherit, extend, or replace `member`, `admin`, and `owner`;
- one OIDC BFF application per canonical `local`, `staging`, or `production` environment;
- one management service account per application, with the declared instance roles and
  `PROJECT_OWNER` on only that product project;
- optional disposable local human and service-account fixtures for product integration tests.

The reconciler is additive and idempotent. It never deletes organizations, roles, applications, or
users. Existing objects with incompatible types or role display names cause a hard failure so an
operator can review the conflict in the ZITADEL Console.
