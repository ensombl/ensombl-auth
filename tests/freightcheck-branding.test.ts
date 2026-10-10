import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { catalogSchema, loadCatalog } from "../src/catalog.js";
import { ZitadelClient } from "../src/zitadel.js";

afterEach(() => vi.restoreAllMocks());

it("uses FreightCheck issuer, mail identity, assets, and hosted return destination", async () => {
  const catalog = await loadCatalog("deploy/products/products.json");
  const product = catalog.products.find((entry) => entry.id === "freightcheck");
  expect(catalog.issuer).toBe("https://auth.freightcheck.io");
  expect(catalog.email.from_address).toBe("noreply@notifications.ensombl.io");
  expect(product?.branding.logo_base64_file).toContain("freightcheck-logo");
  expect(product?.branding.icon_base64_file).toContain("freightcheck-logo");
  expect(product?.login_policy.default_redirect_uri).toBe(
    "https://app.staging.freightcheck.io/auth/login?returnTo=%2Finvitations",
  );
  expect(product?.applications.every((application) => application.invitation_service_account)).toBe(
    true,
  );
});

it("activates instance branding and uploads the logo and icon through instance endpoints", async () => {
  const catalog = await loadCatalog("deploy/products/products.json");
  const product = catalog.products.find((entry) => entry.id === "freightcheck");
  if (!product) throw new Error("Missing FreightCheck");
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}));
  const client = new ZitadelClient("https://auth.freightcheck.io", "token");
  await client.applyBranding(
    "freightcheck",
    product.branding,
    { logo: new Uint8Array([1, 2, 3]), icon: new Uint8Array([1, 2, 3]) },
    true,
  );
  const urls = fetcher.mock.calls.map(([url]) => String(url));
  expect(urls).toContain("https://auth.freightcheck.io/admin/v1/policies/label/_activate");
  expect(urls).toContain("https://auth.freightcheck.io/assets/v1/instance/policy/label/logo");
  expect(urls).toContain("https://auth.freightcheck.io/assets/v1/instance/policy/label/icon");
  expect(urls.some((url) => url.includes("/management/"))).toBe(false);
});

it.each([
  false,
  true,
])("retries failed icon activation and remains idempotent (instance=%s)", async (instance) => {
  const catalog = await loadCatalog("deploy/products/products.json");
  const product = catalog.products[0];
  if (!product) throw new Error("Missing FreightCheck");
  const branding = product.branding;
  const policy = {
    primaryColor: branding.primary_color,
    warnColor: branding.warn_color,
    backgroundColor: branding.background_color,
    fontColor: branding.font_color,
    primaryColorDark: branding.primary_color_dark,
    warnColorDark: branding.warn_color_dark,
    backgroundColorDark: branding.background_color_dark,
    fontColorDark: branding.font_color_dark,
    hideLoginNameSuffix: branding.hide_login_name_suffix,
    disableWatermark: true,
    themeMode: branding.theme_mode,
  };
  const icon = new Uint8Array([1, 2, 3]);
  let activeIconUrl = "/assets/old-icon";
  let attempts = 0;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/_activate")) {
      attempts += 1;
      if (attempts === 1) return Response.json({ message: "Activation failed" }, { status: 500 });
      activeIconUrl = "/assets/new-icon";
      return Response.json({});
    }
    if (path === "/assets/new-icon") return new Response(icon);
    if (init?.method === "GET") {
      return Response.json({
        policy: {
          ...policy,
          iconUrl: path.endsWith("/_preview") ? "/assets/new-icon" : activeIconUrl,
        },
      });
    }
    throw new Error(`Unexpected request: ${String(url)}`);
  });
  const client = new ZitadelClient(catalog.issuer, "token");
  await expect(
    client.applyBranding("freightcheck", branding, { icon }, instance),
  ).rejects.toThrow();
  await client.applyBranding("freightcheck", branding, { icon }, instance);
  await client.applyBranding("freightcheck", branding, { icon }, instance);
  expect(attempts).toBe(2);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
});

it("names FreightCheck instead of ZITADEL on the English-only login pages", async () => {
  for (const fileName of ["products.json", "products.local.json"]) {
    const catalog = await loadCatalog(`deploy/products/${fileName}`);
    const branding = catalog.products[0]?.branding;
    expect(branding?.logo_dark_base64_file).toContain("freightcheck-logo");
    expect(branding?.icon_dark_base64_file).toContain("freightcheck-logo");
    expect(catalog.hosted_login?.allowed_languages).toEqual(["en"]);
    const texts = JSON.stringify(catalog.hosted_login?.translations);
    expect(texts).not.toMatch(/zitadel/i);
    expect(catalog.hosted_login?.translations.en).toMatchObject({
      loginname: { title: "Sign in to FreightCheck" },
      register: { description: "Create your FreightCheck account." },
    });
  }
});

it("rejects translations for a language the login does not offer", () => {
  const catalog = JSON.parse(readFileSync("deploy/products/products.json", "utf8"));
  catalog.hosted_login.translations.de = { common: { title: "FreightCheck" } };
  expect(catalogSchema.safeParse(catalog).success).toBe(false);
});

it.each([
  [true, "/assets/v1/instance/policy/label"],
  [false, "/assets/v1/org/policy/label"],
])("uploads dark-mode logo and icon (instance=%s)", async (instance, assetPrefix) => {
  const catalog = await loadCatalog("deploy/products/products.json");
  const branding = catalog.products[0]?.branding;
  if (!branding) throw new Error("Missing FreightCheck");
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}));
  const client = new ZitadelClient(catalog.issuer, "token");
  const asset = new Uint8Array([1, 2, 3]);
  await client.applyBranding(
    "freightcheck",
    branding,
    { logoDark: asset, iconDark: asset },
    instance,
  );
  const uploads = fetcher.mock.calls
    .filter(([, init]) => init?.body instanceof FormData)
    .map(([url]) => new URL(String(url)).pathname);
  expect(uploads).toEqual([`${assetPrefix}/logo/dark`, `${assetPrefix}/icon/dark`]);
});

it("keeps a dark-mode logo that already matches", async () => {
  const catalog = await loadCatalog("deploy/products/products.json");
  const branding = catalog.products[0]?.branding;
  if (!branding) throw new Error("Missing FreightCheck");
  const asset = new Uint8Array([1, 2, 3]);
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/assets/dark-logo") return new Response(asset);
    return Response.json({ policy: { logoUrlDark: "/assets/dark-logo" } });
  });
  const client = new ZitadelClient(catalog.issuer, "token");
  await client.applyBranding("freightcheck", branding, { logoDark: asset }, true);
  expect(fetcher.mock.calls.some(([, init]) => init?.body instanceof FormData)).toBe(false);
});

it("restricts the instance languages only when they differ", async () => {
  let allowed = ["en", "de"];
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (init?.method === "PUT") {
      allowed = JSON.parse(String(init.body)).allowedLanguages.list;
      return Response.json({});
    }
    return Response.json({ allowedLanguages: allowed });
  });
  const client = new ZitadelClient("https://auth.freightcheck.io", "token");
  await client.ensureAllowedLanguages(["en"]);
  await client.ensureAllowedLanguages(["en"]);
  const puts = fetcher.mock.calls.filter(([, init]) => init?.method === "PUT");
  expect(puts).toHaveLength(1);
  expect(String(puts[0]?.[0])).toBe("https://auth.freightcheck.io/admin/v1/restrictions");
  expect(allowed).toEqual(["en"]);
});

it("sets instance login texts only when they differ", async () => {
  const translations = { register: { description: "Create your FreightCheck account." } };
  let stored = {};
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (init?.method === "PUT") {
      stored = JSON.parse(String(init.body)).translations;
      return Response.json({});
    }
    const query = new URL(String(url)).searchParams;
    expect(query.get("instance")).toBe("true");
    expect(query.get("locale")).toBe("en");
    expect(query.get("ignoreInheritance")).toBe("true");
    return Response.json({ translations: stored });
  });
  const client = new ZitadelClient("https://auth.freightcheck.io", "token");
  await client.ensureHostedLoginTranslation("en", translations);
  await client.ensureHostedLoginTranslation("en", translations);
  const puts = fetcher.mock.calls.filter(([, init]) => init?.method === "PUT");
  expect(puts).toHaveLength(1);
  expect(JSON.parse(String(puts[0]?.[1]?.body))).toEqual({
    instance: true,
    locale: "en",
    translations,
  });
});

it("sets organization login texts at the organization level", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ translations: {} }));
  const client = new ZitadelClient("https://auth.freightcheck.io", "token");
  await client.ensureHostedLoginTranslation("en", { common: { title: "FreightCheck" } }, "org-id");
  const [getUrl] = fetcher.mock.calls[0] ?? [];
  const query = new URL(String(getUrl)).searchParams;
  expect(query.get("organizationId")).toBe("org-id");
  expect(query.has("instance")).toBe(false);
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
    organizationId: "org-id",
    locale: "en",
  });
});
