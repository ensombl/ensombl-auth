import { config } from './config'

export function safeReturnUrl(value: string | null, fallback = '/'): string {
  if (!value) return fallback

  const configured = config()
  const allowedOrigins = new Set([
    new URL(configured.PUBLIC_AUTH_URL).origin,
    configured.defaultAuthBrand.authOrigin,
    ...[...configured.authBrandByProduct.values()].map((brand) => brand.authOrigin),
    ...configured.returnOrigins,
  ])

  try {
    const candidate = new URL(value, configured.PUBLIC_AUTH_URL)
    if (!allowedOrigins.has(candidate.origin)) return fallback
    if (candidate.username || candidate.password) return fallback
    return candidate.toString()
  } catch {
    return fallback
  }
}
