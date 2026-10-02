const os = require('node:os')
const { compileScenario } = require('./scenario')
function integer(value, fallback, min, max, name) {
  const n = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(n) || n < min || n > max)
    throw Object.assign(
      new Error(`${name}: use um inteiro entre ${min} e ${max}`),
      {
        field: {
          Workers: 'maxWorkers',
          Timeout: 'timeout',
          'Timeout de script': 'scriptTimeout',
          'Timeout do cenário': 'scenarioTimeout',
          'Prazo de drenagem': 'drainTimeout',
          Pausa: 'thinkTime',
          'Limite p95': 'p95',
          'Mínimo de respostas': 'minResponses',
        }[name],
      }
    )
  return n
}
function validateLegacy(input) {
  if (input.mode && !['builder', 'postman'].includes(input.mode))
    throw new Error('Modo de teste inválido')
  if (input.mode === 'builder')
    input = {
      ...input,
      collection: compileScenario(
        input.scenario,
        String(input.name || 'Teste pela interface').slice(0, 120)
      ),
      environment: undefined,
    }
  if (!input.collection?.info || !Array.isArray(input.collection.item))
    throw new Error('Collection Postman inválida')
  const hasRequest = (items) =>
    items.some(
      (i) => i.request || (Array.isArray(i.item) && hasRequest(i.item))
    )
  if (!hasRequest(input.collection.item))
    throw new Error('Collection sem requisições')
  if (input.environment && !Array.isArray(input.environment.values))
    throw new Error('Environment inválido')
  const model = input.singleRun === true ? 'users' : input.loadModel || 'users'
  if (!['users', 'arrival'].includes(model))
    throw new Error('Modelo de carga inválido')
  const stages =
    typeof input.stages === 'string'
      ? input.stages.split(',').map((s) => {
          const [durationSec, target] = s.split(':')
          return { durationSec, target }
        })
      : input.stages
  if (
    input.endpointThresholds &&
    (!Array.isArray(input.endpointThresholds) ||
      input.endpointThresholds.length > 50)
  )
    throw new Error('Critérios por endpoint inválidos')
  if (!Array.isArray(stages) || !stages.length || stages.length > 50)
    throw new Error('Informe de 1 a 50 estágios')
  const names = []
  const visit = (items) => {
    for (const item of items) {
      if (item.request) names.push(item.name)
      if (Array.isArray(item.item)) visit(item.item)
    }
  }
  visit(input.collection.item)
  const rulesSeen = new Set()
  for (const rule of input.endpointThresholds || []) {
    if (
      !rule ||
      rulesSeen.has(rule.name) ||
      names.filter((name) => name === rule.name).length !== 1
    )
      throw new Error(
        'Critérios por endpoint exigem nomes únicos e existentes na collection'
      )
    rulesSeen.add(rule.name)
  }
  if (
    input.schemaVersion !== undefined &&
    ![2, 3].includes(input.schemaVersion)
  )
    throw new Error('Versão de configuração não suportada')
  if (
    input.schemaVersion === 2 &&
    (model === 'arrival' ||
      Number(input.warmupSec) > 0 ||
      stages.some((s) => s.ramp) ||
      input.endpointThresholds?.length)
  )
    throw new Error(
      'Atualize explicitamente para metodologia 3.0 para usar novos modelos, aquecimento e critérios por endpoint'
    )
  return {
    schemaVersion: input.schemaVersion === 2 ? 2 : 3,
    collection: input.collection,
    environment: input.environment,
    stages:
      input.singleRun === true
        ? [{ durationSec: 86400, target: 1 }]
        : stages.map((s) => ({
            durationSec: integer(s.durationSec, undefined, 1, 86400, 'Duração'),
            target: integer(
              s.target,
              undefined,
              0,
              500,
              model === 'arrival' ? 'Cenários/s' : 'Usuários'
            ),
            ...(s.ramp
              ? {
                  ramp: true,
                  fromTarget: integer(s.fromTarget, 0, 0, 500, 'Alvo inicial'),
                }
              : {}),
          })),
    maxWorkers:
      input.singleRun === true
        ? 1
        : integer(
            input.maxWorkers,
            Math.min(4, os.cpus().length),
            1,
            32,
            'Workers'
          ),
    timeout: integer(input.timeout, 10000, 1, 600000, 'Timeout'),
    scriptTimeout: integer(
      input.scriptTimeout,
      input.timeout ?? 10000,
      1,
      600000,
      'Timeout de script'
    ),
    scenarioTimeout: integer(
      input.scenarioTimeout,
      0,
      0,
      86400000,
      'Timeout do cenário'
    ),
    drainTimeout: integer(
      input.drainTimeout,
      Math.max(
        Number(input.timeout ?? 10000),
        Number(input.scriptTimeout ?? input.timeout ?? 10000)
      ) *
        2 +
        3000,
      1,
      86400000,
      'Prazo de drenagem'
    ),
    singleRun: input.singleRun === true,
    loadModel: model,
    maxConcurrent: integer(
      input.maxConcurrent,
      500,
      1,
      500,
      'Cenários simultâneos'
    ),
    generatorLagLimitMs: integer(
      input.generatorLagLimitMs,
      100,
      1,
      60000,
      'Atraso máximo do gerador'
    ),
    warmupSec:
      input.singleRun === true
        ? 0
        : integer(input.warmupSec, 0, 0, 3600, 'Aquecimento'),
    evidence: {
      minResponses:
        input.singleRun === true
          ? 1
          : integer(
              input.evidence?.minResponses,
              100,
              1,
              100000000,
              'Mínimo de respostas'
            ),
      minLoadPercent:
        input.singleRun === true
          ? 0
          : (() => {
              const n = Number(input.evidence?.minLoadPercent ?? 90)
              if (!Number.isFinite(n) || n < 0 || n > 100)
                throw Object.assign(
                  new Error('Cumprimento mínimo de carga: use 0 a 100%'),
                  { field: 'minLoadPercent' }
                )
              return n
            })(),
    },
    thinkTime:
      input.singleRun || model === 'arrival'
        ? 0
        : integer(input.thinkTime, 0, 0, 60000, 'Pausa'),
    keepAlive: input.keepAlive !== false && input.keepAlive !== 'false',
    insecure: input.insecure === true || input.insecure === 'true',
    bail: input.bail === true || input.bail === 'true',
    endpointThresholds: (input.endpointThresholds || []).map((rule) => {
      if (!rule || typeof rule.name !== 'string' || !rule.name.trim())
        throw new Error('Critério por endpoint exige nome')
      return {
        name: rule.name,
        p95: integer(rule.p95, 1000, 1, 600000, 'Limite p95'),
        minResponses: integer(
          rule.minResponses,
          100,
          1,
          100000000,
          'Mínimo de respostas'
        ),
      }
    }),
    thresholds: {
      p95: integer(input.thresholds?.p95, 1000, 1, 600000, 'Limite p95'),
      errorRate: (() => {
        const n = Number(input.thresholds?.errorRate ?? 1)
        if (!Number.isFinite(n) || n < 0 || n > 100)
          throw Object.assign(new Error('Taxa de erro inválida'), {
            field: 'errorRate',
          })
        return n
      })(),
    },
  }
}
function legacyInput(input) {
  if (input.schemaVersion) return input
  return {
    ...input,
    schemaVersion: 2,
    scriptTimeout: input.timeout ?? 10000,
    scenarioTimeout: (input.timeout ?? 10000) * 2,
    evidence: { minResponses: 1, minLoadPercent: 0 },
  }
}
function validate(input) {
  if (input.schemaVersion !== 4) return validateLegacy(input)
  const { validateFlow, walk } = require('./flow')
  const scenario = validateFlow(input.scenario)
  const requests = []
  walk(
    [
      ...scenario.setup,
      ...scenario.perUser,
      ...scenario.steps,
      ...scenario.teardown,
    ],
    (n) => {
      if (n.type === 'request') requests.push(n)
    }
  )
  const journeyIDs = new Set()
  walk(scenario.steps, (n) => {
    if (n.type === 'request') journeyIDs.add(n.id)
  })
  const rules = (input.endpointThresholds || []).map((rule) => {
    const matches = requests.filter((n) =>
      rule.nodeId ? n.id === rule.nodeId : n.name === rule.name
    )
    if (matches.length !== 1)
      throw Object.assign(
        new Error('Critério por passo exige ID existente ou nome único'),
        { field: 'endpointThresholds' }
      )
    if (!journeyIDs.has(matches[0].id))
      throw Object.assign(
        new Error(
          'Critérios de performance por passo se aplicam à jornada, não à preparação ou limpeza'
        ),
        { field: 'endpointThresholds' }
      )
    return { ...rule, nodeId: matches[0].id, name: matches[0].name }
  })
  const item = requests.map((n) => ({
    id: n.id,
    name: n.id,
    request: { method: n.method, url: n.url },
  }))
  const config = validateLegacy({
    ...input,
    schemaVersion: 3,
    mode: 'postman',
    collection: { info: { name: input.name || 'Fluxo k6' }, item },
    environment: undefined,
    endpointThresholds: rules.map((r) => ({ ...r, name: r.nodeId })),
  })
  const endpointThresholds = config.endpointThresholds.map((r, i) => ({
    ...r,
    name: rules[i].name,
    nodeId: rules[i].nodeId,
  }))
  const journeyThresholds = input.journeyThresholds
    ? {
        p95: integer(
          input.journeyThresholds.p95,
          1000,
          1,
          86400000,
          'Limite p95'
        ),
        minResponses: integer(
          input.journeyThresholds.minResponses,
          config.evidence.minResponses,
          1,
          100000000,
          'Mínimo de respostas'
        ),
      }
    : null
  delete config.maxWorkers
  delete config.scriptTimeout
  return {
    ...config,
    schemaVersion: 4,
    methodologyVersion: '4.0',
    engine: 'k6',
    mode: 'builder',
    scenario,
    bail: input.bail !== false,
    endpointThresholds,
    journeyThresholds,
  }
}
module.exports = { validate, validateLegacy, legacyInput }
