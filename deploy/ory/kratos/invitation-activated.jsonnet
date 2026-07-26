function(ctx) {
  event_id: 'invitation_recovery:' + ctx.flow.id + ':' + ctx.identity.id,
  identity_id: ctx.identity.id,
  flow_id: ctx.flow.id,
}
