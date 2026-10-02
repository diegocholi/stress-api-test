const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = require('node:net').createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}
function version() {
  let text
  try {
    text = execFileSync(process.env.K6_BIN || 'k6', ['version'], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim()
  } catch {
    throw new Error(
      'k6 indisponível. Instale o k6 oficial ou configure K6_BIN com o caminho do binário.'
    )
  }
  if (!/^k6 v2\./.test(text))
    throw new Error(
      'Versão k6 incompatível. Use k6 2.x; CI validada com 2.0.0.'
    )
  return text
}
function options(config) {
  const stages = []
  let previous = config.stages[0].ramp
    ? config.stages[0].fromTarget
    : config.stages[0].target
  if (config.warmupSec)
    stages.push({ duration: config.warmupSec + 's', target: previous })
  for (const stage of config.stages) {
    const start = stage.ramp ? stage.fromTarget : stage.target
    if (previous !== start) stages.push({ duration: '1ms', target: start })
    stages.push({
      duration: stage.durationSec * 1000 - (previous !== start ? 1 : 0) + 'ms',
      target: stage.target,
    })
    previous = stage.target
  }
  const main = config.singleRun
    ? {
        executor: 'per-vu-iterations',
        vus: 1,
        iterations: 1,
        maxDuration:
          (config.scenarioTimeout
            ? Math.max(
                60,
                (config.scenarioTimeout + config.drainTimeout) / 1000
              )
            : 86400) + 's',
      }
    : config.loadModel === 'arrival'
      ? {
          executor: 'ramping-arrival-rate',
          startRate: config.stages[0].ramp
            ? config.stages[0].fromTarget
            : config.stages[0].target,
          timeUnit: '1s',
          preAllocatedVUs: Math.min(
            config.maxConcurrent,
            Math.max(
              1,
              ...config.stages.map((s) => Math.max(s.target, s.fromTarget || 0))
            )
          ),
          maxVUs: config.maxConcurrent,
          stages,
        }
      : {
          executor: 'ramping-vus',
          startVUs: config.stages[0].ramp
            ? config.stages[0].fromTarget
            : config.stages[0].target,
          stages,
          gracefulRampDown: config.drainTimeout + 'ms',
        }
  return {
    scenarios: { main: { ...main, gracefulStop: config.drainTimeout + 'ms' } },
    setupTimeout: config.drainTimeout + 'ms',
    teardownTimeout: config.drainTimeout + 'ms',
    insecureSkipTLSVerify: config.insecure,
    noConnectionReuse: !config.keepAlive,
    noVUConnectionReuse: false,
    noCookiesReset: config.scenario.perUser.length > 0,
    systemTags: [
      'status',
      'method',
      'name',
      'scenario',
      'expected_response',
      'error_code',
    ],
    summaryTrendStats: ['avg', 'min', 'max', 'p(50)', 'p(95)', 'p(99)'],
  }
}
function prepare(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-k6-'))
  fs.chmodSync(root, 0o700)
  for (const [name, value] of [
    ['config.json', config],
    ['options.json', options(config)],
  ])
    fs.writeFileSync(path.join(root, name), JSON.stringify(value), {
      mode: 0o600,
    })
  fs.copyFileSync(
    path.join(__dirname, 'k6-runtime.js'),
    path.join(root, 'main.js')
  )
  fs.chmodSync(path.join(root, 'main.js'), 0o600)
  return root
}
async function start(config, onEvent, onMetric) {
  const port = await reservePort()
  const root = prepare(config),
    metricFile = path.join(root, 'metrics.json')
  const child = spawn(
    process.env.K6_BIN || 'k6',
    [
      'run',
      '--address',
      '127.0.0.1:' + port,
      '--quiet',
      '--no-color',
      '--no-usage-report',
      '--include-system-env-vars=false',
      '--log-format=json',
      '--log-output=stdout',
      '--summary-export',
      path.join(root, 'summary.json'),
      '--out',
      'json=' + metricFile,
      'main.js',
    ],
    {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  const decoder = new (require('node:string_decoder').StringDecoder)('utf8')
  let stdout = '',
    stderr = '',
    offset = 0,
    pending = '',
    parsing = false,
    parseFailure
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    let i
    while ((i = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, i)
      stdout = stdout.slice(i + 1)
      try {
        const log = JSON.parse(line)
        if (log.msg) {
          const event = JSON.parse(log.msg)
          if (event.channel === 'stress-event') onEvent(event)
        }
      } catch {
        if (line.includes('stress-event')) parseFailure = 'Evento k6 inválido'
      }
    }
    if (stdout.length > 8 * 1024 * 1024) {
      parseFailure = 'Buffer de eventos k6 excedido'
      child.kill('SIGTERM')
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000)
  })
  function read() {
    if (parsing) return
    parsing = true
    try {
      if (!fs.existsSync(metricFile)) return
      const size = fs.statSync(metricFile).size
      if (size > offset) {
        const fd = fs.openSync(metricFile, 'r')
        try {
          while (offset < size) {
            const buffer = Buffer.alloc(Math.min(65536, size - offset))
            const n = fs.readSync(fd, buffer, 0, buffer.length, offset)
            offset += n
            pending += decoder.write(buffer.subarray(0, n))
            let i
            while ((i = pending.indexOf('\n')) >= 0) {
              const line = pending.slice(0, i)
              pending = pending.slice(i + 1)
              if (line.trim())
                try {
                  const m = JSON.parse(line)
                  if (m.type === 'Point') onMetric(m)
                } catch {
                  parseFailure = 'Métrica k6 truncada ou inválida'
                }
            }
          }
        } finally {
          fs.closeSync(fd)
        }
      }
    } finally {
      parsing = false
    }
  }
  const timer = setInterval(read, 100)
  const finished = new Promise((resolve) => {
    child.once('error', (error) =>
      resolve({ error: error.message, code: null })
    )
    child.once('close', (code, signal) => {
      clearInterval(timer)
      read()
      if (pending.trim()) parseFailure = 'Métrica k6 truncada'
      let summary
      try {
        summary = JSON.parse(
          fs.readFileSync(path.join(root, 'summary.json'), 'utf8')
        )
      } catch {}
      resolve({
        code,
        signal,
        summary,
        error:
          parseFailure ||
          (code !== 0 ? stderr || 'k6 encerrou com código ' + code : undefined),
      })
    })
  })
  return {
    child,
    finished,
    root,
    statusURL: 'http://127.0.0.1:' + port + '/v1/status',
    cleanup() {
      clearInterval(timer)
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}
module.exports = { version, options, prepare, start }
