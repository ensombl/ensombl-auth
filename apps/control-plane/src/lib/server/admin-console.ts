import { isResetRequired } from './db'
import { hasProductAdministrationStrict } from './keto'
import { getKratosSession } from './ory'

export type AdminProduct = {
  id: string
  displayName: string
}

export type AdminConsoleAccess =
  | { state: 'authorized'; products: AdminProduct[] }
  | { state: 'login_required' }
  | { state: 'password_reset_required' }
  | { state: 'product_administrator_required' }

type AdminConsoleDependencies = {
  getKratosSession: typeof getKratosSession
  isResetRequired: typeof isResetRequired
  hasProductAdministrationStrict: typeof hasProductAdministrationStrict
}

const dependencies: AdminConsoleDependencies = {
  getKratosSession,
  isResetRequired,
  hasProductAdministrationStrict,
}

export async function adminConsoleAccess(
  cookie: string | null,
  products: readonly AdminProduct[],
  overrides: AdminConsoleDependencies = dependencies,
): Promise<AdminConsoleAccess> {
  const session = await overrides.getKratosSession(cookie)
  if (!session?.active || session.identity.state === 'inactive') {
    return { state: 'login_required' }
  }
  if (await overrides.isResetRequired(session.identity.id)) {
    return { state: 'password_reset_required' }
  }

  const administration = await Promise.all(
    products.map((product) =>
      overrides.hasProductAdministrationStrict(session.identity.id, product.id),
    ),
  )
  const allowedProducts = products.filter((_, index) => administration[index])
  if (allowedProducts.length === 0) {
    return { state: 'product_administrator_required' }
  }
  return { state: 'authorized', products: allowedProducts }
}
