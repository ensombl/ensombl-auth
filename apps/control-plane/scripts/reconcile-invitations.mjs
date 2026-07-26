import { reconcileInvitations, reconciliationConfig } from './invitation-reconciler-client.mjs'

const reconciled = await reconcileInvitations(reconciliationConfig())
console.info(`Reconciled ${reconciled} invitation activation${reconciled === 1 ? '' : 's'}.`)
