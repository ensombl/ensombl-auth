import { afterEach, expect, it, vi } from "vitest";
import { loadCatalog } from "../src/catalog.js";
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
    new Uint8Array([1, 2, 3]),
    true,
    new Uint8Array([1, 2, 3]),
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
    client.applyBranding("freightcheck", branding, undefined, instance, icon),
  ).rejects.toThrow();
  await client.applyBranding("freightcheck", branding, undefined, instance, icon);
  await client.applyBranding("freightcheck", branding, undefined, instance, icon);
  expect(attempts).toBe(2);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
});
