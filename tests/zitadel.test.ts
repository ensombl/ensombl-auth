import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { ZitadelClient } from "../src/zitadel.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function requestBody(request: MockInstance<typeof fetch>) {
  const init = request.mock.calls[0]?.[1];
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
  return JSON.parse(init.body) as {
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

  it("reconciles existing applications to the product Login V2 base URI", async () => {
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
});

describe("ZitadelClient organization domains", () => {
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
