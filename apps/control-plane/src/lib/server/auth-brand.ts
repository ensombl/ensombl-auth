import { config } from './config'
import type { AuthBrand } from './product-catalog'

export function authBrandForHostname(hostname: string): AuthBrand {
  return config().authBrandByHostname.get(hostname.toLowerCase()) ?? config().defaultAuthBrand
}

export function authBrandForProduct(product: string): AuthBrand {
  return config().authBrandByProduct.get(product) ?? config().defaultAuthBrand
}

export function authBrandForMarker(marker: string | undefined): AuthBrand {
  if (!marker || marker === config().defaultAuthBrand.id) return config().defaultAuthBrand
  const brand = config().authBrandByProduct.get(marker)
  if (!brand) throw new Error('unknown_auth_product')
  return brand
}

export function authProductMarkerForAdmission(productOrScope: string): string {
  const configured = config()
  if (configured.authBrandByProduct.has(productOrScope)) return productOrScope

  const products = new Set<string>()
  for (const [clientId, admissionScope] of configured.admissionScopeByClient) {
    if (admissionScope !== productOrScope) continue
    const product = configured.clientProductMap.get(clientId)
    if (product) products.add(product)
  }
  if (products.size !== 1) throw new Error('unknown_auth_product')
  return [...products][0] as string
}
