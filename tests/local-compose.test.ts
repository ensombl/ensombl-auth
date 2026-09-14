import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const localCompose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");

describe("local Compose profile", () => {
  it("redirects browser aliases to the issuer without rewriting the login host", () => {
    expect(localCompose).toContain(
      "-canonical.rule=!Host(`localhost`) && (Path(`/`) || PathPrefix(`/ui/`))",
    );
    expect(localCompose).toContain(
      `-canonical.redirectregex.replacement=\${LOCAL_AUTH_ISSUER:?LOCAL_AUTH_ISSUER is required}$\${1}`,
    );
    expect(localCompose).not.toContain(
      `-login.middlewares=\${LOCAL_RUNTIME_ID:?LOCAL_RUNTIME_ID is required}-host`,
    );
  });

  it("scopes project, network, ports, provider constraints, and Traefik labels", () => {
    for (const variable of [
      "LOCAL_AUTH_COMPOSE_PROJECT",
      "LOCAL_AUTH_NETWORK",
      "LOCAL_AUTH_PROXY_PORT",
      "LOCAL_AUTH_MAILPIT_UI_PORT",
      "LOCAL_RUNTIME_ID",
    ]) {
      expect(localCompose).toContain(`\${${variable}:?`);
    }
    expect(localCompose).not.toContain("name: ensombl-auth-local");
    expect(localCompose).not.toContain("127.0.0.1:24455");
    expect(localCompose).not.toContain("127.0.0.1:28025");
  });

  it("passes the profile origins into ZITADEL and product bootstrap", () => {
    expect(localCompose).toContain(
      "ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_BASEURI: ${LOCAL_AUTH_ISSUER:",
    );
    expect(localCompose).toContain("LOCAL_APPLICATION_BASE_URL: ${LOCAL_APPLICATION_BASE_URL:");
    expect(localCompose).toContain("LOCAL_AUTH_ISSUER: ${LOCAL_AUTH_ISSUER:");
  });
});
