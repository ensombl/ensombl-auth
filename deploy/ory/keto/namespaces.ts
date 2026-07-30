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

class TenantRole implements Namespace {
  related: {
    assignees: User[]
  }

  permits = {
    assigned: (ctx: Context): boolean => this.related.assignees.includes(ctx.subject),
  }
}
