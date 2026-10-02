const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const Excel = require('exceljs')
const yauzl = require('yauzl')
const { buildReport } = require('../lib/report/workbook')
const { generateReport } = require('../lib/report/run')
const { sanitizeUrl } = require('../lib/report/metrics')
async function zipContents(filename) {
  const zip = await new Promise((r, j) =>
    yauzl.open(filename, { lazyEntries: true }, (err, z) =>
      err ? j(err) : r(z)
    )
  )
  const entries = new Map()
  await new Promise((resolve, reject) => {
    zip.on('error', reject)
    zip.on('end', resolve)
    zip.on('entry', (entry) =>
      zip.openReadStream(entry, async (err, stream) => {
        if (err) {
          reject(err)
          return
        }
        try {
          const chunks = []
          for await (const c of stream) chunks.push(c)
          entries.set(entry.fileName, Buffer.concat(chunks).toString())
          zip.readEntry()
        } catch (e) {
          reject(e)
        }
      })
    )
    zip.readEntry()
  })
  return entries
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-xlsx-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const startedAt = Date.now() - 5000
  const rows = [
    {
      type: 'request',
      ts: startedAt + 300,
      startedAt: startedAt + 200,
      vu: 1,
      iter: 1,
      stage: 1,
      name: '=HYPERLINK("http://example.com")',
      method: 'GET',
      url: 'https://user:password@api.example.com/health?token=secret&x=1',
      route: 'https://api.example.com/health',
      code: 200,
      latency: 100,
      bytes: 20,
      failed: false,
      transport: false,
      message: '',
    },
    {
      type: 'request',
      ts: startedAt + 500,
      startedAt: startedAt + 400,
      vu: 1,
      iter: 2,
      stage: 1,
      name: 'Health',
      method: 'GET',
      url: 'https://api.example.com/health',
      route: 'https://api.example.com/health',
      code: 500,
      latency: 150,
      bytes: 40,
      failed: true,
      transport: false,
      message: '',
    },
    {
      type: 'request',
      ts: startedAt + 2200,
      startedAt: startedAt + 2000,
      vu: 2,
      iter: 1,
      stage: 2,
      name: 'Health',
      method: 'GET',
      url: 'https://api.example.com/health',
      route: 'https://api.example.com/health',
      code: 0,
      latency: null,
      bytes: null,
      failed: true,
      transport: true,
      message: 'ETIMEDOUT',
    },
    {
      type: 'validation',
      ts: startedAt + 350,
      vu: 1,
      iter: 1,
      name: 'Health',
      method: 'GET',
      url: 'https://api.example.com/health',
      assertion: 'Status 200',
      passed: true,
      message: '',
    },
    {
      type: 'validation',
      ts: startedAt + 550,
      vu: 1,
      iter: 2,
      name: 'Health',
      method: 'GET',
      url: 'https://api.example.com/health',
      assertion: 'Status 200',
      passed: false,
      message: 'expected 500 to equal 200',
    },
    {
      type: 'tick',
      ts: startedAt + 1000,
      active: 2,
      target: 2,
      rssMB: 100,
      eventLoopLagMs: 5,
    },
    {
      type: 'tick',
      ts: startedAt + 3000,
      active: 0,
      target: 0,
      rssMB: 105,
      eventLoopLagMs: 1,
    },
  ]
  const filename = path.join(dir, 'events.ndjson')
  fs.writeFileSync(
    filename,
    rows.map((e) => JSON.stringify(e)).join('\n') + '\n'
  )
  return {
    events: filename,
    output: path.join(dir, 'report.xlsx'),
    detailPageSize: 2,
    metadata: {
      name: 'Relatório detalhado',
      source: 'Interface',
      startedAt,
      endedAt: startedAt + 4000,
      stageHistory: [
        { startedAt, endedAt: startedAt + 2000 },
        { startedAt: startedAt + 2000, endedAt: startedAt + 3000 },
      ],
      config: {
        stages: [
          { durationSec: 2, target: 2 },
          { durationSec: 1, target: 1 },
        ],
        thresholds: { p95: 100, errorRate: 1 },
        timeout: 1000,
      },
      result: {
        status: 'completed',
        requests: 3,
        elapsed: 4,
        assertionFailures: 1,
        scriptFailures: 0,
        runFailures: 0,
        passed: false,
      },
    },
  }
}
test('XLSX contains styled summary, charts, exact metrics, split details and safe text cells', async (t) => {
  const options = fixture(t)
  const report = await buildReport(options)
  assert.equal(report.rows, 3)
  assert.equal(report.validationRows, 2)
  assert.equal(report.failureRows, 3)
  assert.equal(report.integrity, true)
  assert.equal(report.charts, 4)
  assert.equal(report.sheets, 13)
  const w = new Excel.Workbook()
  await w.xlsx.readFile(options.output)
  for (const name of [
    'Resumo',
    'Configuração',
    'Estágios',
    'Endpoints',
    'Evolução',
    'HTTP',
    'Usuários',
    'Validações 1',
    'Falhas 1',
    'Requisições 1',
    'Requisições 2',
    'Metodologia',
  ])
    assert.ok(w.getWorksheet(name), name)
  assert.equal(w.getWorksheet('Resumo').getCell('A9').value, 3)
  assert.equal(w.getWorksheet('Resumo').getCell('I9').value, 150)
  assert.equal(w.getWorksheet('Resumo').getCell('A13').value, 2 / 3)
  assert.equal(w.getWorksheet('Resumo').getCell('A4').value, 'REPROVADO')
  assert.equal(
    w.getWorksheet('Resumo').getCell('A1').fill.fgColor.argb,
    'FF162331'
  )
  const details = w.getWorksheet('Requisições 1')
  assert.equal(details.getCell('G7').value, '=HYPERLINK("http://example.com")')
  assert.equal(details.getCell('G7').type, Excel.ValueType.String)
  assert.ok(details.views[0].ySplit === 6)
  assert.ok(details.autoFilter)
  assert.equal(w.getWorksheet('Requisições 2').getCell('K7').value, null)
  assert.equal(
    w.getWorksheet('Falhas 2').getCell('K7').value,
    'expected 500 to equal 200'
  )
  const contents = await zipContents(options.output)
  assert.equal(
    [...contents.keys()].filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n))
      .length,
    4
  )
  assert.match(
    contents.get('xl/worksheets/sheet1.xml'),
    /drawing r:id="rIdCharts"/
  )
  assert.match(contents.get('xl/charts/chart2.xml'), /Evolução.*\$S\$7/)
  assert.ok(
    ![...contents.values()].some(
      (text) => text.includes('user:password@') || text.includes('token=secret')
    )
  )
  assert.equal(
    sanitizeUrl('https://u:p@test.local/x?token=secret'),
    'https://test.local/x?token=%5Boculto%5D'
  )
  assert.equal(
    sanitizeUrl('{{BASE_URL}}/x?token=secret'),
    '{{BASE_URL}}/x?token=%5Boculto%5D'
  )
})
test('cancelled and empty tests export partial results without fabricated percentiles', async (t) => {
  const options = fixture(t)
  fs.writeFileSync(options.events, '')
  options.metadata.result = {
    status: 'cancelled',
    requests: 0,
    elapsed: 1,
    passed: false,
  }
  await generateReport(options)
  const w = new Excel.Workbook()
  await w.xlsx.readFile(options.output)
  assert.equal(
    w.getWorksheet('Resumo').getCell('A4').value,
    'RESULTADO PARCIAL'
  )
  assert.equal(w.getWorksheet('Resumo').getCell('I9').value, null)
  assert.equal(w.getWorksheet('Requisições 1').rowCount, 6)
})
test('old CSV exports convert to XLSX with explicit missing-field information', async (t) => {
  const options = fixture(t)
  fs.writeFileSync(
    options.events,
    'timestamp,vu,iteration,status,latency_ms,failed\n1700000000000,1,1,200,12,false\n'
  )
  options.legacy = true
  options.metadata = {
    name: 'Teste antigo',
    result: { status: 'completed', requests: 1, elapsed: 1, passed: true },
  }
  await buildReport(options)
  const w = new Excel.Workbook()
  await w.xlsx.readFile(options.output)
  assert.equal(w.getWorksheet('Resumo').getCell('A9').value, 1)
  assert.equal(
    w.getWorksheet('Requisições 1').getCell('G7').value,
    'Não registrado (versão anterior)'
  )
})

test('versioned reports identify missing validation records as partial even if HTTP counts match', async (t) => {
  const options = fixture(t)
  options.metadata.schemaVersion = 2
  options.metadata.methodologyVersion = '2.0'
  options.metadata.config.evidence = { minResponses: 1, minLoadPercent: 0 }
  options.metadata.result = { ...options.metadata.result, assertions: 3 }
  const info = await buildReport(options)
  assert.equal(info.integrity, false)
  assert.equal(info.evaluation.verdict, 'partial')
  const w = new Excel.Workbook()
  await w.xlsx.readFile(options.output)
  assert.equal(
    w.getWorksheet('Resumo').getCell('A4').value,
    'RESULTADO PARCIAL'
  )
  assert.ok(
    w
      .getWorksheet('Integridade')
      .getSheetValues()
      .some((row) => row?.includes('DIVERGE'))
  )
})

test('a truncated event exports a partial workbook with an explicit integrity failure', async (t) => {
  const options = fixture(t)
  options.metadata.schemaVersion = 2
  options.metadata.config.evidence = { minResponses: 1, minLoadPercent: 0 }
  fs.appendFileSync(options.events, '{"type":"request"')
  const result = await buildReport(options)
  assert.equal(result.invalidRecords, 1)
  assert.equal(result.integrity, false)
  assert.equal(result.evaluation.verdict, 'partial')
  const w = new Excel.Workbook()
  await w.xlsx.readFile(options.output)
  assert.equal(
    w.getWorksheet('Resumo').getCell('A4').value,
    'RESULTADO PARCIAL'
  )
})
