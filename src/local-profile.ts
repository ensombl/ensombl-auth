import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  allocateLocalRuntimePortBlock,
  consumeLocalRuntimePortBlock,
  type LocalRuntimeAllocationDependencies,
  localRuntimeAllocationEnvironment,
} from "./local-allocation.js";

export interface LocalCatalogProfile {
  readonly applicationBaseUrl: string;
  readonly issuer: string;
}

export interface LocalAuthRuntimeProfile extends LocalCatalogProfile {
  readonly allocationCreated: boolean;
  readonly composeProject: string;
  readonly id: string;
  readonly mailpitPort: number;
  readonly network: string;
  readonly portBase: number;
  readonly proxyPort: number;
  readonly registryPath: string;
  readonly repositoryRoot: string;
}

function dockerConfigDirectory(environment: Readonly<NodeJS.ProcessEnv>): string {
  const configured = environment.DOCKER_CONFIG;
  if (configured !== undefined && configured !== "") {
    if (!configured.trim() || configured !== configured.trim()) {
      throw new Error("DOCKER_CONFIG is invalid");
    }
    return resolve(configured);
  }
  return resolve(environment.HOME?.trim() || homedir(), ".docker");
}

function dockerCurrentContext(configDirectory: string): string {
  const configPath = resolve(configDirectory, "config.json");
  let contents: string;
  try {
    contents = readFileSync(configPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "default";
    }
    throw new Error(`Could not read the Docker client configuration: ${configPath}`, {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`The Docker client configuration is invalid JSON: ${configPath}`, {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`The Docker client configuration is invalid: ${configPath}`);
  }
  const currentContext = (parsed as { readonly currentContext?: unknown }).currentContext;
  if (currentContext === undefined || currentContext === "") return "default";
  if (
    typeof currentContext !== "string" ||
    !currentContext.trim() ||
    currentContext !== currentContext.trim()
  ) {
    throw new Error(`The Docker client current context is invalid: ${configPath}`);
  }
  return currentContext;
}

function dockerContextEndpoint(context: string, configDirectory: string): string {
  const contextId = createHash("sha256").update(context).digest("hex");
  const metadataPath = resolve(configDirectory, "contexts", "meta", contextId, "meta.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read Docker context ${context}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Docker context ${context} is invalid`);
  }
  const metadata = parsed as {
    readonly Endpoints?: { readonly docker?: { readonly Host?: unknown } };
    readonly Name?: unknown;
  };
  const host = metadata.Endpoints?.docker?.Host;
  if (
    metadata.Name !== context ||
    typeof host !== "string" ||
    !host.trim() ||
    host !== host.trim()
  ) {
    throw new Error(`Docker context ${context} is invalid`);
  }
  return host;
}

function dockerEndpointIsClientLocal(endpoint: string): boolean {
  if (process.platform === "win32" && /^npipe:\/\/\/\/.\/pipe\/[^/]+$/iu.test(endpoint)) {
    return true;
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "unix:") {
    return !url.host && url.pathname.startsWith("/") && url.pathname !== "/";
  }
  if (url.protocol !== "tcp:" || (url.pathname !== "" && url.pathname !== "/")) return false;
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function assertDockerEndpointIsClientLocal(endpoint: string, selection: string): void {
  if (!endpoint || endpoint !== endpoint.trim() || !dockerEndpointIsClientLocal(endpoint)) {
    throw new Error(
      `${selection} selects a remote or unsupported Docker endpoint; local development requires a client-local Docker daemon`,
    );
  }
}

function assertClientLocalDockerEndpoint(environment: Readonly<NodeJS.ProcessEnv>): void {
  const configuredHost = environment.DOCKER_HOST;
  const configuredContext = environment.DOCKER_CONTEXT;
  const hostSelected = configuredHost !== undefined && configuredHost !== "";
  const contextSelected = configuredContext !== undefined && configuredContext !== "";
  if (hostSelected) assertDockerEndpointIsClientLocal(configuredHost, "DOCKER_HOST");

  if (contextSelected) {
    if (!configuredContext.trim() || configuredContext !== configuredContext.trim()) {
      throw new Error("DOCKER_CONTEXT is invalid");
    }
    if (configuredContext !== "default") {
      const configDirectory = dockerConfigDirectory(environment);
      assertDockerEndpointIsClientLocal(
        dockerContextEndpoint(configuredContext, configDirectory),
        `Docker context ${configuredContext}`,
      );
    }
    return;
  }
  if (hostSelected) return;

  const configDirectory = dockerConfigDirectory(environment);
  const context = dockerCurrentContext(configDirectory);
  if (context !== "default") {
    assertDockerEndpointIsClientLocal(
      dockerContextEndpoint(context, configDirectory),
      `Docker context ${context}`,
    );
  }
}

function localOrigin(value: string, name: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be a credential-free local HTTP origin`);
  }
  if (!url.port) throw new Error(`${name} must include a port`);
  return url.origin;
}

export function localAuthRuntimeProfile(
  path: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  dependencies: LocalRuntimeAllocationDependencies = {},
): LocalAuthRuntimeProfile {
  assertClientLocalDockerEndpoint(environment);
  const inheritedNames = ["LOCAL_RUNTIME_ROOT", "LOCAL_RUNTIME_ID"] as const;
  const inherited = inheritedNames.some((name) => environment[name]?.trim());
  const allocation = inherited
    ? consumeLocalRuntimePortBlock(environment, dependencies)
    : allocateLocalRuntimePortBlock(path, environment, dependencies);
  const { id, portBase } = allocation;
  const composeProject = `ensombl-auth-${id}`;
  const proxyPort = portBase + 9;
  return Object.freeze({
    allocationCreated: allocation.created,
    applicationBaseUrl: `http://localhost:${String(portBase + 1)}`,
    composeProject,
    id,
    issuer: `http://localhost:${String(proxyPort)}`,
    mailpitPort: portBase + 10,
    network: `${composeProject}-network`,
    portBase,
    proxyPort,
    registryPath: allocation.registryPath,
    repositoryRoot: allocation.repositoryRoot,
  });
}

export function localCatalogProfileFromEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): LocalCatalogProfile | undefined {
  const issuer = environment.LOCAL_AUTH_ISSUER?.trim();
  const applicationBaseUrl = environment.LOCAL_APPLICATION_BASE_URL?.trim();
  if (!issuer && !applicationBaseUrl) return undefined;
  if (!issuer || !applicationBaseUrl) {
    throw new Error("LOCAL_AUTH_ISSUER and LOCAL_APPLICATION_BASE_URL must be supplied together");
  }
  return Object.freeze({
    applicationBaseUrl: localOrigin(applicationBaseUrl, "LOCAL_APPLICATION_BASE_URL"),
    issuer: localOrigin(issuer, "LOCAL_AUTH_ISSUER"),
  });
}

export function localAuthComposeEnvironment(
  profile: LocalAuthRuntimeProfile,
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  assertClientLocalDockerEndpoint(source);
  const environment: NodeJS.ProcessEnv = {
    ...localRuntimeAllocationEnvironment(profile),
    COMPOSE_ANSI: "never",
    COMPOSE_PROGRESS: "quiet",
    COMPOSE_PROJECT_NAME: profile.composeProject,
    LOCAL_APPLICATION_BASE_URL: profile.applicationBaseUrl,
    LOCAL_AUTH_COMPOSE_PROJECT: profile.composeProject,
    LOCAL_AUTH_ISSUER: profile.issuer,
    LOCAL_AUTH_MAILPIT_UI_PORT: String(profile.mailpitPort),
    LOCAL_AUTH_NETWORK: profile.network,
    LOCAL_AUTH_PROXY_PORT: String(profile.proxyPort),
    LOCAL_GID: String(process.getgid?.() ?? 1_000),
    LOCAL_RUNTIME_ID: profile.id,
    LOCAL_UID: String(process.getuid?.() ?? 1_000),
  };
  for (const name of [
    "BUILDKIT_PROGRESS",
    "DOCKER_API_VERSION",
    "DOCKER_CERT_PATH",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_CUSTOM_HEADERS",
    "DOCKER_DEFAULT_PLATFORM",
    "DOCKER_HIDE_LEGACY_COMMANDS",
    "DOCKER_HOST",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_COLOR",
    "NO_PROXY",
    "PATH",
    "XDG_RUNTIME_DIR",
  ] as const) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}
