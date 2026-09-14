import { describe, expect, it, vi } from "vitest";
import { bootstrapCatalog, provisionLocalHumans } from "../src/bootstrap.js";
import type { Product } from "../src/catalog.js";
import { applyLocalCatalogProfile, catalogSchema } from "../src/catalog.js";
import type { ZitadelClient } from "../src/zitadel.js";

const passwordChangeUser: NonNullable<Product["local_fixture"]>["users"][number] = {
  key: "platform-admin",
  id: "user-platform-admin",
  email: "admin@example.com",
  display_name: "Platform Admin",
  password: "Local-password-2026!",
  password_change_required: true,
  roles: ["platform_admin"],
};

const users: NonNullable<Product["local_fixture"]>["users"] = [
  {
    key: "tenant-owner",
    id: "user-owner",
    email: "owner@example.com",
    display_name: "Tenant Owner",
    password: "Local-password-2026!",
    password_change_required: false,
    roles: [],
  },
  passwordChangeUser,
];

describe("local human fixtures", () => {
  it("creates missing users, preserves matching users, and returns no passwords", async () => {
    const client = {
      createHumanUser: vi.fn().mockResolvedValue(undefined),
      updateHumanUser: vi.fn().mockResolvedValue(undefined),
      ensureAuthorization: vi.fn().mockResolvedValue(undefined),
      getUser: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({
        id: "user-platform-admin",
        username: "admin@example.com",
        email: "admin@example.com",
        displayName: "Platform Admin",
      }),
    } as unknown as ZitadelClient;

    const runtime = await provisionLocalHumans(client, users, "project-id", "organization-id");

    expect(client.getUser).toHaveBeenCalledTimes(2);
    expect(client.createHumanUser).toHaveBeenCalledTimes(1);
    expect(client.updateHumanUser).not.toHaveBeenCalled();
    expect(client.createHumanUser).toHaveBeenCalledWith({
      organizationId: "organization-id",
      userId: "user-owner",
      email: "owner@example.com",
      displayName: "Tenant Owner",
      password: "Local-password-2026!",
      passwordChangeRequired: false,
    });
    expect(client.ensureAuthorization).toHaveBeenCalledTimes(2);
    expect(client.ensureAuthorization).toHaveBeenNthCalledWith(1, {
      userId: "user-owner",
      projectId: "project-id",
      organizationId: "organization-id",
      roleKeys: [],
    });
    expect(client.ensureAuthorization).toHaveBeenNthCalledWith(2, {
      userId: "user-platform-admin",
      projectId: "project-id",
      organizationId: "organization-id",
      roleKeys: ["platform_admin"],
    });
    expect(client.createHumanUser).toHaveBeenCalledWith(
      expect.objectContaining({ passwordChangeRequired: false }),
    );
    expect(runtime).toEqual({
      "tenant-owner": { userId: "user-owner", email: "owner@example.com" },
      "platform-admin": { userId: "user-platform-admin", email: "admin@example.com" },
    });
    expect(JSON.stringify(runtime)).not.toContain("Local-password");
  });

  it("passes a local user's forced-password-change setting when creating it", async () => {
    const client = {
      createHumanUser: vi.fn().mockResolvedValue(undefined),
      updateHumanUser: vi.fn().mockResolvedValue(undefined),
      ensureAuthorization: vi.fn().mockResolvedValue(undefined),
      getUser: vi.fn().mockResolvedValue(undefined),
    } as unknown as ZitadelClient;

    await provisionLocalHumans(client, [passwordChangeUser], "project-id", "organization-id");

    expect(client.createHumanUser).toHaveBeenCalledWith(
      expect.objectContaining({ passwordChangeRequired: true }),
    );
  });

  it("converges an existing fixture user's login, email, and profile", async () => {
    const client = {
      createHumanUser: vi.fn().mockResolvedValue(undefined),
      updateHumanUser: vi.fn().mockResolvedValue(undefined),
      ensureAuthorization: vi.fn().mockResolvedValue(undefined),
      getUser: vi
        .fn()
        .mockResolvedValueOnce({
          id: "user-owner",
          username: "owner@example.com",
          email: "owner@example.com",
          displayName: "Old display name",
        })
        .mockResolvedValueOnce({
          id: "user-platform-admin",
          username: "old-admin@example.com",
          email: "old-admin@example.com",
          displayName: "Platform Admin",
        }),
    } as unknown as ZitadelClient;

    await provisionLocalHumans(client, users, "project-id", "organization-id");

    expect(client.createHumanUser).not.toHaveBeenCalled();
    expect(client.updateHumanUser).toHaveBeenCalledTimes(2);
    expect(client.updateHumanUser).toHaveBeenNthCalledWith(1, {
      userId: "user-owner",
      email: "owner@example.com",
      displayName: "Tenant Owner",
    });
    expect(client.updateHumanUser).toHaveBeenNthCalledWith(2, {
      userId: "user-platform-admin",
      email: "admin@example.com",
      displayName: "Platform Admin",
    });
  });
});

describe("local bootstrap profile", () => {
  it("configures ZITADEL clients from the profiled catalog origins", async () => {
    const catalog = applyLocalCatalogProfile(
      catalogSchema.parse({
        issuer: "http://localhost:24455",
        console_path: "/ui/console",
        instance_organization: { name: "Ensombl", domain: "ensombl.localhost" },
        email: {
          from_address: "noreply@notifications.ensombl.io",
          default_from_name: "Ensombl",
        },
        products: [
          {
            id: "freightclaims",
            display_name: "FreightClaims",
            auth_origin: "http://localhost:24455",
            email_from_name: "FreightClaims",
            owner_organization: { name: "Ensombl", domain: "ensombl.localhost" },
            branding: {
              primary_color: "#123456",
              warn_color: "#123456",
              background_color: "#123456",
              font_color: "#123456",
              primary_color_dark: "#123456",
              warn_color_dark: "#123456",
              background_color_dark: "#123456",
              font_color_dark: "#123456",
            },
            migration_service_account: {
              id: "01900000-0000-7000-8000-000000000200",
              username: "freightclaims-local-migration",
              display_name: "FreightClaims local migration",
              verify_imported_passwords: true,
            },
            applications: [
              {
                environment: "local",
                name: "FreightClaims local web",
                base_url: "http://localhost:4200",
                development_mode: true,
                management_service_account: {
                  id: "01900000-0000-7000-8000-000000000100",
                  username: "freightclaims-local-management",
                  display_name: "FreightClaims local management",
                },
              },
            ],
          },
        ],
      }),
      {
        applicationBaseUrl: "http://localhost:26033",
        issuer: "http://localhost:26041",
      },
    );
    const ensureAdministrator = vi.fn().mockResolvedValue(undefined);
    const deleteAdministrator = vi.fn().mockResolvedValue(undefined);
    const client = {
      addTrustedDomain: vi.fn().mockResolvedValue(undefined),
      applyBranding: vi.fn().mockResolvedValue(undefined),
      configureOidcApplicationLogin: vi.fn().mockResolvedValue(undefined),
      configureProject: vi.fn().mockResolvedValue(undefined),
      createOidcApplication: vi.fn().mockResolvedValue({
        applicationId: "application-id",
        clientId: "client-id",
        clientSecret: "client-secret",
      }),
      createServiceAccount: vi.fn().mockResolvedValue(undefined),
      deleteAdministrator,
      disableInstanceLoginV2Override: vi.fn().mockResolvedValue(undefined),
      ensureAdministrator,
      ensureLoginPolicy: vi.fn().mockResolvedValue(undefined),
      ensurePrimaryOrganizationDomain: vi.fn().mockResolvedValue(undefined),
      findApplicationByName: vi.fn().mockResolvedValue({
        applicationId: "console-application-id",
        name: "Management Console",
        oidcConfiguration: { clientId: "console-client-id" },
        projectId: "console-project-id",
      }),
      generateServiceAccountSecret: vi.fn().mockResolvedValue("management-secret"),
      getUser: vi.fn().mockResolvedValue(undefined),
      listApplications: vi.fn().mockResolvedValue([]),
      listOrganizations: vi
        .fn()
        .mockResolvedValue([{ id: "ensombl-organization-id", name: "Ensombl" }]),
      listProjectRoles: vi.fn().mockResolvedValue([]),
      listProjects: vi.fn().mockResolvedValue([
        {
          projectId: "console-project-id",
          organizationId: "ensombl-organization-id",
          name: "ZITADEL",
        },
        {
          projectId: "freightclaims-project-id",
          organizationId: "ensombl-organization-id",
          name: "FreightClaims",
        },
      ]),
    } as unknown as ZitadelClient;

    const runtime = await bootstrapCatalog(client, catalog, { rotateMissingSecrets: true });

    expect(client.configureOidcApplicationLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        loginBaseUri: "http://localhost:26041/ui/v2/login/",
      }),
    );
    expect(client.createOidcApplication).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://localhost:26033",
        loginBaseUri: "http://localhost:26041/ui/v2/login/",
      }),
    );
    expect(runtime.issuer).toBe("http://localhost:26041");
    expect(runtime.products.freightclaims?.applications.local?.baseUrl).toBe(
      "http://localhost:26033",
    );
    expect(
      ensureAdministrator.mock.calls.filter(([input]) => "instance" in input.resource),
    ).toEqual([
      [
        {
          userId: "01900000-0000-7000-8000-000000000200",
          resource: { instance: true },
          roles: ["IAM_LOGIN_CLIENT"],
        },
      ],
    ]);
    expect(ensureAdministrator).toHaveBeenCalledWith({
      userId: "01900000-0000-7000-8000-000000000200",
      resource: { organizationId: "ensombl-organization-id" },
      roles: ["ORG_USER_MANAGER"],
    });

    const product = catalog.products[0];
    if (!product?.migration_service_account) throw new Error("Expected migration service account");
    const withoutVerification = catalogSchema.parse({
      ...catalog,
      products: [
        {
          ...product,
          migration_service_account: {
            ...product.migration_service_account,
            verify_imported_passwords: false,
          },
        },
      ],
    });
    await bootstrapCatalog(client, withoutVerification, { rotateMissingSecrets: true });
    expect(deleteAdministrator).toHaveBeenCalledWith({
      userId: "01900000-0000-7000-8000-000000000200",
      resource: { instance: true },
    });
  });
});
