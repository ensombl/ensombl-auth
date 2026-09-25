# FreightCheck platform roles

FreightCheck's hosted and local catalogs declare `platform_admin` and `platform_support`. Bootstrap already derives project and application role assertion from the catalog. It keeps `authorizationRequired=false` and `projectAccessRequired=false`, so roleless customers still authenticate.

The local fixture `platform-admin@freightcheck.test` receives `platform_admin`; the existing `developer@freightcheck.test` fixture stays roleless. The new local password is `FreightCheck-Admin-2026!`. This fixture does not enroll MFA or grant access to a deployed admin console by itself.

Deploy this configuration before the corresponding FreightCheck platform-admin authentication change. An authorized operator must confirm Julien's and the requesting operator's exact accounts before directly assigning `platform_admin` through FreightCheck's project, using external-user role assignments. No Ensombl project grant is needed. Patrick and Merul require separate confirmation. This PR performs no live assignments.

Verify FreightCheck's effective login policy and staff MFA enrollment: bootstrap enforces the project owner's policy, not necessarily Ensombl's. Capture the project-specific role claim, grant-organization IDs, `amr`, and `auth_time` from staging logins without publishing tokens. FreightCheck must keep its admin capability disabled until MFA evidence is verified, with no staging bypass. Password-plus-TOTP, password-only, roleless, and role-removal flows must be checked before enabling access. Passwordless passkeys require separate evidence review.

`platform_support` grants no FreightCheck console access yet. Organizations, memberships, seat overrides, and LEO status remain in FreightCheck; billing remains in Stripe.
