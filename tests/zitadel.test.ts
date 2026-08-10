import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { ZitadelClient } from "../src/zitadel.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function requestBody(request: MockInstance<typeof fetch>, index = 0) {
  const init = request.mock.calls[index]?.[1];
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
  return JSON.parse(init.body) as {
    appType?: string;
    loginVersion?: { loginV2?: { baseUri?: string } };
    postLogoutRedirectUris?: string[];
    oidcConfiguration?: {
      loginVersion?: { loginV2?: { baseUri?: string } };
      accessTokenRoleAssertion?: boolean;
      idTokenRoleAssertion?: boolean;
      postLogoutRedirectUris?: string[];
    };
    accessTokenRoleAssertion?: boolean;
    idTokenRoleAssertion?: boolean;
    username?: string;
    human?: {
      profile?: { givenName?: string; familyName?: string; displayName?: string };
      email?: { email?: string; isVerified?: boolean };
      password?: { password?: string; changeRequired?: boolean };
    };
  };
}

describe("ZitadelClient human users", () => {
  it("creates a human fixture with its requested password-change state", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ id: "user-id" }));
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await client.createHumanUser({
      organizationId: "organization-id",
      userId: "user-id",
      email: "member@example.com",
      displayName: "Fixture Member",
      password: "Local-password-2026!",
      passwordChangeRequired: true,
    });

    expect(new URL(String(request.mock.calls[0]?.[0])).pathname).toBe("/v2/users/new");
    expect(requestBody(request)).toMatchObject({
      human: {
        password: { password: "Local-password-2026!", changeRequired: true },
      },
    });
  });

  it("reads human fixture metadata and updates it through the v2 API", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          user: {
            username: "old@example.com",
            human: {
              profile: { displayName: "Old name" },
              email: { email: "old@example.com" },
            },
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({}));
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await expect(client.getUser("user-id")).resolves.toEqual({
      id: "user-id",
      username: "old@example.com",
      email: "old@example.com",
      displayName: "Old name",
    });
    await client.updateHumanUser({
      userId: "user-id",
      email: "new@example.com",
      displayName: "New Name",
    });

    expect(new URL(String(request.mock.calls[1]?.[0])).pathname).toBe("/v2/users/user-id");
    expect(request.mock.calls[1]?.[1]?.method).toBe("PATCH");
    expect(requestBody(request, 1)).toEqual({
      username: "new@example.com",
      human: {
        profile: {
          givenName: "New",
          familyName: "Name",
          displayName: "New Name",
        },
        email: { email: "new@example.com", isVerified: true },
      },
    });
  });
});

describe("ZitadelClient OIDC applications", () => {
  it("creates applications with the product Login V2 base URI", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        applicationId: "application-id",
        oidcConfiguration: {
          clientId: "client-id",
          clientSecret: "client-secret",
        },
      }),
    );
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await client.createOidcApplication({
      projectId: "project-id",
      name: "FreightCheck production web",
      baseUrl: "https://app.freightcheck.io",
      developmentMode: false,
      loginBaseUri: "https://auth.freightcheck.io/ui/v2/login/",
      roleAssertion: false,
    });

    expect(requestBody(request).oidcConfiguration?.loginVersion).toEqual({
      loginV2: { baseUri: "https://auth.freightcheck.io/ui/v2/login/" },
    });
    expect(requestBody(request).oidcConfiguration).toMatchObject({
      accessTokenRoleAssertion: false,
      idTokenRoleAssertion: false,
      postLogoutRedirectUris: ["https://app.freightcheck.io/auth/signed-out"],
    });
  });

  it("configures applications with the product Login V2 base URI", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await client.configureOidcApplication({
      applicationId: "application-id",
      projectId: "project-id",
      organizationId: "organization-id",
      baseUrl: "https://app.freightclaims.ensombl.io",
      developmentMode: false,
      loginBaseUri: "https://auth.freightclaims.com/ui/v2/login/",
      roleAssertion: false,
    });

    expect(requestBody(request).loginVersion).toEqual({
      loginV2: { baseUri: "https://auth.freightclaims.com/ui/v2/login/" },
    });
    expect(requestBody(request)).toMatchObject({
      accessTokenRoleAssertion: false,
      idTokenRoleAssertion: false,
      postLogoutRedirectUris: ["https://app.freightclaims.ensombl.io/auth/signed-out"],
    });
    expect(request.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-zitadel-orgid": "organization-id",
    });
  });

  it.each([
    "No changes (COMMAND-test)",
    "Private Label Policy has not been changed (Org-test)",
    "Errors.Org.LoginPolicy.NotChanged (Org-test)",
  ])("accepts ZITADEL's idempotent no-changes response: %s", async (message) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ code: 9, message }, { status: 400 }),
    );
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await expect(
      client.configureOidcApplication({
        applicationId: "application-id",
        projectId: "project-id",
        organizationId: "organization-id",
        baseUrl: "https://app.freightclaims.ensombl.io",
        developmentMode: false,
        loginBaseUri: "https://auth.freightclaims.com/ui/v2/login/",
        roleAssertion: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("pins the Management Console to the canonical Login V2 host", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          application: {
            applicationId: "console-application-id",
            projectId: "console-project-id",
            name: "Management Console",
            oidcConfiguration: {
              clientId: "console-client-id",
              redirectUris: ["https://auth.ensombl.io/ui/console/auth/callback"],
              responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
              grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"],
              applicationType: "OIDC_APP_TYPE_USER_AGENT",
              authMethodType: "OIDC_AUTH_METHOD_TYPE_NONE",
              postLogoutRedirectUris: ["https://auth.ensombl.io/ui/console/signedout"],
              developmentMode: false,
            },
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({}));
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await client.configureOidcApplicationLogin({
      applicationId: "console-application-id",
      projectId: "console-project-id",
      organizationId: "ensombl-organization-id",
      loginBaseUri: "https://auth.ensombl.io/ui/v2/login/",
    });

    expect(requestBody(request, 1)).toMatchObject({
      appType: "OIDC_APP_TYPE_USER_AGENT",
      loginVersion: {
        loginV2: { baseUri: "https://auth.ensombl.io/ui/v2/login/" },
      },
    });
  });

  it("disables the instance-wide override so application login hosts apply", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await client.disableInstanceLoginV2Override();

    expect(requestBody(request)).toEqual({ loginV2: { required: false } });
  });
});

describe("ZitadelClient project authorization", () => {
  it("creates projects without requiring a role assignment for login", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ projectId: "project-id" }));
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await expect(client.createProject("organization-id", "Product")).resolves.toBe("project-id");

    expect(requestBody(request)).toMatchObject({
      organizationId: "organization-id",
      projectRoleAssertion: false,
      authorizationRequired: false,
      projectAccessRequired: false,
    });
  });

  it("removes an obsolete project role and its dependent assignments", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await client.removeProjectRole("project-id", "obsolete-role");

    expect(new URL(String(request.mock.calls[0]?.[0])).pathname).toBe(
      "/zitadel.project.v2.ProjectService/RemoveProjectRole",
    );
    expect(requestBody(request)).toEqual({
      projectId: "project-id",
      roleKey: "obsolete-role",
    });
  });

  it("configures a role-free project without an authorization gate", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await client.configureProject("project-id", false);

    expect(new URL(String(request.mock.calls[0]?.[0])).pathname).toBe(
      "/zitadel.project.v2.ProjectService/UpdateProject",
    );
    expect(requestBody(request)).toMatchObject({
      projectId: "project-id",
      projectRoleAssertion: false,
      authorizationRequired: false,
      projectAccessRequired: false,
    });
  });

  it("asserts project roles without requiring one for login", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await client.configureProject("project-id", true);

    expect(requestBody(request)).toMatchObject({
      projectId: "project-id",
      projectRoleAssertion: true,
      authorizationRequired: false,
      projectAccessRequired: false,
    });
  });

  it("removes a role assignment when no product roles are declared", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          authorizations: [
            {
              id: "authorization-id",
              user: { id: "user-id" },
              project: { id: "project-id" },
              organization: { id: "organization-id" },
              roles: [{ key: "platform_admin" }],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({}));
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await client.ensureAuthorization({
      userId: "user-id",
      projectId: "project-id",
      organizationId: "organization-id",
      roleKeys: [],
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(new URL(String(request.mock.calls[1]?.[0])).pathname).toBe(
      "/zitadel.authorization.v2.AuthorizationService/DeleteAuthorization",
    );
    expect(requestBody(request, 1)).toEqual({ id: "authorization-id" });
  });
});

describe("ZitadelClient product login presentation", () => {
  const branding = {
    primary_color: "#126B56",
    warn_color: "#BA1A1A",
    background_color: "#F2F4F3",
    font_color: "#000000",
    primary_color_dark: "#84ADFF",
    warn_color_dark: "#FDA29B",
    background_color_dark: "#101828",
    font_color_dark: "#F9FAFB",
    theme_mode: "THEME_MODE_LIGHT" as const,
    hide_login_name_suffix: true,
  };

  it("uploads and activates a product logo through the native assets API", async () => {
    const currentPolicy = {
      policy: {
        primaryColor: "#126B56",
        warnColor: "#BA1A1A",
        backgroundColor: "#F2F4F3",
        fontColor: "#000000",
        primaryColorDark: "#84ADFF",
        warnColorDark: "#FDA29B",
        backgroundColorDark: "#101828",
        fontColorDark: "#F9FAFB",
        hideLoginNameSuffix: true,
        disableWatermark: true,
        themeMode: "THEME_MODE_LIGHT",
        isDefault: false,
      },
      isDefault: false,
    };
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(currentPolicy))
      .mockResolvedValueOnce(Response.json(currentPolicy))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({}));
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await client.applyBranding("freightclaims-org", branding, new Uint8Array([1, 2, 3]));

    expect(new URL(String(request.mock.calls[2]?.[0])).pathname).toBe(
      "/assets/v1/org/policy/label/logo",
    );
    expect(request.mock.calls[2]?.[1]?.body).toBeInstanceOf(FormData);
    expect(request.mock.calls[2]?.[1]?.headers).toMatchObject({
      "x-zitadel-orgid": "freightclaims-org",
    });
    expect(new URL(String(request.mock.calls[3]?.[0])).pathname).toBe(
      "/management/v1/policies/label/_activate",
    );
  });

  it("activates an already-updated preview when retrying an interrupted bootstrap", async () => {
    const desiredPolicy = {
      primaryColor: "#126B56",
      warnColor: "#BA1A1A",
      backgroundColor: "#F2F4F3",
      fontColor: "#000000",
      primaryColorDark: "#84ADFF",
      warnColorDark: "#FDA29B",
      backgroundColorDark: "#101828",
      fontColorDark: "#F9FAFB",
      hideLoginNameSuffix: true,
      disableWatermark: true,
      themeMode: "THEME_MODE_LIGHT",
      isDefault: false,
    };
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          policy: { ...desiredPolicy, primaryColor: "#155EEF" },
          isDefault: false,
        }),
      )
      .mockResolvedValueOnce(Response.json({ policy: desiredPolicy, isDefault: false }))
      .mockResolvedValueOnce(Response.json({}));
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await client.applyBranding("freightclaims-org", branding);

    expect(request).toHaveBeenCalledTimes(3);
    expect(new URL(String(request.mock.calls[1]?.[0])).pathname).toBe(
      "/management/v1/policies/label/_preview",
    );
    expect(new URL(String(request.mock.calls[2]?.[0])).pathname).toBe(
      "/management/v1/policies/label/_activate",
    );
    expect(request.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });

  it("tolerates ZITADEL rejecting a label policy update as already applied", async () => {
    const desiredPolicy = {
      primaryColor: "#126B56",
      warnColor: "#BA1A1A",
      backgroundColor: "#F2F4F3",
      fontColor: "#000000",
      primaryColorDark: "#84ADFF",
      warnColorDark: "#FDA29B",
      backgroundColorDark: "#101828",
      fontColorDark: "#F9FAFB",
      hideLoginNameSuffix: true,
      disableWatermark: true,
      themeMode: "THEME_MODE_LIGHT",
      isDefault: false,
    };
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ policy: { ...desiredPolicy, primaryColor: "#155EEF" }, isDefault: false }),
      )
      .mockResolvedValueOnce(
        Response.json({ policy: { ...desiredPolicy, primaryColor: "#155EEF" }, isDefault: false }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            code: 9,
            message: "Private Label Policy has not been changed (Org-8nfSr)",
            details: [
              {
                "@type": "type.googleapis.com/zitadel.v1.ErrorDetail",
                id: "Org-8nfSr",
                message: "Private Label Policy has not been changed",
              },
            ],
          },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(Response.json({}));
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await expect(client.applyBranding("freightclaims-org", branding)).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(4);
    expect(new URL(String(request.mock.calls[3]?.[0])).pathname).toBe(
      "/management/v1/policies/label/_activate",
    );
  });

  it("loads an advertised logo through the configured internal API URL", async () => {
    const policy = {
      primaryColor: "#126B56",
      warnColor: "#BA1A1A",
      backgroundColor: "#F2F4F3",
      fontColor: "#000000",
      primaryColorDark: "#84ADFF",
      warnColorDark: "#FDA29B",
      backgroundColorDark: "#101828",
      fontColorDark: "#F9FAFB",
      hideLoginNameSuffix: true,
      disableWatermark: true,
      themeMode: "THEME_MODE_LIGHT",
      logoUrl: "http://localhost:24455/assets/v1/freightclaims/logo",
      isDefault: false,
    };
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ policy, isDefault: false }))
      .mockResolvedValueOnce(Response.json({ policy, isDefault: false }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    const client = new ZitadelClient("http://proxy", "bootstrap-pat", {
      host: "localhost",
    });

    await client.applyBranding("freightclaims-org", branding, new Uint8Array([1, 2, 3]));

    expect(request).toHaveBeenCalledTimes(3);
    expect(new URL(String(request.mock.calls[2]?.[0])).toString()).toBe(
      "http://proxy/assets/v1/freightclaims/logo",
    );
  });

  it("pins product login to password and recovery without self-registration", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          policy: {
            allowUsernamePassword: true,
            allowRegister: true,
            allowExternalIdp: true,
            forceMfa: false,
            passwordlessType: "PASSWORDLESS_TYPE_NOT_ALLOWED",
            hidePasswordReset: false,
            ignoreUnknownUsernames: false,
            defaultRedirectUri: "https://auth.ensombl.io/",
            passwordCheckLifetime: "864000s",
            externalLoginCheckLifetime: "864000s",
            mfaInitSkipLifetime: "2592000s",
            secondFactorCheckLifetime: "64800s",
            multiFactorCheckLifetime: "43200s",
            allowDomainDiscovery: true,
            disableLoginWithEmail: false,
            disableLoginWithPhone: false,
            forceMfaLocalOnly: false,
            isDefault: true,
          },
          isDefault: true,
        }),
      )
      .mockResolvedValueOnce(Response.json({}));
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await client.ensureLoginPolicy("freightclaims-org", {
      allow_username_password: true,
      allow_self_registration: false,
      allow_external_identity_providers: false,
      allow_password_reset: true,
      ignore_unknown_usernames: true,
      allow_domain_discovery: false,
      disable_login_with_email: false,
      disable_login_with_phone: true,
    });

    expect(request.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(requestBody(request, 1)).toMatchObject({
      allowUsernamePassword: true,
      allowRegister: false,
      allowExternalIdp: false,
      hidePasswordReset: false,
      ignoreUnknownUsernames: true,
      allowDomainDiscovery: false,
      disableLoginWithEmail: false,
      disableLoginWithPhone: true,
    });
  });
});

describe("ZitadelClient organization domains", () => {
  it("adds a native instance trusted domain", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await client.addTrustedDomain("auth.freightcheck.io");

    expect(new URL(String(request.mock.calls[0]?.[0])).pathname).toBe(
      "/zitadel.instance.v2.InstanceService/AddTrustedDomain",
    );
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      "connect-protocol-version": "1",
    });
    expect(requestBody(request)).toEqual({ trustedDomain: "auth.freightcheck.io" });
  });

  it("accepts a trusted domain that already exists", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          code: "failed_precondition",
          message: "Errors.Instance.Domain.AlreadyExists (COMMA-test)",
        },
        { status: 400 },
      ),
    );
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await expect(client.addTrustedDomain("auth.freightclaims.com")).resolves.toBeUndefined();
  });

  it("makes the declared organization domain primary", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          domains: [
            {
              domain: "ensombl.auth.ensombl.io",
              isPrimary: true,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({}));
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await client.ensurePrimaryOrganizationDomain(
      "organization-id",
      "ensombl.io",
      ".auth.ensombl.io",
    );

    expect(request).toHaveBeenCalledTimes(4);
    expect(new URL(String(request.mock.calls[1]?.[0])).pathname).toBe(
      "/v2/organizations/organization-id/domains",
    );
    expect(new URL(String(request.mock.calls[2]?.[0])).pathname).toBe(
      "/management/v1/orgs/me/domains/ensombl.io/_set_primary",
    );
    const cleanupUrl = new URL(String(request.mock.calls[3]?.[0]));
    expect(cleanupUrl.pathname).toBe("/v2/organizations/organization-id/domains");
    expect(cleanupUrl.searchParams.get("domain")).toBe("ensombl.auth.ensombl.io");
    expect(request.mock.calls[3]?.[1]?.method).toBe("DELETE");
  });

  it("accepts a generated domain before its projection is visible", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ domains: [] }))
      .mockResolvedValueOnce(
        Response.json({ code: 6, message: "Errors.Already.Exists (V2-e1wse)" }, { status: 409 }),
      )
      .mockResolvedValueOnce(Response.json({}));
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await expect(
      client.ensurePrimaryOrganizationDomain("organization-id", "freightclaims.localhost"),
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(3);
  });
});

describe("ZitadelClient SMTP email provider", () => {
  it("replaces a broken active provider with Resend plain authentication", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          result: [
            {
              id: "smtp-provider-id",
              state: "EMAIL_PROVIDER_ACTIVE",
              smtp: { host: "smtp.resend.com:465" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({ id: "replacement-provider-id" }))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({}));
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await expect(
      client.ensureSmtpEmailProvider({
        host: "smtp.resend.com:587",
        user: "resend",
        password: "resend-api-key",
        senderAddress: "noreply@notifications.ensombl.io",
        senderName: "Ensombl",
        replyToAddress: "noreply@notifications.ensombl.io",
        description: "Ensombl system notifications via Resend",
        tls: true,
      }),
    ).resolves.toBe("replacement-provider-id");

    expect(new URL(String(request.mock.calls[0]?.[0])).pathname).toBe("/admin/v1/email/_search");
    expect(new URL(String(request.mock.calls[1]?.[0])).pathname).toBe("/admin/v1/email/smtp");
    expect(request.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(requestBody(request, 1)).toMatchObject({
      host: "smtp.resend.com:587",
      user: "resend",
      plain: { password: "resend-api-key" },
      tls: true,
    });
    expect(new URL(String(request.mock.calls[2]?.[0])).pathname).toBe(
      "/admin/v1/email/replacement-provider-id/_activate",
    );
    expect(new URL(String(request.mock.calls[3]?.[0])).pathname).toBe(
      "/admin/v1/email/smtp-provider-id",
    );
    expect(request.mock.calls[3]?.[1]?.method).toBe("DELETE");
  });

  it("creates an SMTP provider when the instance has none", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ result: [] }))
      .mockResolvedValueOnce(Response.json({ id: "new-smtp-provider-id" }))
      .mockResolvedValueOnce(Response.json({}));
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await expect(
      client.ensureSmtpEmailProvider({
        host: "smtp.resend.com:587",
        user: "resend",
        password: "resend-api-key",
        senderAddress: "noreply@notifications.ensombl.io",
        senderName: "Ensombl",
        replyToAddress: "noreply@notifications.ensombl.io",
        description: "Ensombl system notifications via Resend",
        tls: true,
      }),
    ).resolves.toBe("new-smtp-provider-id");

    expect(new URL(String(request.mock.calls[1]?.[0])).pathname).toBe("/admin/v1/email/smtp");
    expect(request.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(new URL(String(request.mock.calls[2]?.[0])).pathname).toBe(
      "/admin/v1/email/new-smtp-provider-id/_activate",
    );
  });

  it("updates an existing Resend provider without the ZITADEL password projection bug", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          result: [
            {
              id: "smtp-provider-id",
              state: "EMAIL_PROVIDER_ACTIVE",
              smtp: {
                host: "smtp.resend.com:587",
                user: "resend",
                plain: {},
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({}));
    const client = new ZitadelClient("https://auth.ensombl.io", "bootstrap-pat");

    await client.ensureSmtpEmailProvider({
      host: "smtp.resend.com:587",
      user: "resend",
      password: "rotated-resend-api-key",
      senderAddress: "noreply@notifications.ensombl.io",
      senderName: "Ensombl",
      replyToAddress: "noreply@notifications.ensombl.io",
      description: "Ensombl system notifications via Resend",
      tls: true,
    });

    expect(requestBody(request, 1)).not.toHaveProperty("plain");
    expect(new URL(String(request.mock.calls[2]?.[0])).pathname).toBe(
      "/admin/v1/email/smtp/smtp-provider-id/password",
    );
    expect(requestBody(request, 2)).toEqual({ password: "rotated-resend-api-key" });
  });
});
