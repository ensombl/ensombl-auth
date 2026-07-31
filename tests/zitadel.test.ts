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
    oidcConfiguration?: {
      loginVersion?: { loginV2?: { baseUri?: string } };
    };
  };
}

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
    });

    expect(requestBody(request).oidcConfiguration?.loginVersion).toEqual({
      loginV2: { baseUri: "https://auth.freightcheck.io/ui/v2/login/" },
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
    });

    expect(requestBody(request).loginVersion).toEqual({
      loginV2: { baseUri: "https://auth.freightclaims.com/ui/v2/login/" },
    });
    expect(request.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-zitadel-orgid": "organization-id",
    });
  });

  it("accepts ZITADEL's idempotent no-changes response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ code: 9, message: "No changes (COMMAND-test)" }, { status: 400 }),
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
  it("repairs the active provider with Resend plain authentication", async () => {
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
    ).resolves.toBe("smtp-provider-id");

    expect(new URL(String(request.mock.calls[0]?.[0])).pathname).toBe("/admin/v1/email/_search");
    expect(new URL(String(request.mock.calls[1]?.[0])).pathname).toBe(
      "/admin/v1/email/smtp/smtp-provider-id",
    );
    expect(request.mock.calls[1]?.[1]?.method).toBe("PUT");
    expect(requestBody(request, 1)).toMatchObject({
      host: "smtp.resend.com:587",
      user: "resend",
      plain: { password: "resend-api-key" },
      tls: true,
    });
  });

  it("creates an SMTP provider when the instance has none", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ result: [] }))
      .mockResolvedValueOnce(Response.json({ id: "new-smtp-provider-id" }));
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
  });
});
