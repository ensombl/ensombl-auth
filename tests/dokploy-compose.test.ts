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

  it("bounds setup-email triggers while proxying Login V2", () => {
    expect(productLoginProxy).toContain(
      "limit_req_zone $login_name_limit_key zone=login_name_actions:10m rate=10r/m;",
    );
    expect(productLoginProxy).toContain("POST $binary_remote_addr;");
    expect(productLoginProxy).not.toContain("$http_cf_connecting_ip");
    expect(productLoginProxy).toContain("set_real_ip_from 173.245.48.0/20;");
    expect(productLoginProxy).toContain("location ~ ^/ui/v2/login/loginname/?$");
    expect(productLoginProxy).toContain("limit_req zone=login_name_actions burst=5 nodelay;");
    expect(productLoginProxy).toContain("proxy_pass http://zitadel-login:3000;");
    expect(productLoginProxy).toContain("location = /ui/v2/login");
    expect(productLoginProxy).toContain("return 308 /ui/v2/login/;");
  });
});
