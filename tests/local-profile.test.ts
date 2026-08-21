import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  localAuthComposeEnvironment,
  localAuthRuntimeProfile,
  localCatalogProfileFromEnvironment,
} from "../src/local-profile.js";

const testRoot = mkdtempSync(resolve(tmpdir(), "ensombl-auth-profile-"));
const firstRoot = resolve(testRoot, "first");
const secondRoot = resolve(testRoot, "second");
const overrideRoot = resolve(testRoot, "override");
mkdirSync(firstRoot);
mkdirSync(secondRoot);
mkdirSync(overrideRoot);
const allocationDependencies = {
  candidatePortBases: [16_000, 16_016],
  ephemeralPortRange: [32_768, 60_999] as const,
  listeningPorts: () => new Set<number>(),
  registryPath: resolve(testRoot, "allocations.json"),
};
const localDockerEnvironment = { DOCKER_CONFIG: resolve(testRoot, "docker-default") };

function dockerConfig(name: string, host: string, current = false): string {
  const configDirectory = resolve(testRoot, `docker-${name}`);
  const contextId = createHash("sha256").update(name).digest("hex");
  const metadataDirectory = resolve(configDirectory, "contexts", "meta", contextId);
  mkdirSync(metadataDirectory, { recursive: true });
  writeFileSync(
    resolve(metadataDirectory, "meta.json"),
    `${JSON.stringify({ Endpoints: { docker: { Host: host } }, Name: name })}\n`,
  );
  if (current) {
    writeFileSync(
      resolve(configDirectory, "config.json"),
      `${JSON.stringify({ currentContext: name })}\n`,
    );
  }
  return configDirectory;
}

afterAll(() => rmSync(testRoot, { force: true, recursive: true }));

describe("local runtime profile", () => {
  it("reuses a reservation and assigns a distinct port block per repository path", () => {
    const first = localAuthRuntimeProfile(
      firstRoot,
      localDockerEnvironment,
      allocationDependencies,
    );
    expect(
      localAuthRuntimeProfile(firstRoot, localDockerEnvironment, allocationDependencies),
    ).toEqual({
      ...first,
      allocationCreated: false,
    });
    expect(
      localAuthRuntimeProfile(secondRoot, localDockerEnvironment, allocationDependencies).portBase,
    ).not.toBe(first.portBase);
    expect(first.id).toMatch(/^[a-f0-9]{16}$/u);
    expect(first.portBase % 16).toBe(0);
  });

  it("passes one profile through Compose, issuer, network, and application values", () => {
    const dockerConfigDirectory = dockerConfig(
      "desktop-linux",
      "unix:///home/developer/.docker/desktop/docker.sock",
    );
    const source = {
      COMPOSE_FILE: "foreign-compose.yml",
      COMPOSE_PROJECT_NAME: "foreign",
      DOCKER_CERT_PATH: "/docker/certs",
      DOCKER_CONFIG: dockerConfigDirectory,
      DOCKER_CONTEXT: "desktop-linux",
      DOCKER_TLS_VERIFY: "1",
      PATH: "/usr/bin",
    };
    const profile = localAuthRuntimeProfile(firstRoot, source, allocationDependencies);
    const environment = localAuthComposeEnvironment(profile, source);

    expect(environment).toMatchObject({
      COMPOSE_PROJECT_NAME: profile.composeProject,
      DOCKER_CERT_PATH: "/docker/certs",
      DOCKER_CONFIG: dockerConfigDirectory,
      DOCKER_CONTEXT: "desktop-linux",
      DOCKER_TLS_VERIFY: "1",
      LOCAL_APPLICATION_BASE_URL: profile.applicationBaseUrl,
      LOCAL_AUTH_COMPOSE_PROJECT: profile.composeProject,
      LOCAL_AUTH_ISSUER: profile.issuer,
      LOCAL_AUTH_MAILPIT_UI_PORT: String(profile.mailpitPort),
      LOCAL_AUTH_NETWORK: profile.network,
      LOCAL_AUTH_PROXY_PORT: String(profile.proxyPort),
      LOCAL_RUNTIME_ID: profile.id,
      PATH: "/usr/bin",
    });
    expect(environment.COMPOSE_FILE).toBeUndefined();
    expect(new Set([profile.proxyPort, profile.mailpitPort]).size).toBe(2);
  });

  it("treats a port-only override as a new allocation", () => {
    const profile = localAuthRuntimeProfile(
      overrideRoot,
      { ...localDockerEnvironment, LOCAL_RUNTIME_PORT_BASE: "16032" },
      {
        ...allocationDependencies,
        candidatePortBases: [16_032],
        registryPath: resolve(testRoot, "override-allocations.json"),
      },
    );

    expect(profile.allocationCreated).toBe(true);
    expect(profile.portBase).toBe(16_032);
  });

  it.each([
    ["an SSH DOCKER_HOST", { DOCKER_HOST: "ssh://docker.example.com" }],
    ["a remote TCP DOCKER_HOST", { DOCKER_HOST: "tcp://docker.example.com:2376" }],
    [
      "a remote DOCKER_CONTEXT",
      {
        DOCKER_CONFIG: dockerConfig("remote-environment", "ssh://docker.example.com"),
        DOCKER_CONTEXT: "remote-environment",
      },
    ],
    [
      "a remote currentContext",
      {
        DOCKER_CONFIG: dockerConfig("remote-current", "tcp://docker.example.com:2376", true),
      },
    ],
    [
      "a remote DOCKER_CONTEXT alongside a local DOCKER_HOST",
      {
        DOCKER_CONFIG: dockerConfig("remote-with-local-host", "ssh://docker.example.com"),
        DOCKER_CONTEXT: "remote-with-local-host",
        DOCKER_HOST: "unix:///var/run/docker.sock",
      },
    ],
    [
      "a remote DOCKER_HOST alongside a local DOCKER_CONTEXT",
      {
        DOCKER_CONFIG: dockerConfig("local-with-remote-host", "unix:///var/run/docker.sock"),
        DOCKER_CONTEXT: "local-with-remote-host",
        DOCKER_HOST: "ssh://docker.example.com",
      },
    ],
  ])("rejects %s before creating the runtime registry", (name, environment) => {
    const root = resolve(testRoot, name.replaceAll(" ", "-"));
    const registryPath = resolve(root, "state", "allocations.json");
    mkdirSync(root);

    expect(() =>
      localAuthRuntimeProfile(root, environment, {
        ...allocationDependencies,
        registryPath,
      }),
    ).toThrow(/remote or unsupported Docker endpoint/u);
    expect(existsSync(registryPath)).toBe(false);
    expect(existsSync(`${registryPath}.lock`)).toBe(false);
    const localProfile = localAuthRuntimeProfile(
      firstRoot,
      localDockerEnvironment,
      allocationDependencies,
    );
    expect(() => localAuthComposeEnvironment(localProfile, environment)).toThrow(
      /remote or unsupported Docker endpoint/u,
    );
  });

  it.each([
    ["a Unix socket", { DOCKER_HOST: "unix:///var/run/docker.sock" }],
    ["IPv4 loopback TCP", { DOCKER_HOST: "tcp://127.0.0.1:2375" }],
    ["IPv6 loopback TCP", { DOCKER_HOST: "tcp://[::1]:2375" }],
    [
      "a local named context",
      {
        DOCKER_CONFIG: dockerConfig("local-context", "unix:///var/run/docker.sock"),
        DOCKER_CONTEXT: "local-context",
      },
    ],
    [
      "a local currentContext",
      { DOCKER_CONFIG: dockerConfig("local-current", "unix:///var/run/docker.sock", true) },
    ],
  ])("supports %s", (_name, environment) => {
    expect(localAuthRuntimeProfile(firstRoot, environment, allocationDependencies)).toMatchObject({
      registryPath: allocationDependencies.registryPath,
      repositoryRoot: firstRoot,
    });
  });

  it("supports the local Windows named pipe on Windows", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      expect(
        localAuthRuntimeProfile(
          firstRoot,
          { DOCKER_HOST: "npipe:////./pipe/docker_engine" },
          {
            ...allocationDependencies,
            processInstanceId: (pid) => `test-${String(pid)}`,
          },
        ),
      ).toMatchObject({
        registryPath: allocationDependencies.registryPath,
        repositoryRoot: firstRoot,
      });
    } finally {
      platform.mockRestore();
    }
  });

  it("rejects a remote Windows named pipe before registry creation and Compose", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const root = resolve(testRoot, "remote-windows-named-pipe");
    const registryPath = resolve(root, "state", "allocations.json");
    const environment = { DOCKER_HOST: "npipe:////x/pipe/docker_engine" };
    mkdirSync(root);
    try {
      expect(() =>
        localAuthRuntimeProfile(root, environment, {
          ...allocationDependencies,
          processInstanceId: (pid) => `test-${String(pid)}`,
          registryPath,
        }),
      ).toThrow(/remote or unsupported Docker endpoint/u);
      expect(existsSync(registryPath)).toBe(false);
      expect(existsSync(`${registryPath}.lock`)).toBe(false);
      const localProfile = localAuthRuntimeProfile(
        firstRoot,
        { DOCKER_HOST: "npipe:////./pipe/docker_engine" },
        {
          ...allocationDependencies,
          processInstanceId: (pid) => `test-${String(pid)}`,
        },
      );
      expect(() => localAuthComposeEnvironment(localProfile, environment)).toThrow(
        /remote or unsupported Docker endpoint/u,
      );
    } finally {
      platform.mockRestore();
    }
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
