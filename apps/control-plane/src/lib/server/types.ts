import type { HTMLInputAttributes } from 'svelte/elements'

export type UiMessage = {
  id: number
  text: string
  type: 'error' | 'info' | 'success'
}

type UiInputAttributes = {
  node_type: 'input'
  name: string
  type: string
  value?: string | number | boolean
  required?: boolean
  disabled?: boolean
  autocomplete?: HTMLInputAttributes['autocomplete']
}

type UiAnchorAttributes = {
  node_type: 'a'
  href: string
  title?: { text: string }
}

type UiImageAttributes = {
  node_type: 'img'
  src: string
  height?: number
  width?: number
}

type UiTextAttributes = {
  node_type: 'text'
  text: { text: string }
}

export type UiNode = {
  type: string
  group: string
  attributes: UiInputAttributes | UiAnchorAttributes | UiImageAttributes | UiTextAttributes
  messages?: UiMessage[]
  meta: {
    label?: {
      text: string
    }
  }
}

export type KratosFlow = {
  id: string
  type?: string
  state?: string
  return_to?: string
  ui: {
    action: string
    method: 'get' | 'post' | 'GET' | 'POST'
    nodes: UiNode[]
    messages?: UiMessage[]
  }
}

export type KratosSession = {
  id: string
  active: boolean
  authenticator_assurance_level?: string
  identity: {
    id: string
    state?: string
    verifiable_addresses?: Array<{
      value: string
      verified: boolean
    }>
    traits: {
      email?: string
      name?: {
        first?: string
        last?: string
      }
    }
  }
}

export type HydraClient = {
  client_id: string
  client_name?: string
  metadata?: Record<string, unknown>
}

export type HydraLoginRequest = {
  challenge: string
  client: HydraClient
  request_url: string
  requested_access_token_audience?: string[]
  requested_scope?: string[]
  session_id?: string
  skip: boolean
  subject?: string
}

export type HydraConsentRequest = {
  challenge: string
  client: HydraClient
  login_challenge?: string
  login_session_id?: string
  requested_access_token_audience?: string[]
  requested_scope?: string[]
  skip: boolean
  subject: string
}

export type HydraLogoutRequest = {
  challenge: string
  client?: HydraClient
  request_url?: string
  rp_initiated: boolean
  sid?: string
  subject?: string
}

export type OryRedirect = {
  redirect_to: string
}
