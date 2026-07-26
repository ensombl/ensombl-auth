import { Context, Namespace } from '@ory/keto-namespace-types'

class User implements Namespace {}

class Ensombl implements Namespace {
  related: {
    platform_administrators: User[]
    support: User[]
  }

  permits = {
    administer: (ctx: Context): boolean =>
      this.related.platform_administrators.includes(ctx.subject),
    support: (ctx: Context): boolean =>
      this.related.platform_administrators.includes(ctx.subject) ||
      this.related.support.includes(ctx.subject),
  }
}

class Product implements Namespace {
  related: {
    ensombl: Ensombl[]
    members: User[]
    administrators: User[]
  }

  permits = {
    access: (ctx: Context): boolean =>
      this.related.members.includes(ctx.subject) ||
      this.related.administrators.includes(ctx.subject) ||
      this.related.ensombl.traverse((root) => root.permits.support(ctx)),
    administer: (ctx: Context): boolean =>
      this.related.administrators.includes(ctx.subject) ||
      this.related.ensombl.traverse((root) => root.permits.administer(ctx)),
  }
}

class Organization implements Namespace {
  related: {
    ensombl: Ensombl[]
    members: User[]
    administrators: User[]
  }

  permits = {
    access: (ctx: Context): boolean =>
      this.related.members.includes(ctx.subject) ||
      this.related.administrators.includes(ctx.subject) ||
      this.related.ensombl.traverse((root) => root.permits.support(ctx)),
    administer: (ctx: Context): boolean =>
      this.related.administrators.includes(ctx.subject) ||
      this.related.ensombl.traverse((root) => root.permits.administer(ctx)),
    elevate: (ctx: Context): boolean =>
      this.related.ensombl.traverse((root) => root.permits.administer(ctx)),
  }
}

class FreightClaimsTenant implements Namespace {
  related: {
    organization: Organization[]
    product: Product[]
  }

  permits = {
    access: (ctx: Context): boolean =>
      this.related.product.traverse((product) => product.permits.access(ctx)) &&
      this.related.organization.traverse((org) => org.permits.access(ctx)),
    administer: (ctx: Context): boolean =>
      this.related.product.traverse((product) => product.permits.administer(ctx)) ||
      this.related.organization.traverse((org) => org.permits.administer(ctx)),
    elevate: (ctx: Context): boolean =>
      this.related.organization.traverse((org) => org.permits.elevate(ctx)),
  }
}
