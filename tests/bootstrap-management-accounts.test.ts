import { describe, expect, it, vi } from "vitest";
import { bootstrapCatalog } from "../src/bootstrap.js";
import { catalogSchema } from "../src/catalog.js";
import type { ZitadelClient } from "../src/zitadel.js";

const branding = {
  primary_color: "#123456",
  warn_color: "#123456",
  background_color: "#123456",
  font_color: "#123456",
  primary_color_dark: "#123456",
  warn_color_dark: "#123456",
  background_color_dark: "#123456",
  font_color_dark: "#123456",
};

const managementServiceAccountId = "01900000-0000-7000-8000-0000000000aa";

function catalogFor(instanceOrgUserLookup: boolean, instanceUserLookup = false) {
  return catalogSchema.parse({
    issuer: "https://auth.ensombl.io",
    console_path: "/ui/console",
    instance_organization: { name: "Ensombl", domain: "ensombl.io" },
    email: {
      from_address: "noreply@notifications.ensombl.io",
      default_from_name: "Ensombl",
    },
    products: [
      {
        id: "freightcheck",
        display_name: "FreightCheck",
        auth_origin: "https://auth.freightcheck.io",
        email_from_name: "FreightCheck",
        owner_organization: { name: "FreightCheck", domain: "freightcheck.io" },
        instance_org_user_lookup: instanceOrgUserLookup,
        instance_user_lookup: instanceUserLookup,
        branding,
        applications: [
          {
            environment: "staging",
            name: "FreightCheck staging web",
            base_url: "https://app.staging.freightcheck.io",
            management_service_account: {
              id: managementServiceAccountId,
              username: "freightcheck-staging-management",
              display_name: "FreightCheck staging management",
            },
          },
        ],
      },
    ],
  });
}

function mockClient() {
  const ensureAdministrator = vi.fn().mockResolvedValue(undefined);
  const deleteAdministrator = vi.fn().mockResolvedValue(undefined);
  const client = {
    addTrustedDomain: vi.fn().mockResolvedValue(undefined),
    applyBranding: vi.fn().mockResolvedValue(undefined),
    configureOidcApplication: vi.fn().mockResolvedValue(undefined),
    configureOidcApplicationLogin: vi.fn().mockResolvedValue(undefined),
    configureProject: vi.fn().mockResolvedValue(undefined),
    createOidcApplication: vi.fn().mockResolvedValue({
      applicationId: "application-id",
      clientId: "client-id",
      clientSecret: "client-secret",
    }),
    createOrganization: vi
      .fn()
      .mockResolvedValue({ id: "freightcheck-organization-id", name: "FreightCheck" }),
    createProject: vi.fn().mockResolvedValue("freightcheck-project-id"),
    createServiceAccount: vi.fn().mockResolvedValue(undefined),
    deleteAdministrator,
    disableInstanceLoginV2Override: vi.fn().mockResolvedValue(undefined),
    ensureAdministrator,
    ensureRegistrationGuidance: vi.fn().mockResolvedValue(undefined),
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
    ]),
  } as unknown as ZitadelClient;
  return { client, ensureAdministrator, deleteAdministrator };
}

const instanceOrgResource = { resource: { organizationId: "ensombl-organization-id" } };

describe("management service account instance-organization grant", () => {
  it("grants read-only ORG_OWNER_VIEWER on the instance organization when instance_org_user_lookup is set", async () => {
    const { client, ensureAdministrator, deleteAdministrator } = mockClient();

    await bootstrapCatalog(client, catalogFor(true), { rotateMissingSecrets: true });

    expect(ensureAdministrator).toHaveBeenCalledWith({
      userId: managementServiceAccountId,
      resource: { organizationId: "ensombl-organization-id" },
      roles: ["ORG_OWNER_VIEWER"],
    });
    expect(ensureAdministrator).toHaveBeenCalledWith({
      userId: managementServiceAccountId,
      resource: { organizationId: "freightcheck-organization-id" },
      roles: ["ORG_USER_MANAGER"],
    });
    expect(deleteAdministrator).not.toHaveBeenCalledWith(
      expect.objectContaining({
        userId: managementServiceAccountId,
        ...instanceOrgResource,
      }),
    );
    expect(deleteAdministrator).toHaveBeenCalledWith({
      userId: managementServiceAccountId,
      resource: { instance: true },
    });
  });

  it("strips any instance-organization membership when instance_org_user_lookup is not set", async () => {
    const { client, ensureAdministrator, deleteAdministrator } = mockClient();

    await bootstrapCatalog(client, catalogFor(false), { rotateMissingSecrets: true });

    expect(deleteAdministrator).toHaveBeenCalledWith({
      userId: managementServiceAccountId,
      resource: { organizationId: "ensombl-organization-id" },
    });
    expect(ensureAdministrator).not.toHaveBeenCalledWith(
      expect.objectContaining({
        userId: managementServiceAccountId,
        ...instanceOrgResource,
      }),
    );
    expect(ensureAdministrator).toHaveBeenCalledWith({
      userId: managementServiceAccountId,
      resource: { organizationId: "freightcheck-organization-id" },
      roles: ["ORG_USER_MANAGER"],
    });
  });
});

describe("management service account directory grant", () => {
  it.each([
    true,
    false,
  ])("reconciles instance lookup %s without an instance-organization grant", async (enabled) => {
    const { client, ensureAdministrator, deleteAdministrator } = mockClient();
    await bootstrapCatalog(client, catalogFor(false, enabled), { rotateMissingSecrets: true });
    const instanceGrant = {
      userId: managementServiceAccountId,
      resource: { instance: true },
      roles: ["IAM_FREIGHTCHECK_DIRECTORY_READER"],
    };
    if (enabled) {
      expect(ensureAdministrator).toHaveBeenCalledWith(instanceGrant);
      expect(deleteAdministrator).not.toHaveBeenCalledWith({
        userId: managementServiceAccountId,
        resource: { instance: true },
      });
    } else {
      expect(ensureAdministrator).not.toHaveBeenCalledWith(instanceGrant);
      expect(deleteAdministrator).toHaveBeenCalledWith({
        userId: managementServiceAccountId,
        resource: { instance: true },
      });
    }
    expect(deleteAdministrator).toHaveBeenCalledWith({
      userId: managementServiceAccountId,
      ...instanceOrgResource,
    });
    expect(ensureAdministrator).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: managementServiceAccountId, ...instanceOrgResource }),
    );
  });
});

describe("catalog registration guidance", () => {
  it("skips translations when the catalog does not configure them", async () => {
    const { client } = mockClient();
    await bootstrapCatalog(client, catalogFor(false), { rotateMissingSecrets: true });
    expect(client.ensureRegistrationGuidance).not.toHaveBeenCalled();
  });

  it("finishes provisioning and returns runtime even when configured translations fail", async () => {
    const { client } = mockClient();
    const guidance = { description: "Create an account.", creation_error: "Try again or sign in." };
    vi.mocked(client.ensureRegistrationGuidance).mockImplementation(async () => {
      expect(client.disableInstanceLoginV2Override).toHaveBeenCalled();
      throw new Error("translation API unavailable");
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const runtime = await bootstrapCatalog(
        client,
        { ...catalogFor(false), registration_guidance: guidance },
        { rotateMissingSecrets: true },
      );
      expect(
        runtime.products.freightcheck?.applications.staging?.managementServiceAccount.clientSecret,
      ).toBe("management-secret");
      expect(client.ensureRegistrationGuidance).toHaveBeenCalledWith(guidance);
      expect(warning).toHaveBeenCalledWith(
        "Registration guidance could not be applied; rerun bootstrap to retry.",
      );
    } finally {
      warning.mockRestore();
    }
  });
});
