const { randomUUID } = require('node:crypto')
const METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
])
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
const operators = new Set([
  'exists',
  'equals',
  'notEquals',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
])
function walk(nodes, fn) {
  for (const node of nodes || []) {
    fn(node)
    walk(node.children, fn)
    walk(node.then, fn)
    walk(node.else, fn)
  }
}
function normalize(scenario = {}) {
  const copy = structuredClone(scenario)
  function nodes(list) {
    if (list !== undefined && !Array.isArray(list))
      throw new Error('Fluxo exige uma lista de blocos')
    return (list || []).map((s, i) => {
      const n = {
        ...s,
        id: s.id || randomUUID(),
        type: s.type || 'request',
        name: s.name || `Passo ${i + 1}`,
      }
      n.checks = [
        ...(s.checks || []),
        ...(s.expectedStatus !== undefined && s.expectedStatus !== ''
          ? [
              {
                source: 'status',
                operator: 'equals',
                value: Number(s.expectedStatus),
              },
            ]
          : []),
        ...(s.contains
          ? [{ source: 'text', operator: 'contains', value: s.contains }]
          : []),
        ...(s.jsonCheck
          ? [
              {
                source: 'json',
                path: s.jsonCheck.path,
                operator: 'equals',
                value: s.jsonCheck.value,
              },
            ]
          : []),
      ]
      n.extracts = [
        ...(s.extracts || []),
        ...(s.extract
          ? [{ source: 'json', ...s.extract, scope: 'journey' }]
          : []),
      ]
      for (const key of ['children', 'then', 'else'])
        if (s[key]) n[key] = nodes(s[key])
      for (const key of ['expectedStatus', 'contains', 'jsonCheck', 'extract'])
        delete n[key]
      return n
    })
  }
  return {
    ...copy,
    variables: copy.variables || [],
    steps: nodes(copy.steps),
    setup: nodes(copy.setup),
    perUser: nodes(copy.perUser),
    teardown: nodes(copy.teardown),
  }
}
function validateFlow(scenario) {
  const flow = normalize(scenario),
    ids = new Set()
  let count = 0,
    requests = 0
  const available = new Set(['VU_ID', 'VU_ITER', 'UNIQUE_ID', 'UNIQUE_EMAIL'])
  function problem(message, node, field) {
    throw Object.assign(new Error(message), {
      nodeId: node?.id,
      field,
      step: flow.steps.findIndex((s) => s.id === node?.id),
    })
  }
  for (const v of flow.variables) {
    if (
      !NAME.test(v.key) ||
      forbidden.has(v.key) ||
      available.has(v.key) ||
      typeof v.value !== 'string'
    )
      problem('Nome de variável inválido ou duplicado', null, 'variables')
    available.add(v.key)
  }
  if (flow.dataset?.rows?.[0])
    for (const key of Object.keys(flow.dataset.rows[0])) available.add(key)
  if (flow.variables.length > 100)
    problem('Até 100 variáveis', null, 'variables')
  const refs = (text, scope, node, field) => {
    for (const m of String(text ?? '').matchAll(/\{\{([^{}]+)\}\}/g))
      if (
        !scope.has(m[1].split('.')[0]) ||
        m[1].split('.').some((k) => forbidden.has(k))
      )
        problem(`variável não definida: ${m[1]}`, node, field)
  }
  const path = (value, node, field) => {
    if (
      typeof value !== 'string' ||
      value.length > 200 ||
      !value
        .split('.')
        .every((p) => /^[A-Za-z0-9_-]+$/.test(p) && !forbidden.has(p))
    )
      problem('Caminho JSON: use pontos, como items.0.id', node, field)
  }
  let phase = 'setup'
  function validate(list, scope, depth = 0) {
    if (!Array.isArray(list) || depth > 10)
      problem('Fluxo inválido ou profundidade acima de 10')
    for (const n of list) {
      if (
        ++count > 200 ||
        typeof n.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(n.id) ||
        ids.has(n.id)
      )
        problem('Até 200 blocos com IDs únicos', n, 'id')
      ids.add(n.id)
      if (
        (n.checks && !Array.isArray(n.checks)) ||
        (n.extracts && !Array.isArray(n.extracts)) ||
        (n.checks?.length || 0) > 50 ||
        (n.extracts?.length || 0) > 50
      )
        problem('Até 50 validações e extrações por bloco', n, 'checks')
      if (typeof n.name !== 'string' || n.name.length > 120)
        problem('Nome inválido', n, 'name')
      if (n.type === 'request') {
        requests++
        if (
          typeof n.url !== 'string' ||
          n.url.length > 10000 ||
          (n.body !== undefined &&
            (typeof n.body !== 'string' || n.body.length > 100000))
        )
          problem('URL ou corpo excedeu o limite', n, 'url')
        if (!METHODS.has(n.method)) problem('Método inválido', n, 'method')
        refs(n.url, scope, n, 'url')
        try {
          const u = new URL(
            String(n.url).replace(
              /\{\{([^{}]+)\}\}/g,
              (_, key) =>
                flow.variables.find((v) => v.key === key)?.value ??
                (n.url.startsWith('{{' + key + '}}')
                  ? 'http://example.invalid'
                  : 'sample')
            )
          )
          if (!['http:', 'https:'].includes(u.protocol)) throw Error()
        } catch {
          problem('Informe uma URL HTTP ou HTTPS válida', n, 'url')
        }
        if (!Array.isArray(n.headers || []) || (n.headers || []).length > 100)
          problem('Headers inválidos', n, 'headers')
        for (const h of n.headers || []) {
          if (
            !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(h.key) ||
            typeof h.value !== 'string' ||
            /[\r\n]/.test(h.value)
          )
            problem(
              'Header inválido: não pode conter quebra de linha',
              n,
              'headers'
            )
          refs(h.value, scope, n, 'headers')
        }
        if (!['none', 'json', 'text', 'form'].includes(n.bodyType || 'none'))
          problem('Tipo de corpo inválido', n, 'bodyType')
        refs(n.body, scope, n, 'body')
        if (n.bodyType === 'json') {
          try {
            JSON.parse(String(n.body || '').replace(/\{\{[^{}]+\}\}/g, '0'))
          } catch {
            problem('Corpo JSON inválido', n, 'body')
          }
        }
        if (
          n.timeout !== undefined &&
          (!Number.isInteger(n.timeout) || n.timeout < 1 || n.timeout > 600000)
        )
          problem('Timeout inválido', n, 'timeout')
        if (
          n.retries !== undefined &&
          (!Number.isInteger(n.retries) || n.retries < 0 || n.retries > 5)
        )
          problem('Até 5 novas tentativas', n, 'retries')
        for (const c of n.checks) {
          if (
            !c ||
            !['status', 'json', 'text', 'header', 'cookie'].includes(
              c.source
            ) ||
            !operators.has(c.operator)
          )
            problem('Validação inválida', n, 'checks')
          if (c.operator !== 'exists' && c.value === undefined)
            problem('Validação exige valor esperado', n, 'checks')
          if (c.source === 'json') path(c.path, n, 'checks')
        }
        for (const e of n.extracts) {
          if (
            (e?.scope === 'global' && !['setup', 'teardown'].includes(phase)) ||
            (e?.scope === 'session' && ['setup', 'teardown'].includes(phase))
          )
            problem('Escopo de extração incompatível com a fase', n, 'extracts')
          if (
            !e ||
            !['json', 'header', 'cookie'].includes(e.source) ||
            !NAME.test(e.variable) ||
            forbidden.has(e.variable) ||
            !['journey', 'session', 'global'].includes(e.scope || 'journey')
          )
            problem('Extração inválida', n, 'extracts')
          if (e.source === 'json') path(e.path, n, 'extracts')
          scope.add(e.variable)
        }
      } else if (n.type === 'pause') {
        if (
          !Number.isFinite(n.ms) ||
          n.ms < 0 ||
          n.ms > 60000 ||
          (n.maxMs !== undefined &&
            (!Number.isFinite(n.maxMs) || n.maxMs < n.ms || n.maxMs > 60000))
        )
          problem('Pausa entre 0 e 60000 ms', n, 'ms')
      } else if (n.type === 'condition') {
        condition(n.condition, scope, n)
        const left = new Set(scope),
          right = new Set(scope)
        validate(n.then || [], left, depth + 1)
        validate(n.else || [], right, depth + 1)
        for (const key of left) if (right.has(key)) scope.add(key)
      } else if (n.type === 'loop') {
        if (!Number.isInteger(n.limit) || n.limit < 1 || n.limit > 1000)
          problem('Loop exige limite de 1 a 1000', n, 'limit')
        if (!['count', 'items', 'while'].includes(n.mode))
          problem('Modo de repetição inválido', n, 'mode')
        const inner = new Set(scope)
        if (n.mode === 'items') {
          if (!scope.has(n.variable))
            problem('Variável da coleção não definida', n, 'variable')
          inner.add('ITEM')
          inner.add('INDEX')
        }
        if (n.mode === 'while') condition(n.condition, inner, n)
        validate(n.children || [], inner, depth + 1)
      } else if (n.type === 'group')
        validate(n.children || [], scope, depth + 1)
      else problem('Tipo de bloco inválido', n, 'type')
    }
  }
  function condition(c, scope, n) {
    if (
      !c ||
      !scope.has(String(c.variable).split('.')[0]) ||
      !operators.has(c.operator)
    )
      problem(
        'Condição exige variável disponível e operador válido',
        n,
        'condition'
      )
    if (c.operator !== 'exists' && c.value === undefined)
      problem('Condição exige valor de comparação', n, 'condition')
  }
  const global = new Set(flow.variables.map((v) => v.key))
  validate(flow.setup, global)
  const user = new Set([...global, ...available])
  phase = 'perUser'
  validate(flow.perUser, user)
  phase = 'steps'
  validate(flow.steps, new Set(user))
  phase = 'teardown'
  validate(flow.teardown, new Set(global))
  let journeyRequests = 0
  walk(flow.steps, (n) => {
    if (n.type === 'request') journeyRequests++
  })
  if (!requests || !flow.steps.length || !journeyRequests)
    problem('Informe ao menos uma requisição e uma jornada')
  if (flow.dataset) {
    const d = flow.dataset
    if (
      !Array.isArray(d.rows) ||
      !d.rows.length ||
      d.rows.length > 10000 ||
      !['user', 'iteration'].includes(d.select) ||
      !['cycle', 'error'].includes(d.exhaustion)
    )
      problem(
        'Dados: de 1 a 10000 linhas, seleção e política obrigatórias',
        null,
        'dataset'
      )
    for (const row of d.rows)
      if (
        !row ||
        Array.isArray(row) ||
        typeof row !== 'object' ||
        Object.keys(row).some((k) => !NAME.test(k) || forbidden.has(k))
      )
        problem('Linha de dados inválida', null, 'dataset')
  }
  return flow
}
module.exports = { normalize, validateFlow, walk }
function describe(scenario) {
  const rows = []
  function visit(nodes, phase, parent, branch) {
    for (const n of nodes) {
      const refs = new Set()
      for (const text of [
        n.url,
        n.body,
        ...(n.headers || []).map((h) => h.value),
      ])
        for (const m of String(text || '').matchAll(/\{\{([^{}]+)\}\}/g))
          refs.add(m[1])
      rows.push({
        id: n.id,
        type: n.type,
        name: n.name,
        phase,
        parent,
        branch,
        method: n.method,
        url: n.url ? require('./report/metrics').sanitizeUrl(n.url) : undefined,
        limit: n.limit,
        mode: n.mode,
        condition: n.condition
          ? { variable: n.condition.variable, operator: n.condition.operator }
          : undefined,
        dependsOn: [...refs],
        extracts: (n.extracts || []).map((e) => e.variable),
      })
      for (const key of ['children', 'then', 'else'])
        visit(n[key] || [], phase, n.id, key)
    }
  }
  for (const phase of ['setup', 'perUser', 'steps', 'teardown'])
    visit(scenario[phase], phase, null, null)
  return rows
}
module.exports.describe = describe
