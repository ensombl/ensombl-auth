function(ctx) {
  recipient: ctx.recipient,
  subject: ctx.subject,
  body: ctx.body,
  html_body: if std.objectHas(ctx, 'html_body') then ctx.html_body else null,
  template_type: ctx.template_type,
  message_type: ctx.message_type,
  request_headers: ctx.request_headers,
}
