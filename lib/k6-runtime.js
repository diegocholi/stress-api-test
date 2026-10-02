// Copied into the private execution directory; evaluated by k6, not Node.js.
import http from 'k6/http'
import { sleep } from 'k6'
import execution from 'k6/execution'
import { Counter } from 'k6/metrics'
const completedJourneys = new Counter('stress_journeys')
const config = JSON.parse(open('./config.json'))
export const options = JSON.parse(open('./options.json'))
let session = {},
  initialized = false,
  sequence = 0,
  streamLabel = 'setup'
const secrets = new Set()
for (const v of config.scenario.variables)
  if (v.secret || /token|secret|password|credential|key/i.test(v.key))
    secrets.add(v.value)
function utf8Bytes(text) {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4
  }
  return bytes
}
function redact(value) {
  let s = String(value || '')
  for (const secret of secrets)
    if (secret) s = s.split(String(secret)).join('[oculto]')
  return s.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [oculto]').slice(0, 4000)
}
function urlSafe(raw) {
  return redact(
    String(raw)
      .replace(/(https?:\/\/)[^/?#]*@/gi, '$1')
      .replace(/([?&][^=&#]+=)[^&#]*/g, '$1[oculto]')
      .split('#')[0]
  )
}
function emit(event) {
  console.log(
    JSON.stringify({
      channel: 'stress-event',
      stream: streamLabel,
      sequence: ++sequence,
      vu: execution.vu.idInTest || 0,
      iter: execution.vu.iterationInScenario + 1,
      ts: Date.now(),
      ...event,
    })
  )
}
function path(value, key) {
  return String(key)
    .split('.')
    .reduce(
      (v, k) =>
        v != null && Object.prototype.hasOwnProperty.call(v, k)
          ? v[k]
          : undefined,
      value
    )
}
function resolve(raw, vars) {
  return String(raw ?? '').replace(/\{\{([^{}]+)\}\}/g, (_, key) => {
    if (path(vars, key) === undefined)
      throw Error('Variável indisponível: ' + key)
    return typeof path(vars, key) === 'object'
      ? JSON.stringify(path(vars, key))
      : String(path(vars, key))
  })
}
function jsonBody(raw, vars) {
  let result = '',
    quoted = false,
    escaped = false
  const text = String(raw)
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '{' && text[i + 1] === '{') {
      const end = text.indexOf('}}', i + 2)
      if (end < 0) throw Error('Variável inválida')
      const key = text.slice(i + 2, end),
        value = path(vars, key)
      if (value === undefined) throw Error('Variável indisponível: ' + key)
      const string =
        typeof value === 'object' ? JSON.stringify(value) : String(value)
      result += quoted
        ? JSON.stringify(string).slice(1, -1)
        : JSON.stringify(value)
      i = end + 1
      escaped = false
      continue
    }
    result += c
    if (c === '"' && !escaped) quoted = !quoted
    if (c === '\\' && !escaped) escaped = true
    else escaped = false
  }
  JSON.parse(result)
  return result
}
function compare(a, op, b) {
  if (op === 'exists') return a !== undefined && a !== null
  if (op === 'equals') return JSON.stringify(a) === JSON.stringify(b)
  if (op === 'notEquals') return JSON.stringify(a) !== JSON.stringify(b)
  if (op === 'contains')
    return (
      (typeof a === 'string' && a.includes(String(b))) ||
      (Array.isArray(a) &&
        a.some((v) => JSON.stringify(v) === JSON.stringify(b)))
    )
  if (op === 'gt') return a > b
  if (op === 'gte') return a >= b
  if (op === 'lt') return a < b
  if (op === 'lte') return a <= b
  return false
}
function redirectURL(location, current) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(location) && !/^https?:\/\//i.test(location))
    throw Error('Redirect exige HTTP ou HTTPS')
  const origin = current.match(/^https?:\/\/[^/?#]+/i)[0],
    base = (current.slice(origin.length) || '/').split(/[?#]/)[0]
  let next = /^https?:\/\//i.test(location)
    ? location
    : location.startsWith('//')
      ? current.split(':')[0] + ':' + location
      : location.startsWith('?')
        ? origin + base + location
        : location.startsWith('/')
          ? origin + location
          : origin + base.slice(0, base.lastIndexOf('/') + 1) + location
  next = next.split('#')[0]
  const host = next.match(/^https?:\/\/[^/?#]+/i)[0],
    suffix = next.slice(host.length),
    queryAt = suffix.indexOf('?'),
    query = queryAt >= 0 ? suffix.slice(queryAt) : '',
    parts = (queryAt >= 0 ? suffix.slice(0, queryAt) : suffix).split('/'),
    clean = []
  for (const part of parts) {
    if (part === '..') clean.pop()
    else if (part !== '.') clean.push(part)
  }
  return host + (clean.join('/') || '/') + query
}
function responseValue(res, c) {
  if (c.source === 'status') return res.status
  if (c.source === 'text') return res.body
  if (c.source === 'header') {
    const key = Object.keys(res.headers).find(
      (k) => k.toLowerCase() === String(c.path).toLowerCase()
    )
    return res.headers[key]
  }
  if (c.source === 'cookie') return res.cookies[c.path]?.[0]?.value
  return path(res.json(), c.path)
}
function context(vars, node, runId) {
  return {
    runId,
    executionId: runId + '-' + node.id + '-' + sequence,
    nodeId: node.id,
    nodeType: node.type,
    name: node.name,
    method: node.method || '',
    url: node.url ? urlSafe(resolve(node.url, vars)) : '',
    route: node.url ? urlSafe(node.url) : '',
  }
}
function blocks(nodes, vars, runId, phase, deadline) {
  let failed = false
  for (const node of nodes) {
    const startedAt = Date.now(),
      ctx = {
        runId,
        executionId: runId + '-' + node.id + '-' + sequence,
        nodeId: node.id,
        nodeType: node.type,
        name: node.name,
        method: node.method || '',
        route: node.url ? urlSafe(node.url) : '',
      }
    emit({ ...ctx, type: 'stepStart', phase })
    let bad = false,
      skipped = false
    try {
      if (Date.now() > deadline) throw Error('Prazo do cenário excedido')
      ctx.url = node.url ? urlSafe(resolve(node.url, vars)) : ''
      if (node.type === 'pause') {
        const ms = node.ms + Math.random() * ((node.maxMs ?? node.ms) - node.ms)
        emit({ ...ctx, type: 'pauseStart', phase })
        sleep(Math.min(ms, Math.max(0, deadline - Date.now())) / 1000)
        emit({
          ...ctx,
          type: 'pauseEnd',
          phase,
          durationMs: Date.now() - startedAt,
        })
        if (Date.now() > deadline) throw Error('Prazo do cenário excedido')
      } else if (node.type === 'group')
        bad = blocks(node.children, vars, runId, phase, deadline)
      else if (node.type === 'condition') {
        const yes = compare(
          path(vars, node.condition.variable),
          node.condition.operator,
          node.condition.value
        )
        emit({ ...ctx, type: 'branch', phase, selected: yes ? 'then' : 'else' })
        markSkipped(yes ? node.else : node.then, runId, phase)
        bad = blocks(yes ? node.then : node.else, vars, runId, phase, deadline)
      } else if (node.type === 'loop') {
        let list
        if (node.mode === 'items') {
          list = vars[node.variable]
          if (typeof list === 'string') list = JSON.parse(list)
          if (!Array.isArray(list)) throw Error('Loop exige array')
        }
        const length =
          node.mode === 'items' ? Math.min(list.length, node.limit) : node.limit
        for (let i = 0; i < length; i++) {
          if (
            node.mode === 'while' &&
            !compare(
              path(vars, node.condition.variable),
              node.condition.operator,
              node.condition.value
            )
          )
            break
          const inner = { ...vars, ITEM: list?.[i], INDEX: i }
          bad = blocks(node.children, inner, runId, phase, deadline) || bad
          for (const key of Object.keys(vars)) vars[key] = inner[key]
          if (bad && config.bail) break
        }
        if (length === 0) markSkipped(node.children, runId, phase)
        if (node.mode === 'items' && list.length > node.limit)
          emit({
            ...ctx,
            type: 'loopLimit',
            phase,
            message: 'Coleção limitada a ' + node.limit + ' itens',
          })
        if (
          node.mode === 'while' &&
          compare(
            path(vars, node.condition.variable),
            node.condition.operator,
            node.condition.value
          )
        )
          throw Error('Limite do loop atingido')
      } else if (node.type === 'request') {
        for (let attempt = 0; attempt <= Number(node.retries || 0); attempt++) {
          bad = false
          const headers = {}
          for (const h of node.headers || []) {
            headers[h.key] = resolve(h.value, vars)
            if (/[\r\n]/.test(headers[h.key]))
              throw Error('Header inválido após substituir variáveis')
            if (/authorization|cookie|token|key|secret/i.test(h.key))
              secrets.add(headers[h.key].replace(/^(Bearer|Basic)\s+/i, ''))
          }
          let body = null
          if (node.bodyType === 'json') {
            body = jsonBody(node.body, vars)
            if (
              !Object.keys(headers).some(
                (k) => k.toLowerCase() === 'content-type'
              )
            )
              headers['Content-Type'] = 'application/json'
          } else if (node.bodyType === 'text') body = resolve(node.body, vars)
          else if (node.bodyType === 'form')
            body = Object.fromEntries(
              resolve(node.body, vars)
                .split('&')
                .filter(Boolean)
                .map((p) => {
                  const i = p.indexOf('=')
                  return [
                    decodeURIComponent(p.slice(0, i)),
                    decodeURIComponent(p.slice(i + 1)),
                  ]
                })
            )
          let url = resolve(node.url, vars),
            method = node.method
          if (!/^https?:\/\/[^/?#\s]+(?:[/?#]|$)/i.test(url))
            throw Error('URL HTTP inválida após substituir variáveis')
          for (let redirect = 0; redirect <= 10; redirect++) {
            const requestId =
                runId +
                '-' +
                node.id +
                '-' +
                sequence +
                '-' +
                attempt +
                '-' +
                redirect,
              begin = Date.now()
            emit({
              ...ctx,
              type: 'requestStart',
              requestId,
              ts: begin,
              phase,
              attempt: attempt + 1,
            })
            const timeout = Math.max(
              1,
              Math.min(node.timeout || config.timeout, deadline - Date.now())
            )
            const res = http.request(method, url, body, {
              headers,
              timeout: timeout + 'ms',
              redirects: 0,
              tags: { name: node.id, phase, step: node.id },
            })
            const transport = !res.status,
              redirecting =
                [301, 302, 303, 307, 308].includes(res.status) &&
                !!(res.headers.Location || res.headers.location),
              statusChecks = (node.checks || []).filter(
                (c) => c.source === 'status'
              ),
              unexpected =
                !redirecting &&
                statusChecks.some(
                  (c) => !compare(res.status, c.operator, c.value)
                )
            const fail =
              transport ||
              (!redirecting &&
                (statusChecks.length ? unexpected : res.status >= 400))
            bad = bad || fail
            emit({
              ...ctx,
              type: 'request',
              requestId,
              startedAt: begin,
              phase,
              attempt: attempt + 1,
              url: urlSafe(url),
              code: res.status,
              latency: transport ? null : res.timings.duration,
              totalTimeMs: Date.now() - begin,
              waitingMs: res.timings.waiting,
              connectingMs: res.timings.connecting,
              tlsMs: res.timings.tls_handshaking,
              bytes: typeof res.body === 'string' ? utf8Bytes(res.body) : null,
              failed: fail,
              transport,
              message: res.error ? redact(res.error) : '',
              expectedStatus: !unexpected,
            })
            const location = res.headers.Location || res.headers.location
            if ([301, 302, 303, 307, 308].includes(res.status) && location) {
              if (redirect === 10) throw Error('Limite de redirects atingido')
              const origin = url.match(/^https?:\/\/[^/?#]+/)[0]
              const next = redirectURL(location, url)
              if (!next.startsWith(origin + '/'))
                for (const key of Object.keys(headers))
                  if (/authorization|cookie/i.test(key)) delete headers[key]
              url = next
              if (
                res.status === 303 ||
                ([301, 302].includes(res.status) && method === 'POST')
              ) {
                method = 'GET'
                body = null
              }
              continue
            }
            for (const c of node.checks || []) {
              let pass = false
              try {
                pass = compare(responseValue(res, c), c.operator, c.value)
              } catch {}
              bad = bad || !pass
              emit({
                ...ctx,
                type: 'validation',
                phase,
                assertion:
                  c.name || c.source + ' ' + (c.path || '') + ' ' + c.operator,
                passed: pass,
                skipped: false,
                message: pass ? '' : 'Valor inesperado ou ausente',
              })
            }
            for (const e of node.extracts || []) {
              let value
              try {
                value = responseValue(res, e)
              } catch {}
              const pass = value !== undefined && value !== null
              bad = bad || !pass
              if (pass) {
                vars[e.variable] = value
                if (e.scope === 'session') session[e.variable] = value
                if (e.secret || /token|secret|password|key/i.test(e.variable))
                  secrets.add(String(value))
              }
              emit({
                ...ctx,
                type: 'validation',
                phase,
                assertion: 'Extrair ' + e.variable,
                passed: pass,
                skipped: false,
                message: pass ? '' : 'Campo obrigatório ausente',
              })
              if (config.singleRun && pass)
                emit({
                  ...ctx,
                  type: 'extraction',
                  phase,
                  variable: e.variable,
                  value:
                    e.secret || /token|secret|password|key/i.test(e.variable)
                      ? '[oculto]'
                      : redact(
                          typeof value === 'object'
                            ? JSON.stringify(value)
                            : value
                        ),
                })
            }
            break
          }
          if (!bad) break
        }
      }
    } catch (error) {
      bad = true
      emit({
        ...ctx,
        type: 'validation',
        phase,
        assertion: 'Executar bloco',
        passed: false,
        skipped: false,
        message: redact(error.message),
      })
    }
    emit({
      ...ctx,
      type: 'stepEnd',
      phase,
      startedAt,
      durationMs: Date.now() - startedAt,
      failed: bad,
      skipped,
    })
    failed = failed || bad
    if (bad && config.bail) {
      markSkipped(nodes.slice(nodes.indexOf(node) + 1), runId, phase)
      break
    }
  }
  return failed
}
function markSkipped(nodes, runId, phase) {
  for (const n of nodes || []) {
    emit({
      type: 'stepSkipped',
      nodeId: n.id,
      name: n.name,
      runId,
      phase,
      reason: 'Caminho não percorrido',
    })
    for (const key of ['children', 'then', 'else'])
      markSkipped(n[key], runId, phase)
  }
}
function defaults() {
  return Object.fromEntries(
    config.scenario.variables.map((v) => [v.key, v.value])
  )
}
export function setup() {
  const vars = defaults()
  if (
    blocks(
      config.scenario.setup,
      vars,
      'setup',
      'setup',
      Date.now() + config.drainTimeout
    )
  )
    throw Error('Preparação global reprovada')
  const epoch = Date.now()
  emit({ type: 'epoch', epoch })
  return { vars, epoch }
}
export function teardown(data) {
  streamLabel = 'teardown'
  if (
    blocks(
      config.scenario.teardown,
      { ...data.vars },
      'teardown',
      'teardown',
      Date.now() + config.drainTimeout
    )
  )
    throw Error('Limpeza global reprovada')
}
export default function (data) {
  const vu = execution.vu.idInTest
  streamLabel = 'vu:' + vu
  const iter = execution.vu.iterationInScenario + 1,
    runId = vu + '-' + iter
  for (const [key, value] of Object.entries(data.vars))
    if (/token|secret|password|credential|key/i.test(key))
      secrets.add(String(value))
  const vars = {
    ...data.vars,
    ...session,
    VU_ID: String(vu),
    VU_ITER: String(iter),
    UNIQUE_ID: vu + '-' + iter + '-' + data.epoch,
    UNIQUE_EMAIL: 'user_' + vu + '_' + iter + '_' + data.epoch + '@example.com',
  }
  const dataset = config.scenario.dataset
  if (dataset) {
    const index =
      dataset.select === 'user' ? vu - 1 : execution.scenario.iterationInTest
    if (index >= dataset.rows.length && dataset.exhaustion === 'error') {
      emit({ type: 'run', runId, message: 'Dados obrigatórios esgotados' })
      throw Error('Dados esgotados')
    }
    Object.assign(vars, dataset.rows[index % dataset.rows.length])
  }
  if (!initialized) {
    initialized = true
    const before = { ...vars }
    if (
      blocks(
        config.scenario.perUser,
        vars,
        runId + '-prepare',
        'perUser',
        Date.now() + config.drainTimeout
      )
    ) {
      emit({ type: 'run', runId, message: 'Preparação do usuário reprovada' })
      throw Error('Preparação reprovada')
    }
    session = {
      ...session,
      ...Object.fromEntries(
        Object.entries(vars).filter(
          ([key, value]) =>
            !['VU_ID', 'VU_ITER', 'UNIQUE_ID', 'UNIQUE_EMAIL'].includes(key) &&
            JSON.stringify(before[key]) !== JSON.stringify(value)
        )
      ),
    }
  }
  const startedAt = Date.now(),
    seconds = (startedAt - data.epoch) / 1000,
    phase = seconds < config.warmupSec ? 'warmup' : 'load'
  const deadline = config.scenarioTimeout
    ? startedAt + config.scenarioTimeout
    : Infinity
  emit({ type: 'runStart', runId, startedAt, phase })
  let failed = false
  try {
    failed = blocks(
      config.scenario.steps,
      { ...vars, VU_ID: String(vu), VU_ITER: String(iter) },
      runId,
      phase,
      deadline
    )
  } catch (error) {
    failed = true
    emit({ type: 'run', runId, phase, message: redact(error.message) })
  }
  completedJourneys.add(1)
  emit({
    type: 'runEnd',
    runId,
    startedAt,
    durationMs: Date.now() - startedAt,
    failed,
    phase,
  })
  if (config.thinkTime && config.loadModel === 'users' && !config.singleRun) {
    emit({ type: 'pauseStart', runId, phase, name: 'Pausa entre jornadas' })
    const pauseStart = Date.now(),
      remaining = Math.max(
        0,
        (config.warmupSec +
          config.stages.reduce((sum, s) => sum + s.durationSec, 0)) *
          1000 -
          (pauseStart - data.epoch)
      )
    sleep(Math.min(config.thinkTime, remaining) / 1000)
    emit({
      type: 'pauseEnd',
      runId,
      phase,
      name: 'Pausa entre jornadas',
      durationMs: Date.now() - pauseStart,
    })
  }
}
