const sensitive =
  /token|secret|password|passwd|api.?key|authorization|cookie|credential|jwt/i
function makeRedactor(values) {
  const add = (value) => {
    if (typeof value === 'string' && value.length && !value.includes('{{'))
      values.add(value)
  }
  const redact = (value) => {
    let text = String(value || '')
    for (const secret of [...values].sort((a, b) => b.length - a.length))
      text = text.split(secret).join('[oculto]')
    return text.replace(/(Bearer\s+)[^\s"',;]+/gi, '$1[oculto]').slice(0, 4000)
  }
  redact.learn = add
  redact.fork = () => makeRedactor(new Set(values))
  return redact
}
function redactor(config) {
  const values = new Set(),
    redact = makeRedactor(values),
    add = redact.learn
  for (const v of [
    ...(config.collection.variable || []),
    ...(config.environment?.values || []),
  ])
    if (sensitive.test(v.key) && v.enabled !== false && v.disabled !== true)
      add(v.value)
  const walk = (items) => {
    for (const item of items) {
      if (item.item) walk(item.item)
      for (const h of item.request?.header || [])
        if (/authorization|cookie|token|key|secret/i.test(h.key)) {
          add(h.value)
          add(h.value?.replace(/^Bearer\s+/i, ''))
        }
      for (const a of item.request?.auth?.[item.request.auth.type] || [])
        add(a.value)
      for (const a of item.auth?.[item.auth.type] || []) add(a.value)
      try {
        const url = new URL(
          typeof item.request?.url === 'string'
            ? item.request.url
            : item.request?.url?.raw
        )
        add(decodeURIComponent(url.password))
        for (const [key, value] of url.searchParams)
          if (sensitive.test(key)) add(value)
      } catch {
        /* Unresolved URLs are handled at request time. */
      }
    }
  }
  walk(config.collection.item || [])
  for (const a of config.collection.auth?.[config.collection.auth.type] || [])
    add(a.value)
  return redact
}
module.exports = { redactor }
