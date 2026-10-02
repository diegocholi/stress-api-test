const { test, expect } = require('@playwright/test')
const http = require('node:http')
let target,
  url,
  received = 0
test.beforeAll(async () => {
  target = http.createServer((req, res) => {
    received++
    res.setHeader('Content-Type', 'application/json')
    setTimeout(() => res.end(JSON.stringify({ ok: true })), 20)
  })
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${target.address().port}/health`
})
test.afterAll(async () => {
  target.closeAllConnections()
  await new Promise((resolve) => target.close(resolve))
})
async function configure(page, name = 'Health navegador') {
  await page.goto('/#configure')
  await page.locator('#flow-list').click()
  await page.locator('[name=name]').fill(name)
  await page.locator('[data-field=url]').fill(url)
  await page.getByRole('button', { name: '2 · Carga', exact: true }).click()
  await page.locator('#stages input').nth(0).fill('1')
  await page.locator('#stages input').nth(1).fill('1')
  await page.getByRole('button', { name: 'Remover estágio' }).last().click()
  await page
    .getByText('Timeouts e diagnóstico avançados', { exact: true })
    .click()
  await page.getByRole('button', { name: '3 · Critérios', exact: true }).click()
  await page.locator('[name=minResponses]').fill('1')
  await page.locator('[name=minLoadPercent]').fill('0')
  await expect(page.locator('#submit')).toBeEnabled({ timeout: 20000 })
  await page.getByRole('button', { name: '1 · Cenário', exact: true }).click()
}
test('validation sends no traffic, reports inline errors and supports duplicate collapsed steps', async ({
  page,
}) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await configure(page, 'Pré-validação')
  const before = received
  await page
    .getByRole('button', { name: 'Validar configuração', exact: true })
    .click()
  await expect(page.locator('#message')).toContainText('Configuração válida')
  expect(received).toBe(before)
  await page.locator('[data-field=url]').fill('{{MISSING}}/x')
  await page
    .getByRole('button', { name: 'Validar configuração', exact: true })
    .click()
  await expect(page.locator('.field-error')).toContainText(
    'variável não definida'
  )
  await expect(page.locator('[data-field=url]')).toBeFocused()
  await page.locator('[data-field=url]').fill(url)
  await page
    .getByRole('button', { name: 'Duplicar requisição', exact: true })
    .click()
  await expect(page.locator('.request-card')).toHaveCount(2)
  await page.locator('.request-card[open] .request-head').click()
  await expect(page.locator('.request-card').last()).not.toHaveAttribute(
    'open',
    ''
  )
  expect(errors).toEqual([])
})
test('simple rules survive repeated saves without creating additional rules', async ({
  page,
}) => {
  const name = 'Regras sem duplicação'
  page.on('dialog', (dialog) => dialog.accept())
  await configure(page, name)
  await page.locator('[data-field=contains]').fill('ok')
  await page.locator('[data-field=jsonPath]').fill('ok')
  await page.locator('[data-field=jsonValue]').fill('true')
  await page.locator('[data-field=extractPath]').fill('ok')
  await page.locator('[data-field=extractVariable]').fill('FLAG')
  const checks = page.locator('fieldset[data-field=checks] .flow-rule')
  const extracts = page.locator('fieldset[data-field=extracts] .flow-rule')
  const reloadSaved = async () => {
    await page.reload()
    await page.locator('#flow-list').click()
    await page.getByRole('link', { name: /Testes salvos/ }).click()
    await page
      .getByRole('button', { name: `Carregar ${name}`, exact: true })
      .click()
    await expect(page.locator('#message')).toContainText('Teste carregado')
  }
  const save = async (checkCount) => {
    const response = page.waitForResponse(
      (res) =>
        res.url().includes('/api/templates') &&
        res.request().method() === 'POST'
    )
    await page.locator('#save-test').click()
    const saved = await response
    expect(saved.ok()).toBe(true)
    const templates = await (await page.request.get('/api/templates')).json()
    const item = templates.find((t) => t.name === name)
    const detail = await (
      await page.request.get(`/api/templates/${item.id}`)
    ).json()
    expect(detail.definition.scenario.steps[0].checks).toHaveLength(checkCount)
    expect(detail.definition.scenario.steps[0].extracts).toHaveLength(1)
    return detail
  }
  for (let i = 0; i < 3; i++) {
    const detail = await save(3)
    if (i === 0) {
      // Reproduce duplicates persisted by the previous editor.
      const step = detail.definition.scenario.steps[0]
      step.checks.push(...structuredClone(step.checks))
      step.extracts.push(...structuredClone(step.extracts))
      const updated = await page.request.post(`/api/templates/${detail.id}`, {
        data: { ...detail.definition, revision: detail.revision },
      })
      expect(updated.ok()).toBe(true)
    }
    await reloadSaved()
    await expect(checks).toHaveCount(0)
    await expect(extracts).toHaveCount(0)
    await expect(page.locator('[data-field=expectedStatus]')).toHaveValue('200')
    await expect(page.locator('[data-field=contains]')).toHaveValue('ok')
    await expect(page.locator('[data-field=jsonPath]')).toHaveValue('ok')
    await expect(page.locator('[data-field=jsonValue]')).toHaveValue('true')
    await expect(page.locator('[data-field=extractVariable]')).toHaveValue(
      'FLAG'
    )
  }
  await page
    .getByRole('button', { name: 'Adicionar validação', exact: true })
    .click()
  await checks.locator('[data-field=path]').fill('ok')
  await page.locator('[data-field=expectedStatus]').fill('201')
  await save(4)
  await reloadSaved()
  await expect(checks).toHaveCount(1)
  await expect(checks.locator('[data-field=operator]')).toHaveValue('exists')
  await expect(page.locator('[data-field=expectedStatus]')).toHaveValue('201')
})
test('additional token extractions remain visible after saving and reloading', async ({
  page,
}) => {
  const name = 'Login com extrações adicionais'
  page.on('dialog', (dialog) => dialog.accept())
  await configure(page, name)
  const rules = [
    { source: 'json', path: 'data.token', variable: 'TOKEN', scope: 'journey' },
    {
      source: 'header',
      path: 'X-Session',
      variable: 'SESSION',
      scope: 'session',
      secret: true,
    },
  ]
  // Existing saved flows have canonical extractions without editor metadata.
  await page.evaluate((extracts) => {
    const flow = flowEditor.value()
    flow.steps[0].extracts = extracts
    flowEditor.load(flow)
  }, rules)
  for (let i = 0; i < 2; i++) {
    const rows = page.locator('fieldset[data-field=extracts] .flow-rule')
    await expect(rows).toHaveCount(2)
    await expect(rows.first().locator('[data-field=variable]')).toHaveValue(
      'TOKEN'
    )
    await expect(rows.first().locator('[data-field=path]')).toHaveValue(
      'data.token'
    )
    await expect(rows.last().locator('input[type=checkbox]')).toBeChecked()
    await expect(page.locator('[data-field=extractVariable]')).toHaveValue('')
    const response = page.waitForResponse(
      (res) =>
        res.url().includes('/api/templates') &&
        res.request().method() === 'POST'
    )
    await page.locator('#save-test').click()
    expect((await response).ok()).toBe(true)
    const templates = await (await page.request.get('/api/templates')).json()
    const item = templates.find((t) => t.name === name)
    const detail = await (
      await page.request.get(`/api/templates/${item.id}`)
    ).json()
    expect(detail.definition.scenario.steps[0].extracts).toEqual(rules)
    await page.reload()
    await page.locator('#flow-list').click()
    await page.getByRole('link', { name: /Testes salvos/ }).click()
    await page
      .getByRole('button', { name: `Carregar ${name}`, exact: true })
      .click()
    await expect(page.locator('#message')).toContainText('Teste carregado')
  }
  await expect(
    page.locator('fieldset[data-field=extracts] .flow-rule')
  ).toHaveCount(2)
})

test('saved configuration executes, exports XLSX and restores historical charts after reload', async ({
  page,
}) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await configure(page)
  await page.getByRole('button', { name: 'Salvar teste', exact: true }).click()
  await expect(page.locator('#message')).toContainText('Teste salvo')
  await page.locator('#new-test').click()
  await page.getByRole('link', { name: /Testes salvos/ }).click()
  await page
    .getByRole('button', { name: 'Carregar Health navegador', exact: true })
    .click()
  await expect(page.locator('[data-field=url]')).toHaveValue(url)
  await page
    .getByRole('button', { name: 'Iniciar teste de carga', exact: true })
    .click()
  await expect(page.locator('#status')).toHaveText('Aprovado', {
    timeout: 20000,
  })
  await expect(page.locator('#series-message')).toContainText(
    'janelas persistidas'
  )
  const readout = await page.locator('.chart-readout').first().textContent()
  await page.reload()
  await expect(page.locator('#status')).toHaveText('Aprovado')
  await expect(page.locator('.chart-readout').first()).toHaveText(readout)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({
    path: 'test-results/desktop-monitor.png',
    fullPage: true,
  })
  await page
    .getByRole('link', { name: 'Resultados', exact: true })
    .first()
    .click()
  await expect(page.locator('#result-verdict')).toContainText('Aprovado')
  await expect(page.locator('#criteria-table')).toContainText(
    'Respostas com latência'
  )
  const download = page.waitForEvent('download')
  await page.locator('#result-xlsx').click()
  expect((await download).suggestedFilename()).toMatch(/\.xlsx$/)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({
    path: 'test-results/desktop-results.png',
    fullPage: true,
  })
  await page.getByRole('link', { name: /Histórico e agenda/ }).click()
  await page.locator('#history-search').fill('não existe')
  await expect(page.locator('#history')).toContainText('Nenhuma execução')
  await page.locator('#history-search').fill('Health')
  await expect(page.locator('.history-row')).toHaveCount(1)
  expect(errors).toEqual([])
})
test('single execution is functional, repeat preserves it and comparison flags different definitions', async ({
  page,
}) => {
  await configure(page, 'Verificação navegador')
  await page
    .getByRole('button', { name: 'Executar uma vez', exact: true })
    .click()
  await expect(page.locator('#status')).toHaveText('Fluxo aprovado', {
    timeout: 20000,
  })
  await expect(page.locator('#run-info')).toContainText('Verificação funcional')
  await expect(page.locator('#repeat')).toBeEnabled({ timeout: 20000 })
  const repeated = page.waitForResponse(
    (res) => res.url().endsWith('/repeat') && res.request().method() === 'POST'
  )
  await page.locator('#repeat').click()
  const repeatResponse = await repeated
  expect(repeatResponse.status()).toBe(201)
  const next = await repeatResponse.json()
  await expect(page.locator('#monitor')).toHaveAttribute('data-run-id', next.id)
  await expect(page.locator('#status')).toHaveText('Fluxo aprovado', {
    timeout: 20000,
  })
  await page
    .getByRole('link', { name: 'Resultados', exact: true })
    .first()
    .click()
  await page.locator('#compare-baseline').selectOption({
    label: (
      await page.locator('#compare-baseline option').allTextContents()
    ).find((t) => t.startsWith('Health navegador')),
  })
  await page.locator('#compare-runs').click()
  await expect(page.locator('#comparison-note')).toContainText(
    'Comparação com ressalvas'
  )
  await expect(page.locator('#comparison-output')).toContainText('p95')
  await expect(page.locator('#comparison-xlsx')).toBeVisible()
  const exported = page.waitForEvent('download')
  await page.locator('#comparison-xlsx').click()
  expect((await exported).suggestedFilename()).toMatch(/comparacao.xlsx$/)
})
test('cancelled run remains partial and can export its collected evidence', async ({
  page,
}) => {
  await configure(page, 'Cancelamento navegador')
  await page.getByRole('button', { name: '2 · Carga', exact: true }).click()
  await page.locator('#stages input').nth(0).fill('10')
  await page
    .getByRole('button', { name: 'Iniciar teste de carga', exact: true })
    .click()
  await expect(page.locator('#cancel')).toBeVisible()
  await page.waitForTimeout(1100)
  await page.locator('#cancel').click()
  await expect(page.locator('#status')).toHaveText('Resultado parcial', {
    timeout: 20000,
  })
  await expect(page.locator('#xlsx')).toBeVisible()
})
test('mobile and zoomed layouts keep navigation, fields and evidence accessible', async ({
  page,
}) => {
  await configure(page, 'Layout')
  await page.evaluate(() => window.scrollTo(0, 700))
  expect(
    await page
      .locator('.sidebar')
      .evaluate((el) => el.getBoundingClientRect().top)
  ).toBe(76)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(
    page.getByRole('button', { name: 'Menu', exact: true })
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.evaluate(() => (document.body.style.zoom = '2'))
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  await expect(page.locator('#menu-toggle')).toBeVisible()
  await page.locator('#menu-toggle').click()
  await expect(
    page.getByRole('link', { name: /Histórico e agenda/ })
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await page.locator('[data-field=url]').focus()
  await expect(page.locator('[data-field=url]')).toBeFocused()
  await page.screenshot({ path: 'test-results/zoom.png', fullPage: true })
})
test('arrival ramps persist, show live throughput and distinguish actual starts from planned demand', async ({
  page,
}) => {
  await configure(page, 'Chegadas e throughput')
  await page.getByRole('button', { name: '2 · Carga', exact: true }).click()
  await page.locator('[name=loadModel]').selectOption('arrival')
  await page.locator('[name=warmupSec]').fill('1')
  await page.locator('#stages input').nth(0).fill('4')
  await page.locator('#stages input').nth(1).fill('8')
  await page.locator('[data-stage-profile]').selectOption('ramp')
  await page.locator('[data-stage-from]').fill('4')
  await page.getByRole('button', { name: 'Salvar teste', exact: true }).click()
  await expect(page.locator('#message')).toContainText('Teste salvo')
  await page
    .getByRole('button', { name: 'Iniciar teste de carga', exact: true })
    .click()
  await expect(page.locator('#metrics')).toContainText('Tentativas/s')
  await expect(page.locator('#metrics')).toContainText('Sucessos HTTP/s')
  await expect(page.locator('#metrics')).toContainText('Cenários/s')
  await expect(page.locator('#throughput-status')).toContainText(
    'Janela completa',
    { timeout: 10000 }
  )
  await expect(
    page.locator('#metrics .metric').first().locator('strong')
  ).not.toHaveText('Coletando', { timeout: 10000 })
  await expect(
    page.getByRole('heading', {
      name: 'Cenários iniciados/s e taxa alvo',
      exact: true,
    })
  ).toBeVisible()
  await expect(page.locator('#status')).toHaveText('Aprovado', {
    timeout: 20000,
  })
  await page
    .getByRole('link', { name: 'Resultados', exact: true })
    .first()
    .click()
  await expect(page.locator('#criteria-table')).toContainText('Estágio 1: p95')
  await page.getByRole('link', { name: /Testes salvos/ }).click()
  await page
    .getByRole('button', {
      name: 'Carregar Chegadas e throughput',
      exact: true,
    })
    .click()
  await page.getByRole('button', { name: '2 · Carga', exact: true }).click()
  await expect(page.locator('[name=loadModel]')).toHaveValue('arrival')
  await expect(page.locator('[data-stage-profile]')).toHaveValue('ramp')
  await expect(page.locator('[data-stage-from]')).toHaveValue('4')
})
test('visual editor creates a conditional loop, preserves undo and exports step metrics', async ({
  page,
}) => {
  await configure(page, 'Fluxo visual')
  await page.locator('[data-field=extractPath]').fill('ok')
  await page.locator('[data-field=extractVariable]').fill('FLAG')
  await page.locator('#flow-kind').selectOption('condition')
  await page.locator('#flow-add').click()
  await page.locator('[data-field=variable]').fill('FLAG')
  await page.locator('[data-field=operator]').selectOption('equals')
  await page.locator('[data-field=conditionValue]').fill('true')
  await page.locator('#flow-kind').selectOption('loop')
  await page
    .getByRole('button', { name: 'Adicionar ao se verdadeiro', exact: true })
    .click()
  await page.locator('[data-field=limit]').fill('2')
  await page.locator('#flow-kind').selectOption('request')
  await page
    .getByRole('button', { name: 'Adicionar ao passos internos', exact: true })
    .click()
  await page.locator('[data-field=url]').fill(url)
  await page.locator('[data-field=name]').fill('Detalhe')
  await page.locator('#flow-undo').click()
  await page.locator('#flow-redo').click()
  await expect(page.locator('[data-field=name]')).toHaveValue('Detalhe')
  await page.locator('#flow-graph').click()
  await expect(page.locator('#flow-canvas')).toBeVisible()
  await expect(page.locator('.flow-node')).toHaveCount(4)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({
    path: 'test-results/flow-editor.png',
    fullPage: true,
  })
  await page.locator('#save-test').click()
  await expect(page.locator('#message')).toContainText('Teste salvo')
  await page.locator('#check-once').click()
  await expect(page.locator('#status')).toHaveText('Fluxo aprovado', {
    timeout: 20000,
  })
  await page
    .getByRole('link', { name: 'Resultados', exact: true })
    .first()
    .click()
  await page
    .getByRole('button', { name: 'Jornada e passos', exact: true })
    .click()
  await expect(page.locator('#flow-results')).toContainText('Detalhe')
  await expect(page.locator('#flow-results')).toContainText('2 execuções')
})

test('primary navigation preserves the editor, handles history and falls back for unknown URLs', async ({
  page,
}) => {
  await page.goto('/')
  await page.locator('#flow-list').click()
  await expect(page.locator('.nav-link[aria-current="page"]')).toHaveText(
    /Configurar teste/
  )
  await expect(page.locator('.view-tabs')).toHaveCount(0)
  await page.locator('[name=name]').fill('Rascunho preservado')
  await page.getByRole('link', { name: /Testes salvos/ }).click()
  await expect(page.locator('#view-title')).toHaveText('Testes salvos')
  await page.goBack()
  await expect(page.locator('[name=name]')).toHaveValue('Rascunho preservado')
  await page.goForward()
  await expect(page.locator('#view-title')).toHaveText('Testes salvos')
  await page.goto('/#unknown')
  await expect(page.locator('#view-title')).toHaveText('Configurar teste')
  await expect(page.locator('.nav-link[aria-current="page"]')).toHaveCount(1)
})

test('creation controls preserve fields, validate review and align editor actions', async ({
  page,
}) => {
  await configure(page, 'Etapas')
  await expect(page.locator('#creation-prev')).toBeDisabled()
  const positions = await page.locator('.flow-add-controls').evaluate((el) => {
    const select = el.querySelector('select').getBoundingClientRect()
    const button = el.querySelector('#flow-add').getBoundingClientRect()
    return {
      selectBottom: select.bottom,
      buttonBottom: button.bottom,
      selectHeight: select.height,
      buttonHeight: button.height,
    }
  })
  expect(
    Math.abs(positions.selectBottom - positions.buttonBottom)
  ).toBeLessThanOrEqual(1)
  expect(positions.selectHeight).toBe(44)
  expect(positions.buttonHeight).toBe(44)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({
    path: 'test-results/desktop-configure.png',
    fullPage: true,
  })
  await page.locator('#creation-next').click()
  await expect(page.locator('#creation-progress')).toHaveText('Etapa 2 de 4')
  const stageBottoms = await page
    .locator('.stage')
    .first()
    .evaluate((el) =>
      [...el.children]
        .filter((control) => !control.hidden)
        .map((control) => control.getBoundingClientRect().bottom)
    )
  expect(
    Math.max(...stageBottoms) - Math.min(...stageBottoms)
  ).toBeLessThanOrEqual(1)
  await page.locator('#creation-next').click()
  await expect(page.locator('#creation-progress')).toHaveText('Etapa 3 de 4')
  const before = received
  await page.locator('#creation-next').click()
  await expect(page.locator('#creation-review')).toContainText(
    'Configuração validada sem tráfego'
  )
  expect(received).toBe(before)
  await expect(page.locator('#creation-next')).toBeHidden()
  await page.locator('#creation-prev').click()
  await page.getByRole('button', { name: '1 · Cenário', exact: true }).click()
  await expect(page.locator('[data-field=url]')).toHaveValue(url)
  await page.locator('[data-field=url]').fill('{{MISSING}}/x')
  await page.getByRole('button', { name: '4 · Revisão', exact: true }).click()
  await expect(page.locator('.field-error')).toContainText(
    'variável não definida'
  )
  await expect(page.locator('[data-field=url]')).toBeFocused()
})

test('mobile menu supports keyboard dismissal, selection and all destinations without overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.locator('#flow-list').click()
  const toggle = page.getByRole('button', { name: 'Menu', exact: true })
  await toggle.click()
  await expect(
    page.getByRole('dialog', { name: 'Navegação principal' })
  ).toBeVisible()
  await expect(page.locator('#menu-close')).toBeFocused()
  await page.screenshot({ path: 'test-results/mobile-menu.png' })
  await page.keyboard.press('Shift+Tab')
  await expect(
    page.getByRole('link', { name: /Histórico e agenda/ })
  ).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.locator('#menu-close')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(toggle).toBeFocused()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  for (const name of [
    'Acompanhamento',
    'Resultados',
    'Testes salvos',
    'Histórico e agenda',
    'Configurar teste',
  ]) {
    await toggle.click()
    await page.getByRole('link', { name: new RegExp(name) }).click()
    await expect(page.locator('#view-title')).toHaveText(name)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true)
  }
  await toggle.click()
  await page.locator('#menu-backdrop').click({ position: { x: 370, y: 100 } })
  await expect(toggle).toBeFocused()
  await page.setViewportSize({ width: 900, height: 900 })
  await expect(
    page.getByRole('link', { name: /Histórico e agenda/ })
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(toggle).toBeHidden()
})

test('dragged loop saves, reloads and executes the moved request twice', async ({
  page,
}) => {
  page.on('dialog', (dialog) => dialog.accept())
  const name = `Fluxograma com arraste ${test.info().repeatEachIndex}`
  await configure(page, name)
  const original = await page.evaluate(() => flowEditor.value().steps[0])
  await page.locator('#flow-graph').click()
  await page
    .locator('.flow-graph-tree > .flow-insert')
    .last()
    .getByRole('button')
    .click()
  await page.locator('[data-create-kind=loop]').click()
  await page.locator('[data-field=limit]').fill('2')
  await page
    .getByRole('button', { name: 'Fechar configurações', exact: true })
    .click()
  await expect(page.locator('.flow-config-dialog')).toHaveCount(0)
  await page.locator('[data-graph-fit]').click()
  await page.locator('#flow-canvas').scrollIntoViewIfNeeded()
  const start = await page
    .locator(`.flow-block[data-node-id="${original.id}"] .flow-drag-handle`)
    .boundingBox()
  const destination = await page
    .locator('.flow-block[data-kind=loop] .flow-branch > .flow-insert')
    .boundingBox()
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    destination.x + destination.width / 2,
    destination.y + destination.height / 2,
    { steps: 8 }
  )
  await page.mouse.up()
  await page.locator('#save-test').click()
  await expect(page.locator('#message')).toContainText('Teste salvo')
  await page.reload()
  await page.getByRole('link', { name: /Testes salvos/ }).click()
  await page
    .getByRole('button', { name: `Carregar ${name}`, exact: true })
    .click()
  await expect(page.locator('#message')).toContainText('Teste carregado')
  await expect(page.locator('#flow-graph')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.locator('.flow-config-dialog')).toHaveCount(0)
  const saved = await page.evaluate(() => flowEditor.value())
  expect(saved.steps).toHaveLength(1)
  expect(saved.steps[0].limit).toBe(2)
  expect(saved.steps[0].children[0].id).toBe(original.id)
  expect(saved.steps[0].children[0].url).toBe(original.url)
  const before = received
  const started = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/runs/check') &&
      response.request().method() === 'POST'
  )
  await page.locator('#check-once').click()
  const response = await started
  expect(response.ok()).toBe(true)
  const run = await response.json()
  // Await this run rather than a status label left over from an earlier test.
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${run.id}`)).json()).result
          ?.passed,
      { timeout: 20000 }
    )
    .toBe(true)
  await expect(page.locator('#status')).toHaveText('Fluxo aprovado', {
    timeout: 20000,
  })
  expect(received - before).toBe(2)
})
