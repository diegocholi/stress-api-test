const { test } = require('node:test')
const assert = require('node:assert/strict')
const { evaluate, stageEvidence } = require('../lib/evaluation')
const { Timeline, checkIntegrity } = require('../lib/measurement')
const { accumulator, observe, finish } = require('../lib/report/metrics')
const { validate, legacyInput } = require('../lib/config')
const { compare } = require('../lib/comparison')
const config = {
  stages: [{ durationSec: 10, target: 2 }],
  thresholds: { p95: 100, errorRate: 1 },
  evidence: { minResponses: 100, minLoadPercent: 90 },
}
const good = {
  status: 'completed',
  requests: 100,
  samples: 100,
  p95: 20,
  errorRate: 0,
  assertionFailures: 0,
  scriptFailures: 0,
  runFailures: 0,
}
const stages = [{ stage: 1, target: 2, loadPercent: 100 }]
test('approval requires final complete evidence; cancellation never approves', () => {
  assert.equal(evaluate(good, config, { stages }).verdict, 'approved')
  for (const status of ['cancelled', 'failed'])
    assert.equal(
      evaluate({ ...good, status }, config, { stages }).verdict,
      'partial'
    )
  assert.equal(
    evaluate({ ...good, status: 'running' }, config, { stages }).verdict,
    'pending'
  )
  assert.equal(
    evaluate(good, config, { stages, integrity: false }).verdict,
    'partial'
  )
  assert.equal(
    evaluate({ ...good, samples: 99 }, config, { stages }).verdict,
    'inconclusive'
  )
  assert.equal(
    evaluate(good, config, { stages: [{ ...stages[0], loadPercent: 89 }] })
      .verdict,
    'inconclusive'
  )
  assert.equal(
    evaluate(good, config).verdict,
    'inconclusive',
    'missing stage evidence cannot approve'
  )
  const failed = evaluate({ ...good, assertionFailures: 1 }, config, { stages })
  assert.equal(failed.verdict, 'rejected')
  const insufficient = evaluate({ ...good, p95: 200, samples: 1 }, config, {
    stages,
  })
  assert.equal(insufficient.verdict, 'inconclusive')
  assert.ok(insufficient.criteria.some((c) => c.id === 'p95' && !c.passed))
})
test('load evidence integrates actual lifetimes and caps surplus per instant', () => {
  const spans = new Map([
    [1, { startedAt: 1000, endedAt: 6000 }],
    [2, { startedAt: 1000, endedAt: 6000 }],
    [3, { startedAt: 1000, endedAt: 6000 }],
  ])
  const evidence = stageEvidence(
    config,
    [{ startedAt: 1000, endedAt: 11000 }],
    spans,
    11000
  )
  assert.equal(evidence[0].plannedUserSeconds, 20)
  assert.equal(evidence[0].observedUserSeconds, 10)
  assert.equal(evidence[0].loadPercent, 50)
  assert.equal(stageEvidence(config, [], spans, 11000)[0].loadPercent, 0)
})
test('window boundaries and idle windows preserve traffic without artificial RPS spikes', () => {
  const timeline = new Timeline(1000)
  timeline.observe({
    type: 'request',
    ts: 1000,
    latency: 10,
    failed: false,
    transport: false,
  })
  timeline.observe({
    type: 'request',
    ts: 5000,
    latency: null,
    failed: true,
    transport: true,
  })
  const points = timeline.points(4)
  assert.equal(points.length, 4)
  assert.equal(
    points.reduce((n, p) => n + p.requests, 0),
    2
  )
  assert.equal(points[1].rps, 0)
  assert.equal(points[1].p95, null)
  assert.equal(points[1].active, null)
  assert.equal(points[3].rps, 1)
  assert.equal(points[3].duration, 1)
  const long = new Timeline(0)
  long.observe({ type: 'request', ts: 7200000, latency: 15, failed: false })
  const aggregated = long.points(7200)
  assert.equal(aggregated.length, 3600)
  assert.equal(aggregated.at(-1).rps, 0.5)
})
test('known percentiles and integrity cover validations, runs and scripts', () => {
  const metrics = accumulator()
  ;[1, 2, 3, 4, 100].forEach((latency) =>
    observe(metrics, { latency, failed: false, transport: false })
  )
  observe(metrics, { latency: null, failed: true, transport: true })
  const result = finish(metrics)
  assert.equal(result.p50, 3)
  assert.equal(result.p95, 100)
  assert.equal(result.samples, 5)
  assert.equal(result.errorRate, 1 / 6)
  assert.equal(finish(accumulator()).p95, null)
  const checked = checkIntegrity(
    { requests: 2, assertions: 3, scriptFailures: 1, runs: 2 },
    { requests: 2, validations: 2, scriptFailures: 1, runs: 2 }
  )
  assert.equal(checked.complete, false)
  assert.equal(
    checked.checks.find((c) => c.counter === 'assertions').matches,
    false
  )
})
test('new definitions and old definitions keep distinct timeout and evidence defaults', () => {
  const input = {
    collection: {
      info: { name: 'A' },
      item: [{ request: { method: 'GET', url: 'http://localhost' } }],
    },
    stages: '1:1',
    timeout: 300,
  }
  const fresh = validate(input),
    old = validate(legacyInput(input))
  assert.equal(fresh.scenarioTimeout, 0)
  assert.equal(fresh.scriptTimeout, 300)
  assert.equal(fresh.evidence.minResponses, 100)
  assert.equal(old.scenarioTimeout, 600)
  assert.equal(old.evidence.minResponses, 1)
  assert.equal(old.evidence.minLoadPercent, 0)
})
test('comparisons flag configuration differences without exporting credentials', () => {
  const left = {
      id: 'a',
      name: 'A',
      result: { requests: 100, p95: 10, errorRate: 0 },
    },
    right = {
      id: 'b',
      name: 'B',
      result: { requests: 120, p95: 20, errorRate: 0 },
    }
  const a = {
      stages: [{ durationSec: 1, target: 1 }],
      scenario: {
        steps: [{ headers: [{ key: 'Authorization', value: 'secret-A' }] }],
      },
    },
    b = {
      ...a,
      scenario: {
        steps: [{ headers: [{ key: 'Authorization', value: 'secret-B' }] }],
      },
    }
  const result = compare(left, right, a, b)
  assert.ok(result.differences.some((d) => d.field === 'cenário'))
  assert.equal(JSON.stringify(result).includes('secret-'), false)
  assert.equal(result.metrics.find((m) => m.field === 'p95').percent, 100)
  assert.equal(
    result.metrics.find((m) => m.field === 'errorRate').percent,
    null
  )
})
