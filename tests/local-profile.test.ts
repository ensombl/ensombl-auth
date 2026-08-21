import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  localAuthComposeEnvironment,
  localAuthRuntimeProfile,
  localCatalogProfileFromEnvironment,
} from "../src/local-profile.js";

const testRoot = mkdtempSync(resolve(tmpdir(), "ensombl-auth-profile-"));
const firstRoot = resolve(testRoot, "first");
const secondRoot = resolve(testRoot, "second");
mkdirSync(firstRoot);
mkdirSync(secondRoot);
const allocationDependencies = {
  candidatePortBases: [16_000, 16_016],
  ephemeralPortRange: [32_768, 60_999] as const,
  listeningPorts: () => new Set<number>(),
  registryPath: resolve(testRoot, "allocations.json"),
};

afterAll(() => rmSync(testRoot, { force: true, recursive: true }));

describe("local runtime profile", () => {
  it("reuses a reservation and assigns a distinct port block per repository path", () => {
    const first = localAuthRuntimeProfile(firstRoot, {}, allocationDependencies);
    expect(localAuthRuntimeProfile(firstRoot, {}, allocationDependencies)).toEqual({
      ...first,
      allocationCreated: false,
    });
    expect(localAuthRuntimeProfile(secondRoot, {}, allocationDependencies).portBase).not.toBe(
      first.portBase,
    );
    expect(first.id).toMatch(/^[a-f0-9]{16}$/u);
    expect(first.portBase % 16).toBe(0);
  });

  it("passes one profile through Compose, issuer, network, and application values", () => {
    const profile = localAuthRuntimeProfile(firstRoot, {}, allocationDependencies);
    const environment = localAuthComposeEnvironment(profile, {
      COMPOSE_PROJECT_NAME: "foreign",
      PATH: "/usr/bin",
    });

    expect(environment).toMatchObject({
      COMPOSE_PROJECT_NAME: profile.composeProject,
      LOCAL_APPLICATION_BASE_URL: profile.applicationBaseUrl,
      LOCAL_AUTH_COMPOSE_PROJECT: profile.composeProject,
      LOCAL_AUTH_ISSUER: profile.issuer,
      LOCAL_AUTH_MAILPIT_UI_PORT: String(profile.mailpitPort),
      LOCAL_AUTH_NETWORK: profile.network,
      LOCAL_AUTH_PROXY_PORT: String(profile.proxyPort),
      LOCAL_RUNTIME_ID: profile.id,
      PATH: "/usr/bin",
    });
    expect(new Set([profile.proxyPort, profile.mailpitPort]).size).toBe(2);
  });

  it("validates paired local catalog origins", () => {
    expect(
      localCatalogProfileFromEnvironment({
        LOCAL_APPLICATION_BASE_URL: "http://localhost:26033",
        LOCAL_AUTH_ISSUER: "http://localhost:26041",
      }),
    ).toEqual({
      applicationBaseUrl: "http://localhost:26033",
      issuer: "http://localhost:26041",
    });
    expect(() =>
      localCatalogProfileFromEnvironment({ LOCAL_AUTH_ISSUER: "http://localhost:26041" }),
    ).toThrow(/must be supplied together/u);
    expect(() =>
      localCatalogProfileFromEnvironment({
        LOCAL_APPLICATION_BASE_URL: "https://app.example.com",
        LOCAL_AUTH_ISSUER: "http://localhost:26041",
      }),
    ).toThrow(/local HTTP origin/u);
  });
});
