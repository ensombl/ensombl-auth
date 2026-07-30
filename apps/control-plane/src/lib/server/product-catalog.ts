import { readFileSync } from 'node:fs'
import { z } from 'zod'

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const clientIdentifier = z.string().regex(/^[A-Za-z0-9._-]+$/)
const admissionScope = z.string().regex(/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/)
const emailAddress = z.string().email().max(320)
const httpsOrLoopbackUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value)
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        (['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
          url.hostname.endsWith('.localhost')))
    )
  }, 'Product URLs must use HTTPS except for loopback development')

const clientSchema = z
  .object({
    id: clientIdentifier,
    display_name: z.string().min(1).max(100),
    base_url: httpsOrLoopbackUrl,
    audience: identifier,
    admission_scope: admissionScope,
    authorization_secret_environment: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
    identity_management_secret_environment: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
    identity_migration_secret_environment: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]+$/)
      .optional(),
    identity_migration_source: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,99}$/)
      .optional(),
    secret_environment: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
    trusted: z.boolean(),
  })
  .superRefine((client, context) => {
    if (
      (client.identity_migration_secret_environment === undefined) !==
      (client.identity_migration_source === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Identity migration source and secret environment must be configured together',
      })
    }
  })

const authBrandSchema = z.object({
  display_name: z.string().min(1).max(100),
  auth_origin: httpsOrLoopbackUrl,
  email_from_name: z.string().min(1).max(100),
})

const catalogSchema = z.object({
  schema_version: z.literal(2),
  email_from_address: emailAddress,
  default_auth_brand: authBrandSchema.extend({
    id: identifier,
  }),
  products: z
    .array(
      z.object({
        id: identifier,
        auth_brand: authBrandSchema,
        return_origins: z.array(httpsOrLoopbackUrl).min(1),
        clients: z.array(clientSchema).min(1),
      }),
    )
    .min(1),
})

export interface AuthBrand {
  readonly id: string
  readonly displayName: string
  readonly authOrigin: string
  readonly emailFromName: string
}

export interface ProductCatalogConfiguration {
  readonly emailFromAddress: string
  readonly defaultAuthBrand: AuthBrand
  readonly authBrandByProduct: ReadonlyMap<string, AuthBrand>
  readonly authBrandByHostname: ReadonlyMap<string, AuthBrand>
  readonly admissionScopeByClient: ReadonlyMap<string, string>
  readonly authorizationSecretEnvironmentByClient: ReadonlyMap<string, string>
  readonly identityManagementSecretEnvironmentByClient: ReadonlyMap<string, string>
  readonly identityMigrationSecretEnvironmentByClient: ReadonlyMap<string, string>
  readonly identityMigrationSourceByClient: ReadonlyMap<string, string>
  readonly clientProductMap: ReadonlyMap<string, string>
  readonly trustedClientIds: ReadonlySet<string>
  readonly returnOrigins: ReadonlySet<string>
}

export function loadProductCatalog(path: string): ProductCatalogConfiguration {
  const catalog = catalogSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  const defaultAuthBrand: AuthBrand = {
    id: catalog.default_auth_brand.id,
    displayName: catalog.default_auth_brand.display_name,
    authOrigin: new URL(catalog.default_auth_brand.auth_origin).origin,
    emailFromName: catalog.default_auth_brand.email_from_name,
  }
  const authBrandByProduct = new Map<string, AuthBrand>()
  const authBrandByHostname = new Map<string, AuthBrand>([
    [new URL(defaultAuthBrand.authOrigin).hostname, defaultAuthBrand],
  ])
  const clientProductMap = new Map<string, string>()
  const admissionScopeByClient = new Map<string, string>()
  const authorizationSecretEnvironmentByClient = new Map<string, string>()
  const identityManagementSecretEnvironmentByClient = new Map<string, string>()
  const identityMigrationSecretEnvironmentByClient = new Map<string, string>()
  const identityMigrationSourceByClient = new Map<string, string>()
  const trustedClientIds = new Set<string>()
  const returnOrigins = new Set<string>()
  const audiences = new Set<string>()

  for (const product of catalog.products) {
    if (product.id === defaultAuthBrand.id) {
      throw new Error(`Product ID conflicts with the default auth brand: ${product.id}`)
    }
    const authBrand: AuthBrand = {
      id: product.id,
      displayName: product.auth_brand.display_name,
      authOrigin: new URL(product.auth_brand.auth_origin).origin,
      emailFromName: product.auth_brand.email_from_name,
    }
    const authHostname = new URL(authBrand.authOrigin).hostname
    const existingBrand = authBrandByHostname.get(authHostname)
    if (existingBrand && existingBrand.authOrigin !== authBrand.authOrigin) {
      throw new Error(`Auth hostname uses conflicting origins: ${authHostname}`)
    }
    if (existingBrand && existingBrand.id !== defaultAuthBrand.id) {
      throw new Error(`Duplicate product auth hostname: ${authHostname}`)
    }
    authBrandByProduct.set(product.id, authBrand)
    if (!existingBrand) authBrandByHostname.set(authHostname, authBrand)
    for (const value of product.return_origins) {
      const url = new URL(value)
      if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
        throw new Error(`Product return origin must not contain a path or credentials: ${value}`)
      }
      returnOrigins.add(url.origin)
    }
    for (const client of product.clients) {
      if (clientProductMap.has(client.id)) {
        throw new Error(`Duplicate product client ID: ${client.id}`)
      }
      if (audiences.has(client.audience)) {
        throw new Error(`Duplicate product audience: ${client.audience}`)
      }
      if (!returnOrigins.has(new URL(client.base_url).origin)) {
        throw new Error(`Client ${client.id} base URL is not an allowed product return origin`)
      }
      clientProductMap.set(client.id, product.id)
      admissionScopeByClient.set(client.id, client.admission_scope)
      authorizationSecretEnvironmentByClient.set(client.id, client.authorization_secret_environment)
      identityManagementSecretEnvironmentByClient.set(
        client.id,
        client.identity_management_secret_environment,
      )
      if (
        client.identity_migration_secret_environment !== undefined &&
        client.identity_migration_source !== undefined
      ) {
        identityMigrationSecretEnvironmentByClient.set(
          client.id,
          client.identity_migration_secret_environment,
        )
        identityMigrationSourceByClient.set(client.id, client.identity_migration_source)
      }
      audiences.add(client.audience)
      if (client.trusted) trustedClientIds.add(client.id)
    }
  }

  return {
    emailFromAddress: catalog.email_from_address,
    defaultAuthBrand,
    authBrandByProduct,
    authBrandByHostname,
    admissionScopeByClient,
    authorizationSecretEnvironmentByClient,
    identityManagementSecretEnvironmentByClient,
    identityMigrationSecretEnvironmentByClient,
    identityMigrationSourceByClient,
    clientProductMap,
    trustedClientIds,
    returnOrigins,
  }
}
