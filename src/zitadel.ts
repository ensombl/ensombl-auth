import { setTimeout as delay } from "node:timers/promises";
import type { Product } from "./catalog.js";

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
    readonly clientId?: string;
    readonly redirectUris?: string[];
    readonly responseTypes?: string[];
    readonly grantTypes?: string[];
    readonly applicationType?: string;
    readonly authMethodType?: string;
    readonly postLogoutRedirectUris?: string[];
    readonly developmentMode?: boolean;
    readonly accessTokenType?: string;
    readonly accessTokenRoleAssertion?: boolean;
    readonly idTokenRoleAssertion?: boolean;
    readonly idTokenUserinfoAssertion?: boolean;
    readonly clockSkew?: string;
    readonly additionalOrigins?: string[];
    readonly skipNativeAppSuccessPage?: boolean;
    readonly backChannelLogoutUri?: string;
    readonly loginVersion?: {
      readonly loginV2?: {
        readonly baseUri?: string;
      };
    };
  };
}

interface Authorization {
  readonly id: string;
  readonly project?: { readonly id: string };
  readonly organization?: { readonly id: string };
  readonly user?: { readonly id: string };
  readonly state?: string;
  readonly roles?: Array<{ readonly key: string }>;
}

interface EmailProvider {
  readonly id: string;
  readonly state?: string;
  readonly smtp?: {
    readonly host?: string;
    readonly user?: string;
    readonly plain?: Record<string, never>;
  };
}

interface LoginPolicy {
  readonly allowUsernamePassword?: boolean;
  readonly allowRegister?: boolean;
  readonly allowExternalIdp?: boolean;
  readonly forceMfa?: boolean;
  readonly passwordlessType?: string;
  readonly hidePasswordReset?: boolean;
  readonly ignoreUnknownUsernames?: boolean;
  readonly defaultRedirectUri?: string;
  readonly passwordCheckLifetime?: string;
  readonly externalLoginCheckLifetime?: string;
  readonly mfaInitSkipLifetime?: string;
  readonly secondFactorCheckLifetime?: string;
  readonly multiFactorCheckLifetime?: string;
  readonly allowDomainDiscovery?: boolean;
  readonly disableLoginWithEmail?: boolean;
  readonly disableLoginWithPhone?: boolean;
  readonly forceMfaLocalOnly?: boolean;
  readonly isDefault?: boolean;
}

interface HumanUser {
  readonly id: string;
  readonly username: string | undefined;
  readonly email: string | undefined;
  readonly displayName: string | undefined;
}

function humanProfile(displayName: string) {
  const [givenName, ...familyParts] = displayName.trim().split(/\s+/u);
  return {
    givenName: givenName || displayName,
    familyName: familyParts.join(" ") || "-",
    displayName,
  };
}

interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly connect?: boolean;
  readonly allowNoChanges?: boolean;
  readonly allowAlreadyExists?: boolean;
}

interface OidcApplicationConfiguration {
  readonly baseUrl: string;
  readonly developmentMode: boolean;
  readonly loginBaseUri: string;
}

function oidcApplicationConfiguration(input: OidcApplicationConfiguration, roleAssertion: boolean) {
  return {
    redirectUris: [`${input.baseUrl}/auth/callback`],
    responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
    grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE", "OIDC_GRANT_TYPE_REFRESH_TOKEN"],
    applicationType: "OIDC_APP_TYPE_WEB",
    authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC",
    postLogoutRedirectUris: [`${input.baseUrl}/auth/signed-out`],
    version: "OIDC_VERSION_1_0",
    developmentMode: input.developmentMode,
    accessTokenType: "OIDC_TOKEN_TYPE_JWT",
    accessTokenRoleAssertion: roleAssertion,
    idTokenRoleAssertion: roleAssertion,
    idTokenUserinfoAssertion: true,
    loginVersion: { loginV2: { baseUri: input.loginBaseUri } },
  };
}

function managementOidcApplicationConfiguration(
  configuration: NonNullable<Application["oidcConfiguration"]>,
  loginBaseUri: string,
) {
  return {
    redirectUris: configuration.redirectUris,
    responseTypes: configuration.responseTypes,
    grantTypes: configuration.grantTypes,
    appType: configuration.applicationType,
    authMethodType: configuration.authMethodType,
    postLogoutRedirectUris: configuration.postLogoutRedirectUris,
    devMode: configuration.developmentMode,
    accessTokenType: configuration.accessTokenType,
    accessTokenRoleAssertion: configuration.accessTokenRoleAssertion,
    idTokenRoleAssertion: configuration.idTokenRoleAssertion,
    idTokenUserinfoAssertion: configuration.idTokenUserinfoAssertion,
    clockSkew: configuration.clockSkew,
    additionalOrigins: configuration.additionalOrigins,
    skipNativeAppSuccessPage: configuration.skipNativeAppSuccessPage,
    backChannelLogoutUri: configuration.backChannelLogoutUri,
    loginVersion: { loginV2: { baseUri: loginBaseUri } },
  };
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

  async addTrustedDomain(trustedDomain: string): Promise<void> {
    await this.#request("/zitadel.instance.v2.InstanceService/AddTrustedDomain", {
      method: "POST",
      connect: true,
      body: { trustedDomain },
      allowAlreadyExists: true,
    });
  }

  async ensurePrimaryOrganizationDomain(
    organizationId: string,
    domain: string,
    obsoleteGeneratedDomainSuffix?: string,
  ): Promise<void> {
    const response = await this.#request<{
      domains?: Array<{ domain: string; isPrimary?: boolean }>;
    }>(`/v2/organizations/${organizationId}/domains/search`, { method: "POST", body: {} });
    const current = response.domains?.find((entry) => entry.domain === domain);
    if (!current) {
      await this.#request(`/v2/organizations/${organizationId}/domains`, {
        method: "POST",
        body: { domain },
        // A newly-created organization already owns its generated domain, but
        // the domains projection can briefly return an empty list.
        allowAlreadyExists: true,
      });
    }
    if (current?.isPrimary !== true) {
      await this.#request(
        `/management/v1/orgs/me/domains/${encodeURIComponent(domain)}/_set_primary`,
        {
          method: "POST",
          headers: { "x-zitadel-orgid": organizationId },
        },
      );
    }
    for (const entry of response.domains ?? []) {
      if (
        entry.domain !== domain &&
        obsoleteGeneratedDomainSuffix &&
        entry.domain.endsWith(obsoleteGeneratedDomainSuffix)
      ) {
        await this.#request(
          `/v2/organizations/${organizationId}/domains?domain=${encodeURIComponent(entry.domain)}`,
          { method: "DELETE" },
        );
      }
    }
  }

  async applyBranding(
    organizationId: string,
    branding: Product["branding"],
    logo?: Uint8Array,
  ): Promise<void> {
    const headers = { "x-zitadel-orgid": organizationId };
    type LabelPolicyResponse = {
      policy?: Readonly<Record<string, unknown>> & { isDefault?: boolean };
      isDefault?: boolean;
    };
    const active = await this.#request<LabelPolicyResponse>("/management/v1/policies/label", {
      method: "GET",
      headers,
    });
    const preview = await this.#request<LabelPolicyResponse>(
      "/management/v1/policies/label/_preview",
      { method: "GET", headers },
    );
    const body = {
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
    const matches = (policy: LabelPolicyResponse["policy"]): boolean =>
      policy !== undefined && Object.entries(body).every(([key, value]) => policy[key] === value);
    let needsActivation = !matches(active.policy);
    if (!matches(preview.policy)) {
      await this.#request("/management/v1/policies/label", {
        method: preview.isDefault === true || preview.policy?.isDefault === true ? "POST" : "PUT",
        body,
        headers,
        allowNoChanges: true,
      });
      needsActivation = true;
    }
    if (logo) {
      const activeLogoUrl =
        typeof active.policy?.logoUrl === "string" ? active.policy.logoUrl : undefined;
      const previewLogoUrl =
        typeof preview.policy?.logoUrl === "string" ? preview.policy.logoUrl : undefined;
      if (!(await this.#assetMatches(previewLogoUrl, logo, headers))) {
        await this.#uploadOrganizationLogo(logo, headers);
        needsActivation = true;
      } else if (activeLogoUrl !== previewLogoUrl) {
        needsActivation = true;
      }
    }
    if (needsActivation) {
      await this.#request("/management/v1/policies/label/_activate", {
        method: "POST",
        body: {},
        headers,
      });
    }
  }

  async ensureLoginPolicy(organizationId: string, desired: Product["login_policy"]): Promise<void> {
    const headers = { "x-zitadel-orgid": organizationId };
    const response = await this.#request<{
      policy?: LoginPolicy;
      isDefault?: boolean;
    }>("/management/v1/policies/login", { method: "GET", headers });
    const policy = response.policy;
    if (!policy) throw new Error(`ZITADEL returned no login policy for ${organizationId}`);
    const body = {
      allowUsernamePassword: desired.allow_username_password,
      allowRegister: desired.allow_self_registration,
      allowExternalIdp: desired.allow_external_identity_providers,
      forceMfa: policy.forceMfa,
      passwordlessType: policy.passwordlessType,
      hidePasswordReset: !desired.allow_password_reset,
      ignoreUnknownUsernames: desired.ignore_unknown_usernames,
      defaultRedirectUri: policy.defaultRedirectUri,
      passwordCheckLifetime: policy.passwordCheckLifetime,
      externalLoginCheckLifetime: policy.externalLoginCheckLifetime,
      mfaInitSkipLifetime: policy.mfaInitSkipLifetime,
      secondFactorCheckLifetime: policy.secondFactorCheckLifetime,
      multiFactorCheckLifetime: policy.multiFactorCheckLifetime,
      allowDomainDiscovery: desired.allow_domain_discovery,
      disableLoginWithEmail: desired.disable_login_with_email,
      disableLoginWithPhone: desired.disable_login_with_phone,
      forceMfaLocalOnly: policy.forceMfaLocalOnly,
    };
    const customPolicy = response.isDefault !== true && policy.isDefault !== true;
    if (
      customPolicy &&
      Object.entries(body).every(([key, value]) => policy[key as keyof LoginPolicy] === value)
    ) {
      return;
    }
    await this.#request("/management/v1/policies/login", {
      method: customPolicy ? "PUT" : "POST",
      body,
      headers,
      allowNoChanges: true,
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
          projectRoleAssertion: false,
          authorizationRequired: false,
          projectAccessRequired: false,
          privateLabelingSetting: "PRIVATE_LABELING_SETTING_ENFORCE_PROJECT_RESOURCE_OWNER_POLICY",
        },
      },
    );
    return response.projectId;
  }

  async configureProject(projectId: string, projectRoleAssertion: boolean): Promise<void> {
    await this.#request("/zitadel.project.v2.ProjectService/UpdateProject", {
      method: "POST",
      connect: true,
      body: {
        projectId,
        projectRoleAssertion,
        authorizationRequired: false,
        projectAccessRequired: false,
        privateLabelingSetting: "PRIVATE_LABELING_SETTING_ENFORCE_PROJECT_RESOURCE_OWNER_POLICY",
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

  async removeProjectRole(projectId: string, roleKey: string): Promise<void> {
    await this.#request("/zitadel.project.v2.ProjectService/RemoveProjectRole", {
      method: "POST",
      connect: true,
      body: { projectId, roleKey },
    });
  }

  async getUser(userId: string): Promise<HumanUser | undefined> {
    const response = await this.#requestRaw(`/v2/users/${encodeURIComponent(userId)}`, {
      method: "GET",
    });
    if (response.status === 404) return undefined;
    const body = (await this.#parseResponse(response)) as {
      user?: {
        username?: string;
        human?: {
          email?: { email?: string };
          profile?: { displayName?: string };
        };
      };
    };
    if (!response.ok) {
      throw new Error(
        `GET /v2/users/${userId} returned ${response.status}: ${JSON.stringify(body)}`,
      );
    }
    return {
      id: userId,
      username: body.user?.username,
      email: body.user?.human?.email?.email,
      displayName: body.user?.human?.profile?.displayName,
    };
  }

  async createHumanUser(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly email: string;
    readonly displayName: string;
    readonly password: string;
    readonly passwordChangeRequired: boolean;
  }): Promise<string> {
    const response = await this.#request<{ id: string }>("/v2/users/new", {
      method: "POST",
      body: {
        organizationId: input.organizationId,
        userId: input.userId,
        username: input.email,
        human: {
          profile: humanProfile(input.displayName),
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

  async updateHumanUser(input: {
    readonly userId: string;
    readonly email: string;
    readonly displayName: string;
  }): Promise<void> {
    await this.#request(`/v2/users/${encodeURIComponent(input.userId)}`, {
      method: "PATCH",
      body: {
        username: input.email,
        human: {
          profile: humanProfile(input.displayName),
          email: { email: input.email, isVerified: true },
        },
      },
    });
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

  async ensureAdministrator(input: {
    readonly userId: string;
    readonly resource:
      | { readonly instance: true }
      | { readonly organizationId: string }
      | { readonly projectId: string };
    readonly roles: string[];
  }): Promise<void> {
    const path = "/zitadel.internal_permission.v2.InternalPermissionService/CreateAdministrator";
    const administrators = await this.#request<{
      administrators?: Array<{
        instance?: boolean;
        organization?: { id: string };
        project?: { id: string };
        roles?: string[];
        user?: { id: string };
      }>;
    }>("/zitadel.internal_permission.v2.InternalPermissionService/ListAdministrators", {
      method: "POST",
      connect: true,
      body: { pagination: { limit: 1_000 } },
    });
    const current = administrators.administrators?.find((administrator) => {
      if (administrator.user?.id !== input.userId) return false;
      if ("instance" in input.resource) return administrator.instance === true;
      if ("organizationId" in input.resource) {
        return administrator.organization?.id === input.resource.organizationId;
      }
      return administrator.project?.id === input.resource.projectId;
    });
    if (
      current &&
      JSON.stringify([...(current.roles ?? [])].sort()) === JSON.stringify([...input.roles].sort())
    ) {
      return;
    }
    if (current) {
      await this.#request(
        "/zitadel.internal_permission.v2.InternalPermissionService/UpdateAdministrator",
        {
          method: "POST",
          connect: true,
          body: input,
        },
      );
      return;
    }
    const response = await this.#requestRaw(path, {
      method: "POST",
      connect: true,
      body: input,
    });
    if (response.ok) return;
    if (response.status !== 409) {
      const body = await this.#parseResponse(response);
      throw new Error(`POST ${path} returned ${response.status}: ${JSON.stringify(body)}`);
    }
    await this.#request(
      "/zitadel.internal_permission.v2.InternalPermissionService/UpdateAdministrator",
      {
        method: "POST",
        connect: true,
        body: input,
      },
    );
  }

  async deleteAdministrator(input: {
    readonly userId: string;
    readonly resource:
      | { readonly instance: true }
      | { readonly organizationId: string }
      | { readonly projectId: string };
  }): Promise<void> {
    await this.#request(
      "/zitadel.internal_permission.v2.InternalPermissionService/DeleteAdministrator",
      {
        method: "POST",
        connect: true,
        body: input,
      },
    );
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
    if (input.roleKeys.length === 0) {
      if (current) {
        await this.#request("/zitadel.authorization.v2.AuthorizationService/DeleteAuthorization", {
          method: "POST",
          connect: true,
          body: { id: current.id },
        });
      }
      return;
    }
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
        body: {
          pagination: { limit: 1_000 },
          filters: [{ projectIdFilter: { projectId } }],
        },
      },
    );
    return response.applications ?? [];
  }

  async findApplicationByName(
    name: string,
  ): Promise<{ applicationId: string; projectId: string } | undefined> {
    const response = await this.#request<{ applications?: Application[] }>(
      "/zitadel.application.v2.ApplicationService/ListApplications",
      {
        method: "POST",
        connect: true,
        body: {
          pagination: { limit: 100 },
          filters: [{ nameFilter: { name } }],
        },
      },
    );
    const application = response.applications?.find((candidate) => candidate.name === name);
    if (!application) return undefined;
    return {
      applicationId: application.applicationId,
      projectId: application.projectId,
    };
  }

  async createOidcApplication(input: {
    readonly projectId: string;
    readonly name: string;
    readonly baseUrl: string;
    readonly developmentMode: boolean;
    readonly loginBaseUri: string;
    readonly roleAssertion: boolean;
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
        oidcConfiguration: oidcApplicationConfiguration(input, input.roleAssertion),
      },
    });
    return {
      applicationId: response.applicationId,
      clientId: response.oidcConfiguration.clientId,
      clientSecret: response.oidcConfiguration.clientSecret,
    };
  }

  async configureOidcApplication(input: {
    readonly applicationId: string;
    readonly projectId: string;
    readonly organizationId: string;
    readonly baseUrl: string;
    readonly developmentMode: boolean;
    readonly loginBaseUri: string;
    readonly roleAssertion: boolean;
  }): Promise<void> {
    const configuration = oidcApplicationConfiguration(input, input.roleAssertion);
    // ZITADEL v4.16.2's v2 UpdateApplication currently ignores Login V2 URI
    // changes. The management endpoint persists the same current OIDC model.
    await this.#request(
      `/management/v1/projects/${input.projectId}/apps/${input.applicationId}/oidc_config`,
      {
        method: "PUT",
        headers: { "x-zitadel-orgid": input.organizationId },
        body: managementOidcApplicationConfiguration(configuration, input.loginBaseUri),
        allowNoChanges: true,
      },
    );
  }

  async configureOidcApplicationLogin(input: {
    readonly applicationId: string;
    readonly projectId: string;
    readonly organizationId: string;
    readonly loginBaseUri: string;
  }): Promise<void> {
    const response = await this.#request<{ application?: Application }>(
      "/zitadel.application.v2.ApplicationService/GetApplication",
      {
        method: "POST",
        connect: true,
        body: { applicationId: input.applicationId },
      },
    );
    if (!response.application?.oidcConfiguration) {
      throw new Error(`Application ${input.applicationId} is not an OIDC application`);
    }
    await this.#request(
      `/management/v1/projects/${input.projectId}/apps/${input.applicationId}/oidc_config`,
      {
        method: "PUT",
        headers: { "x-zitadel-orgid": input.organizationId },
        body: managementOidcApplicationConfiguration(
          response.application.oidcConfiguration,
          input.loginBaseUri,
        ),
        allowNoChanges: true,
      },
    );
  }

  async disableInstanceLoginV2Override(): Promise<void> {
    await this.#request("/v2/features/instance", {
      method: "PUT",
      body: { loginV2: { required: false } },
      allowNoChanges: true,
    });
  }

  async ensureSmtpEmailProvider(input: {
    readonly host: string;
    readonly user: string;
    readonly password: string;
    readonly senderAddress: string;
    readonly senderName: string;
    readonly replyToAddress: string;
    readonly description: string;
    readonly tls: boolean;
  }): Promise<string> {
    const response = await this.#request<{ result?: EmailProvider[] }>("/admin/v1/email/_search", {
      method: "POST",
      body: {},
    });
    const providers = response.result ?? [];
    const smtpProviders = providers.filter((provider) => provider.smtp !== undefined);
    const provider = smtpProviders.find(
      (candidate) =>
        candidate.smtp?.host === input.host &&
        candidate.smtp.user === input.user &&
        candidate.smtp.plain !== undefined,
    );
    const configuration = {
      senderAddress: input.senderAddress,
      senderName: input.senderName,
      tls: input.tls,
      host: input.host,
      user: input.user,
      replyToAddress: input.replyToAddress,
      description: input.description,
    };
    let providerId = provider?.id;
    if (!providerId) {
      const created = await this.#request<{ id: string }>("/admin/v1/email/smtp", {
        method: "POST",
        body: { ...configuration, plain: { password: input.password } },
      });
      providerId = created.id;
    } else {
      // ZITADEL 4.16.2's full SMTP update generates a duplicate password-column
      // projection when it includes `plain.password`. Update non-secret fields
      // first, then rotate the password through the dedicated endpoint.
      await this.#request(`/admin/v1/email/smtp/${encodeURIComponent(providerId)}`, {
        method: "PUT",
        body: configuration,
      });
    }

    if (provider?.state !== "EMAIL_PROVIDER_ACTIVE") {
      await this.#request(`/admin/v1/email/${encodeURIComponent(providerId)}/_activate`, {
        method: "POST",
        body: {},
      });
    }
    if (provider) {
      await this.#request(`/admin/v1/email/smtp/${encodeURIComponent(providerId)}/password`, {
        method: "PUT",
        body: { password: input.password },
      });
    }
    for (const obsolete of smtpProviders) {
      if (obsolete.id === providerId) continue;
      await this.#request(`/admin/v1/email/${encodeURIComponent(obsolete.id)}`, {
        method: "DELETE",
      });
    }
    return providerId;
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

  async #assetMatches(
    assetUrl: string | undefined,
    expected: Uint8Array,
    headers: Readonly<Record<string, string>>,
  ): Promise<boolean> {
    if (!assetUrl) return false;
    const advertisedUrl = new URL(assetUrl, `${this.#baseUrl}/`);
    const internalUrl = new URL(
      `${advertisedUrl.pathname}${advertisedUrl.search}`,
      `${this.#baseUrl}/`,
    );
    const response = await fetch(internalUrl, {
      headers: {
        authorization: `Bearer ${this.#pat}`,
        ...this.#requestHeaders,
        ...headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return false;
    return Buffer.from(await response.arrayBuffer()).equals(Buffer.from(expected));
  }

  async #uploadOrganizationLogo(
    logo: Uint8Array,
    headers: Readonly<Record<string, string>>,
  ): Promise<void> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(logo)], { type: "image/png" }), "logo.png");
    const path = "/assets/v1/org/policy/label/logo";
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#pat}`,
        ...this.#requestHeaders,
        ...headers,
      },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const body = await this.#parseResponse(response);
      throw new Error(`POST ${path} returned ${response.status}: ${JSON.stringify(body)}`);
    }
  }

  async #request<T = Record<string, never>>(path: string, options: RequestOptions): Promise<T> {
    const response = await this.#requestRaw(path, options);
    const body = await this.#parseResponse(response);
    const noChanges =
      options.allowNoChanges === true &&
      response.status === 400 &&
      typeof body === "object" &&
      body !== null &&
      "code" in body &&
      (body.code === 9 || body.code === "failed_precondition") &&
      "message" in body &&
      typeof body.message === "string" &&
      (body.message.startsWith("No changes") ||
        body.message.includes(" has not been changed") ||
        body.message.includes(".NotChanged"));
    const alreadyExists =
      options.allowAlreadyExists === true &&
      typeof body === "object" &&
      body !== null &&
      "code" in body &&
      "message" in body &&
      typeof body.message === "string" &&
      ((response.status === 409 && (body.code === 6 || body.code === "already_exists")) ||
        (response.status === 400 &&
          (body.code === 9 || body.code === "failed_precondition") &&
          body.message.includes("AlreadyExists")));
    if (!response.ok && !noChanges && !alreadyExists) {
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
