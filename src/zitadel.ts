import { setTimeout as delay } from "node:timers/promises";

interface Organization {
  readonly id: string;
  readonly name: string;
  readonly primaryDomain?: string;
}

interface Project {
  readonly projectId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly grantedOrganizationId?: string;
  readonly privateLabelingSetting?: string;
}

interface ProjectRole {
  readonly key: string;
  readonly displayName: string;
}

interface Application {
  readonly applicationId: string;
  readonly projectId: string;
  readonly name: string;
  readonly oidcConfiguration?: {
    readonly clientId: string;
  };
}

interface ProjectGrant {
  readonly projectId: string;
  readonly grantedOrganizationId: string;
  readonly grantedRoleKeys?: string[];
}

interface Authorization {
  readonly id: string;
  readonly project?: { readonly id: string };
  readonly organization?: { readonly id: string };
  readonly user?: { readonly id: string };
  readonly state?: string;
  readonly roles?: Array<{ readonly key: string }>;
}

interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH";
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly connect?: boolean;
}

export class ZitadelClient {
  readonly #baseUrl: string;
  readonly #pat: string;
  readonly #requestHeaders: Readonly<Record<string, string>>;

  constructor(baseUrl: string, pat: string, requestHeaders: Readonly<Record<string, string>> = {}) {
    this.#baseUrl = baseUrl.replace(/\/+$/u, "");
    this.#pat = pat;
    this.#requestHeaders = requestHeaders;
  }

  async waitUntilReady(attempts = 60): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(`${this.#baseUrl}/.well-known/openid-configuration`, {
          headers: this.#requestHeaders,
          signal: AbortSignal.timeout(3_000),
        });
        if (response.ok) return;
      } catch {
        // Retry while ZITADEL completes its database initialization.
      }
      await delay(Math.min(attempt, 5) * 1_000);
    }
    throw new Error(`ZITADEL did not become ready at ${this.#baseUrl}`);
  }

  async listOrganizations(): Promise<Organization[]> {
    const response = await this.#request<{ result?: Organization[] }>("/v2/organizations/_search", {
      method: "POST",
      body: { query: { limit: 1_000 } },
    });
    return response.result ?? [];
  }

  async createOrganization(name: string, organizationId?: string): Promise<Organization> {
    const response = await this.#request<{ organizationId: string }>("/v2/organizations", {
      method: "POST",
      body: { name, ...(organizationId ? { organizationId } : {}) },
    });
    return { id: response.organizationId, name };
  }

  async addOrganizationDomain(organizationId: string, domain: string): Promise<void> {
    const response = await this.#request<{ domains?: Array<{ domain: string }> }>(
      `/v2/organizations/${organizationId}/domains/search`,
      { method: "POST", body: {} },
    );
    if (response.domains?.some((entry) => entry.domain === domain)) return;

    await this.#request(`/v2/organizations/${organizationId}/domains`, {
      method: "POST",
      body: { domain },
    });
  }

  async applyBranding(
    organizationId: string,
    branding: Readonly<Record<string, string>>,
  ): Promise<void> {
    const headers = { "x-zitadel-orgid": organizationId };
    const current = await this.#request<{
      policy?: Readonly<Record<string, unknown>> & { isDefault?: boolean };
      isDefault?: boolean;
    }>("/management/v1/policies/label", { method: "GET", headers });
    const body = {
      primaryColor: branding.primary_color,
      warnColor: branding.warn_color,
      backgroundColor: branding.background_color,
      fontColor: branding.font_color,
      primaryColorDark: branding.primary_color_dark,
      warnColorDark: branding.warn_color_dark,
      backgroundColorDark: branding.background_color_dark,
      fontColorDark: branding.font_color_dark,
      disableWatermark: true,
      themeMode: "THEME_MODE_AUTO",
    };
    if (
      current.policy &&
      Object.entries(body).every(([key, value]) => current.policy?.[key] === value)
    ) {
      return;
    }
    await this.#request("/management/v1/policies/label", {
      method: current.isDefault === true || current.policy?.isDefault === true ? "POST" : "PUT",
      body,
      headers,
    });
    await this.#request("/management/v1/policies/label/_activate", {
      method: "POST",
      body: {},
      headers,
    });
  }

  async listProjects(): Promise<Project[]> {
    const response = await this.#request<{ projects?: Project[] }>(
      "/zitadel.project.v2.ProjectService/ListProjects",
      { method: "POST", body: { pagination: { limit: 1_000 } }, connect: true },
    );
    return response.projects ?? [];
  }

  async createProject(organizationId: string, name: string): Promise<string> {
    const response = await this.#request<{ projectId: string }>(
      "/zitadel.project.v2.ProjectService/CreateProject",
      {
        method: "POST",
        connect: true,
        body: {
          organizationId,
          name,
          projectRoleAssertion: true,
          authorizationRequired: true,
          projectAccessRequired: true,
          privateLabelingSetting: "PRIVATE_LABELING_SETTING_ALLOW_LOGIN_USER_RESOURCE_OWNER_POLICY",
        },
      },
    );
    return response.projectId;
  }

  async configureProject(projectId: string): Promise<void> {
    await this.#request("/zitadel.project.v2.ProjectService/UpdateProject", {
      method: "POST",
      connect: true,
      body: {
        projectId,
        projectRoleAssertion: true,
        authorizationRequired: true,
        projectAccessRequired: true,
        privateLabelingSetting: "PRIVATE_LABELING_SETTING_ALLOW_LOGIN_USER_RESOURCE_OWNER_POLICY",
      },
    });
  }

  async listProjectRoles(projectId: string): Promise<ProjectRole[]> {
    const response = await this.#request<{ projectRoles?: ProjectRole[] }>(
      "/zitadel.project.v2.ProjectService/ListProjectRoles",
      {
        method: "POST",
        connect: true,
        body: { projectId },
      },
    );
    return response.projectRoles ?? [];
  }

  async addProjectRole(projectId: string, key: string, displayName: string): Promise<void> {
    await this.#request("/zitadel.project.v2.ProjectService/AddProjectRole", {
      method: "POST",
      connect: true,
      body: { projectId, roleKey: key, displayName },
    });
  }

  async listProjectGrants(projectId: string): Promise<ProjectGrant[]> {
    const response = await this.#request<{ projectGrants?: ProjectGrant[] }>(
      "/zitadel.project.v2.ProjectService/ListProjectGrants",
      {
        method: "POST",
        connect: true,
        body: { pagination: { limit: 1_000 } },
      },
    );
    return (response.projectGrants ?? []).filter((grant) => grant.projectId === projectId);
  }

  async ensureProjectGrant(
    projectId: string,
    grantedOrganizationId: string,
    roleKeys: string[],
  ): Promise<void> {
    const grants = await this.listProjectGrants(projectId);
    const current = grants.find(
      (grant) =>
        grant.projectId === projectId && grant.grantedOrganizationId === grantedOrganizationId,
    );
    if (!current) {
      await this.#request("/zitadel.project.v2.ProjectService/CreateProjectGrant", {
        method: "POST",
        connect: true,
        body: { projectId, grantedOrganizationId, roleKeys },
      });
      return;
    }
    const currentRoles = [...(current.grantedRoleKeys ?? [])].sort();
    const desiredRoles = [...roleKeys].sort();
    if (JSON.stringify(currentRoles) === JSON.stringify(desiredRoles)) return;
    await this.#request("/zitadel.project.v2.ProjectService/UpdateProjectGrant", {
      method: "POST",
      connect: true,
      body: { projectId, grantedOrganizationId, roleKeys },
    });
  }

  async getUser(userId: string): Promise<{ id: string } | undefined> {
    const response = await this.#requestRaw(`/v2/users/${encodeURIComponent(userId)}`, {
      method: "GET",
    });
    if (response.status === 404) return undefined;
    const body = await this.#parseResponse(response);
    if (!response.ok) {
      throw new Error(
        `GET /v2/users/${userId} returned ${response.status}: ${JSON.stringify(body)}`,
      );
    }
    return { id: userId };
  }

  async createHumanUser(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly email: string;
    readonly displayName: string;
    readonly password: string;
    readonly passwordChangeRequired: boolean;
  }): Promise<string> {
    const [givenName, ...familyParts] = input.displayName.trim().split(/\s+/u);
    const response = await this.#request<{ id: string }>("/v2/users/new", {
      method: "POST",
      body: {
        organizationId: input.organizationId,
        userId: input.userId,
        username: input.email,
        human: {
          profile: {
            givenName: givenName || input.displayName,
            familyName: familyParts.join(" ") || "-",
            displayName: input.displayName,
          },
          email: { email: input.email, isVerified: true },
          password: {
            password: input.password,
            changeRequired: input.passwordChangeRequired,
          },
        },
      },
    });
    return response.id;
  }

  async createServiceAccount(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly username: string;
    readonly displayName: string;
  }): Promise<string> {
    const response = await this.#request<{ id: string }>("/v2/users/new", {
      method: "POST",
      body: {
        organizationId: input.organizationId,
        userId: input.userId,
        username: input.username,
        machine: {
          name: input.displayName,
          description: `${input.displayName} service account`,
          accessTokenType: "ACCESS_TOKEN_TYPE_JWT",
        },
      },
    });
    return response.id;
  }

  async generateServiceAccountSecret(userId: string): Promise<string> {
    const response = await this.#request<{ clientSecret: string }>(
      `/v2/users/${encodeURIComponent(userId)}/secret`,
      { method: "POST" },
    );
    return response.clientSecret;
  }

  async listAuthorizations(input: {
    readonly userId: string;
    readonly projectId: string;
    readonly organizationId: string;
  }): Promise<Authorization[]> {
    const response = await this.#request<{ authorizations?: Authorization[] }>(
      "/zitadel.authorization.v2.AuthorizationService/ListAuthorizations",
      {
        method: "POST",
        connect: true,
        body: { pagination: { limit: 1_000 } },
      },
    );
    return (response.authorizations ?? []).filter(
      (authorization) =>
        authorization.user?.id === input.userId &&
        authorization.project?.id === input.projectId &&
        authorization.organization?.id === input.organizationId,
    );
  }

  async ensureAuthorization(input: {
    readonly userId: string;
    readonly projectId: string;
    readonly organizationId: string;
    readonly roleKeys: string[];
  }): Promise<void> {
    const authorizations = await this.listAuthorizations(input);
    const current = authorizations.find(
      (authorization) =>
        authorization.user?.id === input.userId &&
        authorization.project?.id === input.projectId &&
        authorization.organization?.id === input.organizationId,
    );
    if (!current) {
      await this.#request("/zitadel.authorization.v2.AuthorizationService/CreateAuthorization", {
        method: "POST",
        connect: true,
        body: input,
      });
      return;
    }
    const currentRoles = (current.roles ?? []).map((role) => role.key).sort();
    const desiredRoles = [...input.roleKeys].sort();
    if (JSON.stringify(currentRoles) === JSON.stringify(desiredRoles)) return;
    await this.#request("/zitadel.authorization.v2.AuthorizationService/UpdateAuthorization", {
      method: "POST",
      connect: true,
      body: { id: current.id, roleKeys: input.roleKeys },
    });
  }

  async listApplications(projectId: string): Promise<Application[]> {
    const response = await this.#request<{ applications?: Application[] }>(
      "/zitadel.application.v2.ApplicationService/ListApplications",
      {
        method: "POST",
        connect: true,
        body: { query: { projectIds: [projectId] } },
      },
    );
    return (response.applications ?? []).filter(
      (application) => application.projectId === projectId,
    );
  }

  async createOidcApplication(input: {
    readonly projectId: string;
    readonly name: string;
    readonly baseUrl: string;
    readonly developmentMode: boolean;
  }): Promise<{
    readonly applicationId: string;
    readonly clientId: string;
    readonly clientSecret: string;
  }> {
    const response = await this.#request<{
      applicationId: string;
      oidcConfiguration: { clientId: string; clientSecret: string };
    }>("/zitadel.application.v2.ApplicationService/CreateApplication", {
      method: "POST",
      connect: true,
      body: {
        projectId: input.projectId,
        name: input.name,
        oidcConfiguration: {
          redirectUris: [`${input.baseUrl}/auth/callback`],
          responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
          grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE", "OIDC_GRANT_TYPE_REFRESH_TOKEN"],
          applicationType: "OIDC_APP_TYPE_WEB",
          authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC",
          postLogoutRedirectUris: [`${input.baseUrl}/`],
          version: "OIDC_VERSION_1_0",
          developmentMode: input.developmentMode,
          accessTokenType: "OIDC_TOKEN_TYPE_JWT",
          accessTokenRoleAssertion: true,
          idTokenRoleAssertion: true,
          idTokenUserinfoAssertion: true,
          loginVersion: { loginV2: {} },
        },
      },
    });
    return {
      applicationId: response.applicationId,
      clientId: response.oidcConfiguration.clientId,
      clientSecret: response.oidcConfiguration.clientSecret,
    };
  }

  async rotateClientSecret(applicationId: string, projectId: string): Promise<string> {
    const response = await this.#request<{ clientSecret: string }>(
      "/zitadel.application.v2.ApplicationService/GenerateClientSecret",
      {
        method: "POST",
        connect: true,
        body: { applicationId, projectId },
      },
    );
    return response.clientSecret;
  }

  async #request<T = Record<string, never>>(path: string, options: RequestOptions): Promise<T> {
    const response = await this.#requestRaw(path, options);
    const body = await this.#parseResponse(response);
    if (!response.ok) {
      throw new Error(
        `${options.method ?? "GET"} ${path} returned ${response.status}: ${JSON.stringify(body)}`,
      );
    }
    return body as T;
  }

  async #requestRaw(path: string, options: RequestOptions): Promise<Response> {
    return fetch(`${this.#baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${this.#pat}`,
        ...this.#requestHeaders,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.connect === true ? { "connect-protocol-version": "1" } : {}),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(15_000),
    });
  }

  async #parseResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    return text.length === 0 ? {} : (JSON.parse(text) as unknown);
  }
}
