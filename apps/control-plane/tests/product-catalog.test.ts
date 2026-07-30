import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadProductCatalog } from '../src/lib/server/product-catalog'

const directories: string[] = []

function writeCatalog(tenantRoles?: Record<string, unknown>): string {
  const directory = mkdtempSync(join(tmpdir(), 'ensombl-auth-catalog-'))
  directories.push(directory)
  const path = join(directory, 'products.json')
  writeFileSync(
    path,
    JSON.stringify({
      email_from_address: 'noreply@notifications.ensombl.io',
      default_auth_brand: {
        id: 'ensombl',
        display_name: 'Ensombl',
        auth_origin: 'https://auth.ensombl.io',
        email_from_name: 'Ensombl',
      },
      products: [
        {
          id: 'example',
          auth_brand: {
            display_name: 'Example',
            auth_origin: 'https://auth.example.ensombl.io',
            email_from_name: 'Example',
          },
          return_origins: ['https://app.example.ensombl.io'],
          ...(tenantRoles ? { tenant_roles: tenantRoles } : {}),
          clients: [
            {
              id: 'example-web',
              display_name: 'Example web',
              base_url: 'https://app.example.ensombl.io',
              audience: 'example',
              admission_scope: 'example:production',
              authorization_secret_environment: 'EXAMPLE_AUTHORIZATION_SECRET',
              identity_management_secret_environment: 'EXAMPLE_IDENTITY_SECRET',
              secret_environment: 'EXAMPLE_HYDRA_SECRET',
              trusted: true,
            },
          ],
        },
      ],
    }),
  )
  return path
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('product tenant role policies', () => {
  it('provides member, admin, and owner when a product does not configure roles', () => {
    const policy = loadProductCatalog(writeCatalog()).tenantRolePolicyByProduct.get('example')

    expect(
      [...(policy?.roles.values() ?? [])].map((role) => [role.id, [...role.permissions]]),
    ).toEqual([
      ['member', ['access']],
      ['admin', ['access', 'administer']],
      ['owner', ['access', 'administer', 'owner']],
    ])
  })

  it('lets a product extend the defaults and their permissions', () => {
    const policy = loadProductCatalog(
      writeCatalog({
        mode: 'extend',
        roles: [
          { id: 'admin', permissions: ['access', 'administer', 'approve'] },
          { id: 'reviewer', permissions: ['access', 'review'] },
        ],
      }),
    ).tenantRolePolicyByProduct.get('example')

    expect([...(policy?.roles.get('admin')?.permissions ?? [])]).toEqual([
      'access',
      'administer',
      'approve',
    ])
    expect([...(policy?.roles.get('reviewer')?.permissions ?? [])]).toEqual(['access', 'review'])
    expect(policy?.roles.has('owner')).toBe(true)
  })

  it('lets FreightClaims completely replace the default stack', () => {
    const policy = loadProductCatalog(
      resolve(process.cwd(), '../../deploy/products/products.local.json'),
    ).tenantRolePolicyByProduct.get('freightclaims')

    expect([...(policy?.roles.keys() ?? [])]).toEqual(['member', 'adjuster', 'tenant_admin'])
    expect(policy?.roles.has('admin')).toBe(false)
    expect(policy?.roles.has('owner')).toBe(false)
  })

  it('gives FreightCheck the default role stack', () => {
    const policy = loadProductCatalog(
      resolve(process.cwd(), '../../deploy/products/products.json'),
    ).tenantRolePolicyByProduct.get('freightcheck')

    expect(
      [...(policy?.roles.values() ?? [])].map((role) => [role.id, [...role.permissions]]),
    ).toEqual([
      ['member', ['access']],
      ['admin', ['access', 'administer']],
      ['owner', ['access', 'administer', 'owner']],
    ])
  })
})
