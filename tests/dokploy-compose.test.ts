import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const hostedCompose = readFileSync(
  new URL("../deploy/dokploy/compose.yml", import.meta.url),
  "utf8",
);

describe("Dokploy Compose ownership", () => {
  it("leaves public domains and Traefik networking to Dokploy", () => {
    expect(hostedCompose).not.toContain("traefik.");
    expect(hostedCompose).not.toContain("dokploy-network");
  });
});
