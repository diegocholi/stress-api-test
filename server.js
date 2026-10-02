const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { Runner } = require('./lib/runner')
const { migrate, requireMigration } = require('./lib/migration')
const { validate, legacyInput } = require('./lib/config')
const { Timeline } = require('./lib/measurement')
const { compare } = require('./lib/comparison')
const { writeJson } = require('./lib/storage')
const { archiveEvents, cleanupArchives } = require('./lib/retention')
const { generateReport } = require('./lib/report/run')
const { TemplateStore, definition } = require('./lib/templates')
const exportsInProgress = new Map()
const ROOT = process.env.STRESS_DATA_DIR || path.join(__dirname, '.runs')
fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
const templates = new TemplateStore(ROOT)
const INPUTS = path.join(ROOT, 'inputs')
fs.mkdirSync(INPUTS, { recursive: true, mode: 0o700 })
const jobs = new Map()
let current
const save = (job) => {
  const filename = path.join(ROOT, `${job.id}.json`),
    temporary = `${filename}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(job), { mode: 0o600 })
  fs.renameSync(temporary, filename)
}
for (const name of fs
  .readdirSync(ROOT)
  .filter((n) => /^[a-f0-9-]+\.json$/.test(n))) {
  try {
    const job = JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'))
    if (['running', 'stopping'].includes(job.status)) {
      job.status = 'failed'
      job.result = {
        ...job.result,
        status: 'failed',
        recordIntegrity: false,
        passed: false,
        reportStatus: 'error',
        reportError:
          'Execução interrompida; o registro disponível pode ser exportado como parcial.',
        failure: 'Servidor reiniciado durante o teste',
        ...(job.result?.evaluation
          ? {
              evaluation: {
                ...job.result.evaluation,
                verdict: 'partial',
                provisional: false,
                reasons: ['Servidor reiniciado durante o teste'],
              },
            }
          : {}),
      }
      delete job.config
      save(job)
    }
    if (job.config) {
      const migration = migrate(legacyInput(job.config))
      if (migration.compatible) job.config = validate(migration.definition)
      else {
        job.status = 'migration-required'
        job.migration = { compatible: false, issues: migration.issues }
        save(job)
      }
    }
    if (job.result?.reportStatus === 'generating') {
      job.result.reportStatus = fs.existsSync(path.join(ROOT, `${job.id}.xlsx`))
        ? 'ready'
        : 'error'
      if (job.result.reportStatus === 'error')
        job.result.reportError =
          'Servidor reiniciado durante a geração; regenere o XLSX a partir dos registros.'
      delete job.config
      save(job)
    }
    job.canRepeat = fs.existsSync(path.join(INPUTS, `${job.id}.json`))
    jobs.set(job.id, job)
  } catch (err) {
    console.error(`Histórico inválido: ${name}: ${err.message}`)
  }
}
const view = (job) => ({
  id: job.id,
  name: job.name,
  status: job.status,
  scheduledAt: job.scheduledAt,
  createdAt: job.createdAt,
  result: job.result,
  canRepeat: job.canRepeat === true,
  repeatedFrom: job.repeatedFrom,
  migration: job.migration,
})
const outcome = (job) =>
  job.result?.evaluation?.verdict ||
  (job.status === 'completed'
    ? job.result?.passed
      ? 'approved'
      : 'rejected'
    : ['failed', 'cancelled'].includes(job.status)
      ? 'partial'
      : 'pending')
const reportPath = (id) => path.join(ROOT, `${id}.xlsx`)
function readJson(filename) {
  return fs.existsSync(filename)
    ? JSON.parse(fs.readFileSync(filename, 'utf8'))
    : undefined
}
async function series(job) {
  if (current?.job.id === job.id && current.runner)
    return current.runner.series()
  const stored = readJson(`${reportPath(job.id)}.timeline.json`)
  if (stored) return stored
  const metadata = readJson(`${reportPath(job.id)}.meta.json`),
    rawEvents = `${reportPath(job.id)}.events.ndjson`,
    events = fs.existsSync(rawEvents) ? rawEvents : `${rawEvents}.gz`
  if (!metadata || !fs.existsSync(events))
    return {
      schemaVersion: 2,
      available: false,
      points: [],
      reason: 'Evolução não registrada nesta versão.',
    }
  const timeline = new Timeline(
    metadata.startedAt,
    metadata.timelineInterval || 1
  )
  const lines = require('node:readline').createInterface({
    input: events.endsWith('.gz')
      ? fs.createReadStream(events).pipe(require('node:zlib').createGunzip())
      : fs.createReadStream(events),
    crlfDelay: Infinity,
  })
  for await (const line of lines) {
    try {
      if (line.trim()) timeline.observe(JSON.parse(line))
    } catch {
      /* A process crash may leave one incomplete trailing event. */
    }
  }
  return {
    schemaVersion: metadata.schemaVersion || 2,
    methodologyVersion: metadata.methodologyVersion,
    phases: {
      warmupSec: metadata.config?.warmupSec || 0,
      loadStartedAt: metadata.loadStartedAt,
      loadEndedAt: metadata.loadEndedAt,
      stages: metadata.stageHistory,
    },
    points: timeline.points(job.result?.elapsed || metadata.result.elapsed),
  }
}
async function regenerate(job) {
  if (['scheduled', 'running', 'stopping'].includes(job.status))
    throw Object.assign(new Error('Aguarde o encerramento do teste.'), {
      statusCode: 409,
    })
  if (current && ['running', 'stopping'].includes(current.job.status))
    throw Object.assign(
      new Error('Aguarde a execução ativa para não interferir na medição.'),
      { statusCode: 409 }
    )
  if (exportsInProgress.has(job.id)) return exportsInProgress.get(job.id)
  const output = reportPath(job.id),
    rawEvents = `${output}.events.ndjson`,
    events = fs.existsSync(rawEvents) ? rawEvents : `${rawEvents}.gz`,
    metadata = readJson(`${output}.meta.json`)
  if (!metadata || !fs.existsSync(events))
    throw Object.assign(
      new Error(
        'Registro original indisponível para regenerar este relatório.'
      ),
      { statusCode: 409 }
    )
  job.result = {
    ...job.result,
    reportStatus: 'generating',
    reportError: undefined,
  }
  save(job)
  const promise = generateReport({
    output,
    events,
    metadata: { ...metadata, result: { ...metadata.result, ...job.result } },
  })
    .then(async (info) => {
      job.result = {
        ...job.result,
        ...info.metrics,
        reportStatus: 'ready',
        reportInfo: info,
        evaluation: info.evaluation || job.result.evaluation,
        passed: info.evaluation
          ? info.evaluation.verdict === 'approved'
          : job.result.passed,
      }
      if (info.integrity && !events.endsWith('.gz')) {
        if (metadata.schemaVersion >= 3) await archiveEvents(events)
        else fs.unlinkSync(events)
      }
      save(job)
      return view(job)
    })
    .catch((err) => {
      job.result = {
        ...job.result,
        reportStatus: 'error',
        reportError: err.message,
      }
      save(job)
      throw err
    })
    .finally(() => exportsInProgress.delete(job.id))
  exportsInProgress.set(job.id, promise)
  return promise
}
async function execute(job) {
  const execution = { job }
  current = execution
  try {
    job.status = 'running'
    save(job)
    const runner = new Runner(
      {
        ...job.config,
        name: job.name,
        source: job.source,
        reportContext: {
          id: job.id,
          createdAt: job.createdAt,
          scheduledAt: job.scheduledAt,
          repeatedFrom: job.repeatedFrom,
        },
      },
      path.join(ROOT, `${job.id}.xlsx`)
    )
    execution.runner = runner
    runner.on('snapshot', (result) => {
      job.result = result
      job.status = result.status
      if (['completed', 'failed', 'cancelled'].includes(result.status))
        delete job.config
      try {
        save(job)
        if (result.status === 'running' || result.status === 'stopping')
          writeJson(`${reportPath(job.id)}.meta.json`, runner.metadata())
      } catch (err) {
        runner.failure = `Persistência da execução: ${err.message}`
        runner.stop(true)
      }
    })
    job.result = await runner.start()
    job.status = job.result.status
  } catch (err) {
    job.status = 'failed'
    job.result = {
      ...job.result,
      status: 'failed',
      passed: false,
      failure: err.message,
    }
  } finally {
    delete job.config
    try {
      save(job)
    } catch (err) {
      console.error(`Falha ao salvar a execução ${job.id}: ${err.message}`)
    } finally {
      if (current === execution) current = null
    }
  }
}
function launch(input, repeatedFrom) {
  input = requireMigration(input)
  const config = validate(input)
  if (
    input.scheduledAt &&
    (!Number.isFinite(Date.parse(input.scheduledAt)) ||
      Date.parse(input.scheduledAt) <= Date.now())
  )
    throw new Error('Agende uma data futura')
  if (!input.scheduledAt && (current || exportsInProgress.size))
    throw Object.assign(
      new Error(
        'Já existe um teste ativo ou relatório em geração. Aguarde ou agende outro.'
      ),
      { statusCode: 409 }
    )
  const job = {
    id: randomUUID(),
    name: String(input.name || config.collection.info.name || 'Teste').slice(
      0,
      120
    ),
    config,
    source: input.mode === 'builder' ? 'Interface' : 'Postman',
    createdAt: new Date().toISOString(),
    scheduledAt: input.scheduledAt || new Date().toISOString(),
    status: 'scheduled',
    canRepeat: true,
    ...(repeatedFrom ? { repeatedFrom } : {}),
  }
  const filename = path.join(INPUTS, `${job.id}.json`),
    temporary = `${filename}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(definition(input)), {
    mode: 0o600,
  })
  fs.renameSync(temporary, filename)
  save(job)
  jobs.set(job.id, job)
  if (!input.scheduledAt) void execute(job)
  return job
}
let lastCleanup = 0
const scheduler = setInterval(() => {
  if (current || exportsInProgress.size) return
  if (Date.now() - lastCleanup > 60000) {
    try {
      cleanupArchives(ROOT)
    } catch (error) {
      console.error('Limpeza de auditoria:', error.message)
    }
    lastCleanup = Date.now()
  }
  const next = [...jobs.values()]
    .filter(
      (j) => j.status === 'scheduled' && Date.parse(j.scheduledAt) <= Date.now()
    )
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))[0]
  if (next) void execute(next)
}, 1000)
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}
async function body(req) {
  let bytes = 0,
    chunks = []
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 5 * 1024 * 1024) throw new Error('Limite de upload: 5 MB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString())
}
const server = http.createServer(async (req, res) => {
  try {
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || ''))
      return json(res, 403, { error: 'Host inválido' })
    // Local control surface: reject cross-origin mutation attempts.
    if (
      req.method === 'POST' &&
      ((req.headers.origin &&
        req.headers.origin !== `http://${req.headers.host}`) ||
        req.headers['content-type']?.split(';')[0] !== 'application/json')
    )
      return json(res, 403, { error: 'Origem ou tipo de conteúdo inválido' })
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/engine' && req.method === 'GET') {
      try {
        return json(res, 200, {
          engine: 'k6',
          available: true,
          version: require('./lib/k6').version(),
        })
      } catch (error) {
        return json(res, 200, {
          engine: 'k6',
          available: false,
          message: error.message,
        })
      }
    }
    if (url.pathname === '/api/migrate' && req.method === 'POST')
      return json(res, 200, migrate(await body(req)))
    if (url.pathname === '/api/validate' && req.method === 'POST') {
      const config = validate(requireMigration(await body(req)))
      return json(res, 200, {
        valid: true,
        schemaVersion: config.schemaVersion,
        steps: require('./lib/templates').countRequests(config.collection.item),
        durationSec: config.stages.reduce((n, s) => n + s.durationSec, 0),
        evidence: config.evidence,
      })
    }
    if (url.pathname === '/api/runs/check' && req.method === 'POST') {
      const input = await body(req)
      return json(
        res,
        201,
        view(
          launch({
            ...input,
            singleRun: true,
            scheduledAt: undefined,
            stages: [{ durationSec: 86400, target: 1 }],
            maxWorkers: 1,
            evidence: { minResponses: 1, minLoadPercent: 0 },
          })
        )
      )
    }
    if (url.pathname === '/api/runs/compare/xlsx' && req.method === 'GET') {
      const left = jobs.get(url.searchParams.get('left')),
        right = jobs.get(url.searchParams.get('right'))
      if (!left || !right)
        return json(res, 404, {
          error: 'Selecione duas execuções registradas.',
        })
      if (current || exportsInProgress.size)
        return json(res, 409, {
          error:
            'Aguarde a execução e os relatórios pendentes para exportar a comparação.',
        })
      const comparison = compare(
          left,
          right,
          readJson(path.join(INPUTS, left.id + '.json')),
          readJson(path.join(INPUTS, right.id + '.json'))
        ),
        key = 'comparison-' + left.id + '-' + right.id
      const task = require('./lib/report/comparison').comparisonWorkbook(
        comparison
      )
      exportsInProgress.set(key, task)
      try {
        const buffer = await task
        res.writeHead(200, {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition':
            'attachment; filename="stress-lab-comparacao.xlsx"',
        })
        res.end(buffer)
        return
      } finally {
        exportsInProgress.delete(key)
      }
    }
    if (url.pathname === '/api/runs/compare' && req.method === 'GET') {
      const left = jobs.get(url.searchParams.get('left')),
        right = jobs.get(url.searchParams.get('right'))
      if (!left || !right)
        return json(res, 404, {
          error: 'Selecione duas execuções registradas.',
        })
      return json(
        res,
        200,
        compare(
          left,
          right,
          readJson(path.join(INPUTS, `${left.id}.json`)),
          readJson(path.join(INPUTS, `${right.id}.json`))
        )
      )
    }
    if (url.pathname === '/api/templates' && req.method === 'GET')
      return json(res, 200, templates.list())
    if (url.pathname === '/api/templates' && req.method === 'POST')
      return json(res, 201, templates.create(await body(req)))
    const templateRoute = url.pathname.match(
      /^\/api\/templates\/([a-f0-9-]+)(?:\/(duplicate|delete))?$/
    )
    if (templateRoute) {
      const [, id, action] = templateRoute
      if (!action && req.method === 'GET')
        return json(res, 200, templates.get(id))
      if (!action && req.method === 'POST')
        return json(res, 200, templates.update(id, await body(req)))
      if (action === 'duplicate' && req.method === 'POST')
        return json(res, 201, templates.duplicate(id))
      if (action === 'delete' && req.method === 'POST') {
        templates.delete(id)
        return json(res, 200, { deleted: true })
      }
    }
    if (url.pathname === '/api/runs' && req.method === 'GET') {
      const all = [...jobs.values()].reverse()
      if (!url.searchParams.has('page')) return json(res, 200, all.map(view))
      const page = Number(url.searchParams.get('page')),
        pageSize = Number(url.searchParams.get('pageSize') || 20)
      if (
        !Number.isInteger(page) ||
        page < 1 ||
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 100
      )
        return json(res, 400, { error: 'Paginação inválida.' })
      const search = (url.searchParams.get('q') || '').toLocaleLowerCase(
          'pt-BR'
        ),
        status = url.searchParams.get('status')
      const filtered = all.filter(
        (j) =>
          j.name.toLocaleLowerCase('pt-BR').includes(search) &&
          (!status || j.status === status || outcome(j) === status)
      )
      return json(res, 200, {
        schemaVersion: 2,
        page,
        pageSize,
        total: filtered.length,
        overview: {
          busy: Boolean(current || exportsInProgress.size),
          total: all.length,
          completed: all.filter((j) => j.status === 'completed').length,
          scheduled: all.filter((j) => j.status === 'scheduled').length,
        },
        items: filtered
          .slice((page - 1) * pageSize, page * pageSize)
          .map((job) => {
            const item = view(job)
            if (item.result)
              item.result = {
                passed: item.result.passed,
                purpose: item.result.purpose,
                evaluation: item.result.evaluation
                  ? { verdict: item.result.evaluation.verdict }
                  : undefined,
              }
            return item
          }),
      })
    }
    if (url.pathname === '/api/runs' && req.method === 'POST') {
      return json(res, 201, view(launch(await body(req))))
    }
    const detail = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)$/)
    if (detail && req.method === 'GET') {
      const job = jobs.get(detail[1])
      return job
        ? json(res, 200, view(job))
        : json(res, 404, { error: 'Teste não encontrado' })
    }
    const match = url.pathname.match(
      /^\/api\/runs\/([a-f0-9-]+)\/(cancel|xlsx|repeat|series|regenerate|events)$/
    )
    if (match) {
      const job = jobs.get(match[1])
      if (!job) return json(res, 404, { error: 'Teste não encontrado' })
      if (match[2] === 'events' && req.method === 'GET') {
        const page = Number(url.searchParams.get('page') || 1),
          pageSize = Number(url.searchParams.get('pageSize') || 50)
        if (
          !Number.isInteger(page) ||
          page < 1 ||
          !Number.isInteger(pageSize) ||
          pageSize < 1 ||
          pageSize > 100
        )
          return json(res, 400, { error: 'Paginação inválida' })
        const raw = reportPath(job.id) + '.events.ndjson',
          filename = fs.existsSync(raw) ? raw : raw + '.gz'
        if (!fs.existsSync(filename))
          return json(res, 200, { available: false, items: [], total: 0 })
        const items = []
        let total = 0
        const type = url.searchParams.get('type'),
          nodeId = url.searchParams.get('nodeId'),
          stage = url.searchParams.get('stage'),
          phase = url.searchParams.get('phase'),
          category = url.searchParams.get('category')
        for await (const event of require('./lib/report/workbook').events(
          filename
        )) {
          if (
            category === 'failures' &&
            !event.failed &&
            event.passed !== false &&
            !['run', 'runInterrupted', 'recordError'].includes(event.type)
          )
            continue
          if (phase && event.phase !== phase) continue
          if (
            (type && event.type !== type) ||
            (nodeId && event.nodeId !== nodeId) ||
            (stage && event.stage !== Number(stage))
          )
            continue
          if (total >= (page - 1) * pageSize && items.length < pageSize)
            items.push(event)
          total++
        }
        return json(res, 200, { available: true, page, pageSize, total, items })
      }
      if (match[2] === 'series' && req.method === 'GET') {
        const data = await series(job),
          from = url.searchParams.get('from')
        if (from !== null && !Number.isFinite(Number(from)))
          return json(res, 400, { error: 'Cursor temporal inválido' })
        const interval = data.points?.[0]?.duration || 1,
          reset =
            Number(url.searchParams.get('interval') || interval) !== interval
        return json(res, 200, {
          ...data,
          interval,
          reset,
          points:
            from !== null && !reset
              ? data.points.filter((p) => p.ts >= Number(from))
              : data.points,
        })
      }
      if (match[2] === 'regenerate' && req.method === 'POST')
        return json(res, 200, await regenerate(job))
      if (match[2] === 'repeat' && req.method === 'POST') {
        if (!['completed', 'cancelled', 'failed'].includes(job.status))
          return json(res, 409, {
            error: 'Aguarde o teste terminar antes de repetir.',
          })
        const filename = path.join(INPUTS, `${job.id}.json`)
        if (!fs.existsSync(filename))
          return json(res, 409, {
            error:
              'Esta execução antiga não registrou a configuração. Escolha um teste salvo para repetir.',
          })
        const input = requireMigration(
          legacyInput(JSON.parse(fs.readFileSync(filename, 'utf8')))
        )
        return json(
          res,
          201,
          view(
            launch(
              job.result?.purpose === 'check'
                ? {
                    ...input,
                    singleRun: true,
                    stages: [{ durationSec: 86400, target: 1 }],
                    maxWorkers: 1,
                    evidence: { minResponses: 1, minLoadPercent: 0 },
                  }
                : input,
              job.id
            )
          )
        )
      }
      if (match[2] === 'cancel' && req.method === 'POST') {
        if (current?.job.id === job.id) current.runner?.stop()
        else if (job.status === 'scheduled') {
          job.status = 'cancelled'
          delete job.config
          save(job)
        }
        return json(res, 200, view(job))
      }
      if (match[2] === 'xlsx' && req.method === 'GET') {
        if (
          ['running', 'stopping', 'scheduled'].includes(job.status) ||
          job.result?.reportStatus === 'generating'
        )
          return json(res, 409, {
            error:
              'Relatório XLSX disponível após o encerramento e a geração do arquivo',
          })
        const filename = path.join(ROOT, `${job.id}.xlsx`),
          legacyFile = path.join(ROOT, `${job.id}.csv`)
        if (!fs.existsSync(filename) && fs.existsSync(legacyFile)) {
          if (current && ['running', 'stopping'].includes(current.job.status))
            return json(res, 409, {
              error:
                'Aguarde a execução ativa antes de converter este relatório antigo.',
            })
          if (!exportsInProgress.has(job.id)) {
            const conversion = generateReport({
              output: filename,
              events: legacyFile,
              legacy: true,
              metadata: {
                name: job.name,
                source: 'Versão anterior',
                result: job.result,
              },
            })
              .then(() => {
                job.result = { ...job.result, reportStatus: 'ready' }
                save(job)
              })
              .finally(() => exportsInProgress.delete(job.id))
            exportsInProgress.set(job.id, conversion)
          }
          await exportsInProgress.get(job.id)
        }
        if (!fs.existsSync(filename))
          return json(res, 404, {
            error:
              job.result?.reportError ||
              'Esta execução não possui relatório XLSX',
          })
        const name =
          job.name
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9_-]+/g, '-')
            .slice(0, 70) || 'teste'
        res.writeHead(200, {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="stress-lab-${name}-${job.id.slice(0, 8)}.xlsx"`,
        })
        fs.createReadStream(filename)
          .on('error', () => res.destroy())
          .pipe(res)
        return
      }
    }
    const files = {
      '/': 'index.html',
      '/app.js': 'app.js',
      '/style.css': 'style.css',
      '/flow-editor.js': 'flow-editor.js',
    }
    if (req.method === 'GET' && files[url.pathname]) {
      const ext = path.extname(files[url.pathname])
      res.writeHead(200, {
        'Content-Type': {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
        }[ext],
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
      })
      return fs
        .createReadStream(path.join(__dirname, 'public', files[url.pathname]))
        .pipe(res)
    }
    json(res, 404, { error: 'Não encontrado' })
  } catch (err) {
    json(res, err.statusCode || 400, {
      error: err.message,
      step: err.step,
      field: err.field,
      nodeId: err.nodeId,
      issues: err.issues,
    })
  }
})
server.listen(Number(process.env.PORT || 3000), '127.0.0.1', () =>
  console.log(`Stress Lab: http://127.0.0.1:${server.address().port}`)
)
async function shutdown() {
  clearInterval(scheduler)
  current?.runner?.stop()
  server.close()
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
