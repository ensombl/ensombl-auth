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
  const inheritedNames = [
    "LOCAL_RUNTIME_ROOT",
    "LOCAL_RUNTIME_ID",
    "LOCAL_RUNTIME_PORT_BASE",
  ] as const;
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
  for (const name of ["DOCKER_HOST", "HOME", "PATH", "XDG_RUNTIME_DIR"] as const) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}
