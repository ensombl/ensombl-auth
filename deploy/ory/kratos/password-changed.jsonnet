function(ctx)
  local identity_id =
    if std.objectHas(ctx, 'identity') && std.objectHas(ctx.identity, 'id') then
      ctx.identity.id
    else
      ctx.session.identity.id;
  local session_id =
    if std.objectHas(ctx, 'session') && std.objectHas(ctx.session, 'id') then
      ctx.session.id
    else
      null;
  {
    event_id: 'password_changed:' + ctx.flow.id + ':' + identity_id,
    identity_id: identity_id,
    flow_id: ctx.flow.id,
  } + if session_id == null then {} else { session_id: session_id }
