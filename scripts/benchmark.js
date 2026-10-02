const fs = require('node:fs'),
  http = require('node:http'),
  path = require('node:path'),
  os = require('node:os')
const { execFile } = require('node:child_process'),
  { promisify } = require('node:util')
const execute = promisify(execFile),
  { Runner } = require('../lib/runner'),
  { accumulator, observe, finish } = require('../lib/report/metrics')
function metrics(rows, start, end) {
  const a = accumulator()
  for (const row of rows) if (row.ts >= start && row.ts < end) observe(a, row)
  const { hist, ...m } = finish(a)
  return { ...m, rps: m.requests / ((end - start) / 1000) }
}
async function main() {
  const repetitions = Number(process.env.BENCH_REPETITIONS || 5),
    seconds = Number(process.env.BENCH_SECONDS || 10)
  if (repetitions < 1 || seconds < 5)
    throw Error('Use ao menos uma repetição e 5 segundos')
  const output = path.join(__dirname, '../.runs/benchmark-k6')
  fs.mkdirSync(output, { recursive: true, mode: 0o700 })
  let received = []
  const server = http.createServer((req, res) => {
    const start = Date.now()
    setTimeout(() => {
      received.push({
        ts: Date.now(),
        startedAt: start,
        latency: Date.now() - start,
        failed: false,
        transport: false,
      })
      res.end('ok')
    }, 100)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/health`,
    results = {
      generatedAt: new Date().toISOString(),
      engine: require('../lib/k6').version(),
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model,
      },
      workload: { users: 5, seconds, repetitions, delayMs: 100 },
      comparison: [],
      collectionImpact: [],
    }
  const definition = {
    schemaVersion: 4,
    mode: 'builder',
    scenario: { steps: [{ id: 'health', name: 'Health', method: 'GET', url }] },
    stages: [{ durationSec: seconds, target: 5 }],
    evidence: { minResponses: 1, minLoadPercent: 90 },
  }
  async function lab(label, details = true, monitor = false) {
    received = []
    const runner = new Runner(
      definition,
      details ? path.join(output, label + '.xlsx') : undefined
    )
    const timer = monitor
      ? setInterval(() => {
          runner.series()
          runner.snapshot()
        }, 250)
      : null
    let result
    try {
      result = await runner.start()
    } finally {
      clearInterval(timer)
    }
    if (result.requests !== received.length)
      throw Error('Contagens divergem: ' + label)
    const start = received[0]?.startedAt,
      steady = metrics(received, start + 2000, start + (seconds - 1) * 1000)
    return {
      ...steady,
      requestsTotal: result.requests,
      oracleRequests: received.length,
      measuredP95: result.performance.p95,
      integrity:
        result.recordIntegrity && result.reportInfo?.integrity !== false,
      loadPercent: result.stages[0].loadPercent,
    }
  }
  async function direct(index) {
    received = []
    const file = path.join(output, `direct-${index}.js`)
    fs.writeFileSync(
      file,
      `import http from 'k6/http';export const options={vus:5,duration:${JSON.stringify(seconds + 's')},gracefulStop:'23s'};export default function(){http.get(${JSON.stringify(url)});}`,
      { mode: 0o600 }
    )
    const summary = path.join(output, `direct-${index}.summary.json`)
    await execute(
      process.env.K6_BIN || 'k6',
      [
        'run',
        '--quiet',
        '--no-usage-report',
        '--summary-export',
        summary,
        file,
      ],
      { timeout: (seconds + 30) * 1000, maxBuffer: 1024 * 1024 }
    )
    const data = JSON.parse(fs.readFileSync(summary, 'utf8'))
    const count =
      data.metrics?.http_reqs?.count ?? data.metrics?.http_reqs?.values?.count
    if (count !== received.length)
      throw Error('k6 direto divergiu do contador independente')
    const start = received[0]?.startedAt
    return {
      ...metrics(received, start + 2000, start + (seconds - 1) * 1000),
      requestsTotal: count,
      oracleRequests: received.length,
    }
  }
  try {
    for (let i = 1; i <= repetitions; i++) {
      const stress = await lab('stress-' + i),
        k6 = await direct(i),
        throughputPercent = (stress.rps / k6.rps - 1) * 100,
        p95Ms = stress.p95 - k6.p95
      const row = {
        repetition: i,
        stress,
        k6,
        deltas: { throughputPercent, p95Ms },
        withinTolerance: {
          throughput: Math.abs(throughputPercent) <= 5,
          p95: Math.abs(p95Ms) <= Math.max(10, k6.p95 * 0.1),
        },
      }
      results.comparison.push(row)
      console.log(
        `Calibração ${i}/${repetitions}: ${stress.rps.toFixed(1)} req/s · k6 direto ${k6.rps.toFixed(1)} · diferença ${throughputPercent.toFixed(1)}%`
      )
    }
    for (const [label, details, monitor] of [
      ['detailed', true, false],
      ['no-details', false, false],
      ['dashboard', true, true],
    ])
      results.collectionImpact.push({
        label,
        ...(await lab(label, details, monitor)),
      })
    results.passed = results.comparison.every(
      (r) =>
        r.withinTolerance.throughput &&
        r.withinTolerance.p95 &&
        r.stress.integrity
    )
    results.interpretation =
      'Comparação local com carga equivalente. Métricas da janela estável são calculadas pelo servidor independente; p95 HTTP do runtime é registrado separadamente. Não determina capacidade de APIs externas.'
    const file = path.join(output, 'results.json')
    fs.writeFileSync(file, JSON.stringify(results, null, 2), { mode: 0o600 })
    console.log('Resultados: ' + file)
    if (!results.passed) process.exitCode = 1
  } finally {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
