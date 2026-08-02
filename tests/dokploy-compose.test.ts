import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const hostedCompose = readFileSync(
  new URL("../deploy/dokploy/compose.yml", import.meta.url),
  "utf8",
);
const productLoginProxy = readFileSync(
  new URL("../deploy/dokploy/product-login-root.nginx.conf", import.meta.url),
  "utf8",
);

describe("Dokploy Compose ownership", () => {
  it("leaves public domains and Traefik networking to Dokploy", () => {
    expect(hostedCompose).not.toContain("traefik.");
    expect(hostedCompose).not.toContain("dokploy-network");
    expect(hostedCompose).toContain("product-login-root:");
  });

  it("serves product branding assets from the canonical ZITADEL instance", () => {
    expect(productLoginProxy).toContain("location /assets/");
    expect(productLoginProxy).toContain("proxy_set_header Host auth.ensombl.io;");
    expect(productLoginProxy).toContain("proxy_pass http://zitadel-api:8080;");
  });
});
